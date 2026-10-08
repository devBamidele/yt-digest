// Always-on Telegram receiver (Cloudflare Worker).
// Telegram POSTs every message and button tap here (a webhook) the moment it happens, and the
// worker replies right away. It runs onboarding for invited users (Google sign-in at /oauth/*),
// commands and settings, saves votes and requests to D1, serves per-user data to the daily run
// (/api/*), and every hour starts the GitHub run for whoever is due.
import { parseRequests } from "../src/request.ts";
import { handleApi } from "./api.ts";
import * as db from "./db.ts";
import { authUrl, exchangeCode, mySubscriptions, randomToken, SubsError, verifyConnect } from "./google.ts";
import { handleCommand, handleSettingInput, handleSettingsCallback } from "./commands.ts";
import { handleOnboarding, importCsvDocument, importedFromGoogle, prompt, type OnboardingCtx } from "./onboarding.ts";
import { fmtTime, friendlyTime, localClock, nextDigest, nextOccurrence } from "./time.ts";

interface Env {
  DB: db.D1;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string; // the owner's chat
  GOOGLE_WEB_CLIENT_ID: string;
  GOOGLE_WEB_CLIENT_SECRET: string;
  YOUTUBE_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  WEBHOOK_SECRET: string; // Telegram sends it back in a header, so only Telegram can post updates
  EVENTS_TOKEN: string; // the GitHub run's key for /api
  AI_MODEL: string;
  GITHUB_REPO: string; // owner/name
  BOT_USERNAME: string; // for invite links
  GH_DISPATCH_TOKEN: string; // fine-grained token: Actions read & write on this repo only
}

async function telegram(env: Env, method: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) console.log(`telegram ${method} failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

/** "tonight around 6pm" before the digest, "tomorrow around 6pm" after it, vaguer in between. */
export function whenNext(now = new Date(), timezone = "Africa/Lagos", hour = 18, minute = 0): string {
  const [h, m] = now.toLocaleTimeString("en-GB", { timeZone: timezone, hour12: false }).split(":").map(Number);
  const minutes = h * 60 + m;
  const target = hour * 60 + minute;
  const at = friendlyTime(hour, minute);
  const today = hour >= 17 ? "tonight" : "today";
  if (minutes < target - 30) return `${today} around ${at}`;
  if (minutes >= target + 45) return `tomorrow around ${at}`;
  return "in your next digest";
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function replyToMessage(env: Env, chat_id: string, text: string, at: string, when = whenNext()) {
  let reply: string;
  try {
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    const r = await parseRequests([{ text, at }], env.AI_MODEL);
    if (r.skip_today) reply = `👌 Okay, no digest ${when.startsWith("tomorrow") ? "tomorrow" : "today"}.`;
    else if (r.summary) reply = `Got it: <b>${escape(r.summary)}</b>.\nYou'll get it ${when}.`;
    else
      reply =
        "👋 Noted. To change your next digest, tell me the time, the mix or topics, e.g. <i>“45 min, only shorts, something funny”</i>.";
  } catch (e) {
    console.log(`parse failed: ${(e as Error).message}`);
    reply = `✅ Got it. I'll use this ${when}.`;
  }
  await telegram(env, "sendMessage", { chat_id, text: reply, parse_mode: "HTML" });
}

function onboardingCtx(env: Env, origin: string): OnboardingCtx {
  return {
    db: env.DB,
    tg: (method, payload) => telegram(env, method, payload),
    origin,
    secret: env.WEBHOOK_SECRET,
    youtubeApiKey: env.YOUTUBE_API_KEY,
    botToken: env.TELEGRAM_BOT_TOKEN,
  };
}

const INVITE_ONLY = "👋 This bot is invite-only. If someone sent you an invite link, open it to get started.";

/** Votes, commands, settings and requests from someone who has finished setup. */
async function handleActive(env: Env, user: db.User, update: any, ctx: OnboardingCtx) {
  const q = update.callback_query;
  if (q) {
    const data = String(q.data ?? "");
    if (data.startsWith("set|") || data.startsWith("del|")) {
      await telegram(env, "answerCallbackQuery", { callback_query_id: q.id });
      await handleSettingsCallback(ctx, user, data);
      return;
    }
    const [v, videoId, channelId] = data.split("|");
    if ((v === "u" || v === "d") && videoId && channelId) {
      await db.recordVote(env.DB, user.chat_id, videoId, channelId, v === "u" ? "up" : "down");
      await telegram(env, "answerCallbackQuery", { callback_query_id: q.id, text: v === "u" ? "👍 Noted: more like this" : "👎 Noted: less like this" });
    } else {
      await telegram(env, "answerCallbackQuery", { callback_query_id: q.id });
    }
    return;
  }
  const m = update.message;
  if (m?.document && user.step === "sync") return importCsvDocument(ctx, user.chat_id, m.document);
  if (typeof m?.text !== "string") return;
  if (m.text.startsWith("/")) {
    if (!(await handleCommand(ctx, user, m.text, env.BOT_USERNAME))) {
      await telegram(env, "sendMessage", { chat_id: user.chat_id, text: "I don't know that command. Try /help." });
    }
    return;
  }
  if (user.step.startsWith("set_") && (await handleSettingInput(ctx, user, m.text))) return;
  const at = new Date(m.date * 1000).toISOString();
  await db.addRequest(env.DB, user.chat_id, m.text, at);
  await handleRequest(env, user, m.text, at);
}

/** Reads a request right away: applies delivery-time changes and says exactly what will happen. */
async function handleRequest(env: Env, user: db.User, text: string, at: string) {
  const chat_id = user.chat_id;
  const now = new Date();
  const local = localClock(now, user.timezone);
  const localNow = `${local.date} ${fmtTime(Math.floor(local.minutes / 60), local.minutes % 60)} (${user.timezone}); usual digest time ${fmtTime(user.delivery_hour, user.delivery_minute)}`;
  let reply: string;
  try {
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    const r = await parseRequests([{ text, at }], env.AI_MODEL, { localNow });
    let u = user;
    const lines: string[] = [];
    if (r.daily_time) {
      const [h, mi] = r.daily_time.split(":").map(Number);
      await db.updateUser(env.DB, chat_id, { delivery_hour: h, delivery_minute: mi - (mi % 5) });
      u = { ...u, delivery_hour: h, delivery_minute: mi - (mi % 5) };
      lines.push(`Your everyday time is now <b>${fmtTime(h, mi - (mi % 5))}</b>.`);
    }
    if (r.deliver_at) {
      const when = r.deliver_at === "now" ? now : nextOccurrence({ hour: Number(r.deliver_at.slice(0, 2)), minute: Number(r.deliver_at.slice(3)) }, user.timezone, now);
      await db.updateUser(env.DB, chat_id, { next_digest_at: when.toISOString() });
      u = { ...u, next_digest_at: when.toISOString() };
    }
    if (r.skip_today) reply = `👌 Okay, I'll skip your next digest.`;
    else if (r.summary || r.daily_time || r.deliver_at) {
      reply = [`✅ Got it${r.summary ? `: <b>${escape(r.summary)}</b>` : ""}.`, ...lines, `Your next digest arrives ${nextDigest(u)}.`].join("\n");
    } else {
      reply = "👋 Noted. To change your next digest, tell me the time, the mix or topics, e.g. <i>“45 min, only shorts, something funny, at 9pm”</i>.";
    }
  } catch (e) {
    console.log(`request parse failed: ${(e as Error).message}`);
    reply = `✅ Got it. I'll use this for your next digest (${nextDigest(user)}).`;
  }
  await telegram(env, "sendMessage", { chat_id, text: reply, parse_mode: "HTML" });
}

async function handleUpdate(env: Env, update: any, origin: string) {
  const chat = String(update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? "");
  if (!chat || (update.message && update.message.chat?.type !== "private")) return; // private chats only
  const isOwner = chat === env.TELEGRAM_CHAT_ID;
  const ctx = onboardingCtx(env, origin);
  const user = await db.getUser(env.DB, chat);
  const text: string = update.message?.text ?? "";

  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1];
    if (user) {
      if (user.status === "onboarding") return prompt(ctx, user);
      return void (await handleCommand(ctx, user, "/help", env.BOT_USERNAME));
    }
    const allowed = (code && (await db.redeemInvite(env.DB, code, chat))) || isOwner;
    if (!allowed) return void (await telegram(env, "sendMessage", { chat_id: chat, text: INVITE_ONLY }));
    const name = String(update.message.from?.first_name ?? "");
    const created = await db.createUser(env.DB, chat, name, isOwner);
    await telegram(env, "sendMessage", {
      chat_id: chat,
      parse_mode: "HTML",
      text: `👋 <b>Welcome${name ? `, ${escape(name)}` : ""}!</b>\n\nEvery day I'll send you the best new videos from the channels you follow, fitted to the time you have, with a short summary of each. Setup takes about 2 minutes.`,
    });
    return prompt(ctx, created);
  }

  if (!user) {
    if (update.message) await telegram(env, "sendMessage", { chat_id: chat, text: isOwner ? "👋 Send /start to set up." : INVITE_ONLY });
    return;
  }
  if (user.status === "onboarding") return handleOnboarding(ctx, user, update);
  return handleActive(env, user, update, ctx);
}

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center;line-height:1.5">` +
      `<h2>${title}</h2><p>${body}</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

/** /oauth/start: from the signed "Connect YouTube" button to Google's sign-in page. */
async function oauthStart(env: Env, url: URL): Promise<Response> {
  const chatId = url.searchParams.get("u") ?? "";
  if (!(await verifyConnect(chatId, url.searchParams.get("sig") ?? "", env.WEBHOOK_SECRET))) return page("Link not valid", "Open the Connect YouTube button from the bot again.", 403);
  const user = await db.getUser(env.DB, chatId);
  if (!user || (user.step !== "connect" && user.step !== "sync")) return page("Already connected", "You can close this tab and go back to Telegram.");
  const state = randomToken(24);
  const verifier = randomToken(48);
  await db.putOAuthState(env.DB, state, chatId, verifier);
  return Response.redirect(await authUrl(env.GOOGLE_WEB_CLIENT_ID, `${url.origin}/oauth/callback`, state, verifier), 302);
}

/**
 * /oauth/callback: Google sends the person back here. Browsers often load this page twice (the first
 * load cancelled), so the browser gets an answer straight away and the import runs in the background,
 * where a cancelled load can't cut it off. Only the load that claims the one-time state does the work.
 */
function oauthCallback(env: Env, url: URL, ctx: { waitUntil(p: Promise<unknown>): void }): Response {
  ctx.waitUntil(
    importSubscriptions(env, url).catch((e) => console.log(`oauth import failed: ${(e as Error).stack ?? e}`)),
  );
  if (url.searchParams.get("error")) return page("Sign-in cancelled", "You can close this tab and go back to Telegram.");
  return page("✅ Signed in", "Go back to Telegram: I'll confirm your channels there in a few seconds.");
}

async function importSubscriptions(env: Env, url: URL): Promise<void> {
  const saved = await db.takeOAuthState(env.DB, url.searchParams.get("state") ?? "");
  if (!saved) {
    console.log("oauth callback: state already used or expired (duplicate load)");
    return;
  }
  const chat_id = saved.chat_id;
  if (url.searchParams.get("error")) {
    await telegram(env, "sendMessage", { chat_id, text: "Google sign-in was cancelled. Tap Connect YouTube to try again, or use one of the other options." });
    return;
  }
  try {
    const token = await exchangeCode({
      code: url.searchParams.get("code") ?? "",
      verifier: saved.verifier,
      clientId: env.GOOGLE_WEB_CLIENT_ID,
      clientSecret: env.GOOGLE_WEB_CLIENT_SECRET,
      redirectUri: `${url.origin}/oauth/callback`,
    });
    const subs = await mySubscriptions(token);
    await importedFromGoogle(onboardingCtx(env, url.origin), chat_id, subs);
  } catch (e) {
    console.log(`oauth import error: ${(e as Error).message}`);
    const msg = e instanceof SubsError ? e.message : "Something went wrong talking to Google.";
    await telegram(env, "sendMessage", { chat_id, text: `${msg} Try Connect YouTube again, or send your Takeout file instead.` });
  }
}

/** Cron (every 5 minutes): if anyone's delivery time has come, start the GitHub run for that exact moment. */
export async function hourly(env: Env, scheduledTime: number): Promise<string> {
  const at = new Date(scheduledTime);
  const due = await db.dueUsers(env.DB, at);
  if (!due.length) return "nobody due";
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/users.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "yt-digest-bot",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main", inputs: { at: at.toISOString() } }),
  });
  if (!res.ok) throw new Error(`GitHub dispatch failed: ${res.status} ${await res.text()}`);
  return `started run for ${due.length} user(s)`;
}

export default {
  async scheduled(event: { scheduledTime: number }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(
      hourly(env, event.scheduledTime).then(
        (r) => console.log(`hourly: ${r}`),
        async (e) => {
          console.log(`hourly failed: ${e}`);
          // Don't fail silently: tell the owner, at most once an hour.
          if (await db.claimAlert(env.DB, "dispatch", 55)) {
            await telegram(env, "sendMessage", {
              chat_id: env.TELEGRAM_CHAT_ID,
              text: `⚠️ Couldn't start digest runs: ${String((e as Error).message ?? e).slice(0, 300)}`,
            });
          }
        },
      ),
    );
  },

  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = (await request.json()) as any;
      if (typeof update?.update_id !== "number") return new Response("bad update", { status: 400 });
      // Answer Telegram at once; the reply (which may call Claude) runs after the response.
      ctx.waitUntil(handleUpdate(env, update, url.origin).catch((e) => console.log(`handle failed: ${e}`)));
      return new Response("ok");
    }

    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    if (request.method === "GET" && url.pathname === "/oauth/start") return oauthStart(env, url);
    if (request.method === "GET" && url.pathname === "/oauth/callback") return oauthCallback(env, url, ctx);

    return new Response("yt-digest bot", { status: 200 });
  },
};
