// Always-on Telegram receiver (Cloudflare Worker).
// Telegram POSTs every message and button tap here (a webhook) the moment it happens, and the
// worker replies right away. It runs onboarding for invited users (Google sign-in at /oauth/*),
// commands and settings, saves votes and requests to D1, serves per-user data to the daily run
// (/api/*), and every 5 minutes starts the GitHub run for whoever is due.
import { CREDIT_ALERT, isCreditError } from "../src/claude.ts";
import { parseRequests } from "../src/request.ts";
import { handleApi } from "./api.ts";
import * as db from "./db.ts";
import { authUrl, exchangeCode, mySubscriptions, randomToken, SubsError, verifyConnect } from "./google.ts";
import { handleCommand, handleSettingInput, handleSettingsCallback } from "./commands.ts";
import { handleOnboarding, importCsvDocument, importedFromGoogle, prompt, type OnboardingCtx } from "./onboarding.ts";
import { cooldownEnds, countdown, fmtTime, localClock, nextDigest, nextDigestTime, nextOccurrence } from "./time.ts";
import { refreshAll, refreshStatus } from "./status.ts";

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

/** Telegram message to the owner, at most once an hour per key. True if it was sent. */
async function alertOwner(env: Env, key: string, text: string): Promise<boolean> {
  if (!(await db.claimAlert(env.DB, key, 55))) return false;
  await telegram(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text });
  return true;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
  await handleRequest(env, user, m.text, new Date(m.date * 1000).toISOString());
}

/**
 * Reads a message right away. Time changes (one-off or everyday) are applied now; content changes
 * (watch time, mix, topics, skip) are stored for the next digest; questions are just answered.
 * Every reply ends with exactly when the next digest arrives.
 */
async function handleRequest(env: Env, user: db.User, text: string, at: string) {
  const chat_id = user.chat_id;
  const now = new Date();
  const local = localClock(now, user.timezone);
  const localNow = `${local.date} ${fmtTime(Math.floor(local.minutes / 60), local.minutes % 60)} (${user.timezone}); usual digest time ${fmtTime(user.delivery_hour, user.delivery_minute)}`;
  const lines: string[] = [];
  let u = user;
  try {
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    const r = await parseRequests([{ text, at }], env.AI_MODEL, { localNow });
    const changesContent = r.budget_minutes > 0 || r.shorts_share >= 0 || r.avoid.length > 0 || r.prefer.length > 0 || r.skip_today;
    if (changesContent) await db.addRequest(env.DB, chat_id, text, at); // the digest run reads these

    if (r.skip_today) lines.push("👌 Okay, I'll skip your next digest.");
    if (r.daily_time) {
      const [h, mi] = r.daily_time.split(":").map(Number);
      const m5 = mi - (mi % 5);
      await db.updateUser(env.DB, chat_id, { delivery_hour: h, delivery_minute: m5 });
      u = { ...u, delivery_hour: h, delivery_minute: m5 };
      lines.push(`✅ Your everyday time is now <b>${fmtTime(h, m5)}</b>.`);
    }
    if (r.deliver_at) {
      const when = r.deliver_at === "now" ? now : nextOccurrence({ hour: Number(r.deliver_at.slice(0, 2)), minute: Number(r.deliver_at.slice(3)) }, user.timezone, now);
      const ends = cooldownEnds(u);
      if (ends && when < ends) {
        // One digest a day: a one-off inside the cooldown isn't scheduled.
        lines.push(`⏳ You get one digest a day, so I can't send one ${r.deliver_at === "now" ? "now" : "at that time"}.`);
      } else {
        await db.updateUser(env.DB, chat_id, { next_digest_at: when.toISOString() });
        u = { ...u, next_digest_at: when.toISOString() };
        lines.push("✅ Got it.");
      }
    }
    if (changesContent && !r.skip_today && r.summary) lines.push(`✅ For your next digest: <b>${escape(r.summary)}</b>.`);
    if (!lines.length) lines.push("Tell me a time, the mix or topics to change it, e.g. <i>“45 min, only shorts, something funny, at 9pm”</i>.");
  } catch (e) {
    console.log(`request parse failed: ${(e as Error).message}`);
    if (isCreditError(e)) await alertOwner(env, "credit", `${CREDIT_ALERT}\n\n${(e as Error).message.slice(0, 300)}`);
    await db.addRequest(env.DB, chat_id, text, at); // can't tell what it was: the digest run tries again
    lines.push("⚠️ I couldn't read that just now, so nothing has changed yet. I'll try again when I build your next digest; if it was about the time, please send it again later.");
  }
  const next = nextDigestTime(u, now);
  lines.push(next ? `📺 Next digest: ${nextDigest(u, now)} (${countdown(next, now)}).` : "⏸ Digests are paused. Send /resume to restart.");
  await telegram(env, "sendMessage", { chat_id, text: lines.join("\n"), parse_mode: "HTML" });
  const fresh = await db.getUser(env.DB, chat_id);
  if (fresh) await refreshStatus(env.DB, (m, p) => telegram(env, m, p), fresh);
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
export async function checkDue(env: Env, scheduledTime: number): Promise<string> {
  const at = new Date(scheduledTime);
  await db.setState(env.DB, "last_check", at.toISOString()); // heartbeat: proves the schedule is running
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
    // Keep everyone's pinned "next digest" countdown current.
    ctx.waitUntil(
      refreshAll(env.DB, (m, p) => telegram(env, m, p), new Date(event.scheduledTime)).catch((e) => console.log(`status refresh failed: ${e}`)),
    );
    ctx.waitUntil(
      checkDue(env, event.scheduledTime).then(
        (r) => console.log(`checkDue: ${r}`),
        async (e) => {
          console.log(`checkDue failed: ${e}`);
          // Don't fail silently: tell the owner, at most once an hour.
          await alertOwner(env, "dispatch", `⚠️ Couldn't start digest runs: ${String((e as Error).message ?? e).slice(0, 300)}`);
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

    if (url.pathname.startsWith("/api/")) return handleApi(request, env, (key, text) => alertOwner(env, key, text));
    if (request.method === "GET" && url.pathname === "/oauth/start") return oauthStart(env, url);
    if (request.method === "GET" && url.pathname === "/oauth/callback") return oauthCallback(env, url, ctx);

    return new Response("yt-digest bot", { status: 200 });
  },
};
