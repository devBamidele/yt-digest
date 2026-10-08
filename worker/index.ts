// Always-on Telegram receiver (Cloudflare Worker).
// Telegram POSTs every message and button tap here (a webhook) the moment it happens. The worker
// stores each update for 30 days, replies right away, and serves the stored updates to the daily
// GitHub run, which then processes them exactly as it used to process getUpdates.
import { parseRequests } from "../src/request.ts";
import { handleApi } from "./api.ts";
import type { D1 } from "./db.ts";

interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

interface Env {
  EVENTS: KV;
  DB: D1;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ANTHROPIC_API_KEY: string;
  WEBHOOK_SECRET: string; // Telegram sends it back in a header, so only Telegram can post updates
  EVENTS_TOKEN: string; // the GitHub run's key for reading stored updates
  AI_MODEL: string;
}

const KEEP_SECONDS = 30 * 24 * 3600;
const key = (updateId: number) => `u:${String(updateId).padStart(12, "0")}`;

async function telegram(env: Env, method: string, payload: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.log(`telegram ${method} failed: ${res.status} ${await res.text()}`);
}

/** "tonight around 6pm" before the digest, "tomorrow around 6pm" after it, vaguer in between. */
export function whenNext(now = new Date()): string {
  const [h, m] = now.toLocaleTimeString("en-GB", { timeZone: "Africa/Lagos", hour12: false }).split(":").map(Number);
  const minutes = h * 60 + m;
  if (minutes < 17 * 60 + 30) return "tonight around 6pm";
  if (minutes >= 18 * 60 + 45) return "tomorrow around 6pm";
  return "in your next digest";
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function replyToMessage(env: Env, text: string, at: string) {
  const chat_id = env.TELEGRAM_CHAT_ID;
  const when = whenNext();
  let reply: string;
  try {
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    const r = await parseRequests([{ text, at }], env.AI_MODEL);
    if (r.skip_today) reply = `👌 Okay, no digest ${when.startsWith("tomorrow") ? "tomorrow" : "tonight"}.`;
    else if (r.summary) reply = `✅ Got it: <b>${escape(r.summary)}</b>.\nYou'll get it ${when}.`;
    else
      reply =
        "👋 Noted. To change your next digest, tell me the time, the mix or topics, e.g. <i>“45 min, only shorts, something funny”</i>.";
  } catch (e) {
    console.log(`parse failed: ${(e as Error).message}`);
    reply = `✅ Got it. I'll use this ${when}.`;
  }
  await telegram(env, "sendMessage", { chat_id, text: reply, parse_mode: "HTML" });
}

async function handleUpdate(env: Env, update: any) {
  const chat = String(update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? "");
  if (chat !== env.TELEGRAM_CHAT_ID) return; // ignore anyone else who finds the bot

  const q = update.callback_query;
  if (q) {
    const vote = String(q.data ?? "").startsWith("u|") ? "👍 Noted: more like this" : "👎 Noted: less like this";
    await telegram(env, "answerCallbackQuery", { callback_query_id: q.id, text: vote });
    return;
  }
  const m = update.message;
  if (typeof m?.text !== "string") return;
  if (m.text.startsWith("/start")) {
    await telegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: "👋 Hi! Your digest arrives around 6pm. Message me any time to change it, e.g. “30 min, mostly shorts, nothing about money”.",
    });
    return;
  }
  if (m.text.startsWith("/")) return;
  await replyToMessage(env, m.text, new Date(m.date * 1000).toISOString());
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

export default {
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
      ctx.waitUntil(handleUpdate(env, update).catch((e) => console.log(`handle failed: ${e}`)));
      return new Response("ok");
    }

    if (url.pathname.startsWith("/api/")) return handleApi(request, env);

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
