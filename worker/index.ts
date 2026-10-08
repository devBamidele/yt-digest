// Always-on Telegram receiver (Cloudflare Worker).
// Telegram POSTs every message and button tap here (a webhook) the moment it happens. The worker
// stores each update for 30 days and replies right away. It also runs onboarding for invited
// users (with Google sign-in at /oauth/*) and serves per-user data to the daily run (/api/*).
import { parseRequests } from "../src/request.ts";
import { handleApi } from "./api.ts";
import * as db from "./db.ts";
import { authUrl, exchangeCode, mySubscriptions, randomToken, SubsError, verifyConnect } from "./google.ts";
import { handleOnboarding, importedFromGoogle, prompt, type OnboardingCtx } from "./onboarding.ts";

interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

interface Env {
  EVENTS: KV;
  DB: db.D1;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string; // the owner's chat
  GOOGLE_WEB_CLIENT_ID: string;
  GOOGLE_WEB_CLIENT_SECRET: string;
  YOUTUBE_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  WEBHOOK_SECRET: string; // Telegram sends it back in a header, so only Telegram can post updates
  EVENTS_TOKEN: string; // the GitHub run's key for reading stored updates
  AI_MODEL: string;
  GITHUB_REPO: string; // owner/name
  GH_DISPATCH_TOKEN: string; // fine-grained token: Actions read & write on this repo only
}

const KEEP_SECONDS = 30 * 24 * 3600;
const key = (updateId: number) => `u:${String(updateId).padStart(12, "0")}`;

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

const hourLabel = (h: number) => (h === 12 ? "12pm" : h === 0 ? "midnight" : h < 12 ? `${h}am` : `${h - 12}pm`);

/** "tonight around 6pm" before the digest, "tomorrow around 6pm" after it, vaguer in between. */
export function whenNext(now = new Date(), timezone = "Africa/Lagos", hour = 18): string {
  const [h, m] = now.toLocaleTimeString("en-GB", { timeZone: timezone, hour12: false }).split(":").map(Number);
  const minutes = h * 60 + m;
  const at = hourLabel(hour);
  const today = hour >= 17 ? "tonight" : "today";
  if (minutes < hour * 60 - 30) return `${today} around ${at}`;
  if (minutes >= hour * 60 + 45) return `tomorrow around ${at}`;
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

/** Votes and requests from someone who has finished setup. */
async function handleActive(env: Env, user: db.User, update: any) {
  const q = update.callback_query;
  if (q) {
    const [v, videoId, channelId] = String(q.data ?? "").split("|");
    if ((v === "u" || v === "d") && videoId && channelId) {
      await db.recordVote(env.DB, user.chat_id, videoId, channelId, v === "u" ? "up" : "down");
      await telegram(env, "answerCallbackQuery", { callback_query_id: q.id, text: v === "u" ? "👍 Noted: more like this" : "👎 Noted: less like this" });
    } else {
      await telegram(env, "answerCallbackQuery", { callback_query_id: q.id });
    }
    return;
  }
  const m = update.message;
  if (typeof m?.text !== "string" || m.text.startsWith("/")) return; // commands come in step 5
  const at = new Date(m.date * 1000).toISOString();
  await db.addRequest(env.DB, user.chat_id, m.text, at);
  await replyToMessage(env, user.chat_id, m.text, at, whenNext(new Date(), user.timezone, user.delivery_hour));
}

/** The owner's chat before they've onboarded in v3: works exactly as v2 did. */
async function handleLegacyOwner(env: Env, update: any) {
  const q = update.callback_query;
  if (q) {
    const vote = String(q.data ?? "").startsWith("u|") ? "👍 Noted: more like this" : "👎 Noted: less like this";
    await telegram(env, "answerCallbackQuery", { callback_query_id: q.id, text: vote });
    return;
  }
  const m = update.message;
  if (typeof m?.text !== "string" || m.text.startsWith("/")) return;
  await replyToMessage(env, env.TELEGRAM_CHAT_ID, m.text, new Date(m.date * 1000).toISOString());
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
      return void (await telegram(env, "sendMessage", { chat_id: chat, text: "👋 You're all set up. Message me to change a day, or use /settings." }));
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
    if (isOwner) return handleLegacyOwner(env, update);
    if (update.message) await telegram(env, "sendMessage", { chat_id: chat, text: INVITE_ONLY });
    return;
  }
  if (user.status === "onboarding") return handleOnboarding(ctx, user, update);
  return handleActive(env, user, update);
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
  if (!user || user.step !== "connect") return page("Already connected", "You can close this tab and go back to Telegram.");
  const state = randomToken(24);
  const verifier = randomToken(48);
  await db.putOAuthState(env.DB, state, chatId, verifier);
  return Response.redirect(await authUrl(env.GOOGLE_WEB_CLIENT_ID, `${url.origin}/oauth/callback`, state, verifier), 302);
}

/** /oauth/callback: Google sends the person back here; read their subscriptions once and continue in Telegram. */
async function oauthCallback(env: Env, url: URL): Promise<Response> {
  const saved = await db.takeOAuthState(env.DB, url.searchParams.get("state") ?? "");
  if (!saved) return page("Link expired", "Tap Connect YouTube in the bot again.", 400);
  const chat_id = saved.chat_id;
  if (url.searchParams.get("error")) {
    await telegram(env, "sendMessage", { chat_id, text: "Google sign-in was cancelled. Tap Connect YouTube to try again, or use one of the other options." });
    return page("Sign-in cancelled", "You can close this tab and go back to Telegram.");
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
    return page(`✅ Found ${subs.length} channels`, "All done here. Go back to Telegram to finish setting up.");
  } catch (e) {
    const msg = e instanceof SubsError ? e.message : "Something went wrong talking to Google.";
    await telegram(env, "sendMessage", { chat_id, text: `${msg} Try Connect YouTube again, or send your Takeout file instead.` });
    return page("Couldn't read your subscriptions", `${escape(msg)} Go back to Telegram for other options.`, 502);
  }
}

/** Stored updates with update_id ≥ `after`, oldest first. */
async function listUpdates(env: Env, after: number) {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.EVENTS.list({ prefix: "u:", cursor });
    names.push(...page.keys.map((k) => k.name).filter((n) => n >= key(after)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  names.sort();
  const values = await Promise.all(names.map((n) => env.EVENTS.get(n)));
  return values.filter((v): v is string => v !== null).map((v) => JSON.parse(v));
}

/** Hourly cron: if anyone's delivery hour has come, start the GitHub run for that exact moment. */
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
    ctx.waitUntil(hourly(env, event.scheduledTime).then((r) => console.log(`hourly: ${r}`), (e) => console.log(`hourly failed: ${e}`)));
  },

  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = (await request.json()) as any;
      if (typeof update?.update_id !== "number") return new Response("bad update", { status: 400 });
      await env.EVENTS.put(key(update.update_id), JSON.stringify(update), { expirationTtl: KEEP_SECONDS });
      // Answer Telegram at once; the reply (which may call Claude) runs after the response.
      ctx.waitUntil(handleUpdate(env, update, url.origin).catch((e) => console.log(`handle failed: ${e}`)));
      return new Response("ok");
    }

    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    if (request.method === "GET" && url.pathname === "/oauth/start") return oauthStart(env, url);
    if (request.method === "GET" && url.pathname === "/oauth/callback") return oauthCallback(env, url);

    if (request.method === "GET" && url.pathname === "/events") {
      if (request.headers.get("Authorization") !== `Bearer ${env.EVENTS_TOKEN}`) {
        return new Response("forbidden", { status: 403 });
      }
      const after = Number(url.searchParams.get("after") ?? 0);
      return Response.json({ ok: true, result: await listUpdates(env, Number.isFinite(after) ? after : 0) });
    }

    return new Response("yt-digest bot", { status: 200 });
  },
};
