// 👍/👎 feedback from Telegram buttons. There is no always-on server: taps wait in Telegram
// (for up to 24 h) and are collected at the start of each run, then turned into per-channel weights.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FEEDBACK_PATH = "state/feedback.json";

// Each net 👍 multiplies a channel's weight by STEP, each net 👎 divides by it, within [MIN, MAX].
export const STEP = 1.5;
export const MIN_WEIGHT = 0.1;
export const MAX_WEIGHT = 3;

export interface Vote {
  vote: "up" | "down";
  channelId: string;
  at: string;
}

export interface FeedbackState {
  offset: number; // next Telegram update_id to fetch
  votes: Record<string, Vote>; // by videoId; the latest tap wins, so you can change your mind
  sinceDigest?: { up: number; down: number }; // taps collected since the last digest, for its header
}

export function loadFeedback(path = FEEDBACK_PATH): FeedbackState {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { offset: 0, votes: {} };
}

export function saveFeedback(state: FeedbackState, path = FEEDBACK_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/** Button payload; Telegram allows 64 bytes. "u|<11-char video id>|<24-char channel id>" is 38. */
export function callbackData(vote: "up" | "down", videoId: string, channelId: string): string {
  return `${vote === "up" ? "u" : "d"}|${videoId}|${channelId}`;
}

export function parseCallback(data: string): { vote: "up" | "down"; videoId: string; channelId: string } | null {
  const m = data.match(/^([ud])\|([\w-]{6,20})\|(UC[\w-]{22})$/);
  return m ? { vote: m[1] === "u" ? "up" : "down", videoId: m[2], channelId: m[3] } : null;
}

/** Applies Telegram updates to the state. Only button taps from my own chat count. */
export function applyUpdates(state: FeedbackState, updates: any[], chatId: string) {
  let up = 0;
  let down = 0;
  for (const u of updates) {
    state.offset = Math.max(state.offset, u.update_id + 1);
    const q = u.callback_query;
    if (!q || String(q.message?.chat?.id) !== chatId) continue;
    const c = parseCallback(q.data ?? "");
    if (!c) continue;
    state.votes[c.videoId] = { vote: c.vote, channelId: c.channelId, at: new Date(q.message?.date * 1000 || Date.now()).toISOString() };
    c.vote === "up" ? up++ : down++;
  }
  return { up, down };
}

/** Fetches pending taps from Telegram and records them. Returns how many arrived this time. */
export async function collectFeedback(log = console.log) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");

  const state = loadFeedback();
  const qs = new URLSearchParams({ offset: String(state.offset), allowed_updates: JSON.stringify(["callback_query"]) });
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?${qs}`);
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram getUpdates failed: ${body.description ?? res.status}`);

  const counts = applyUpdates(state, body.result, chatId);
  const since = state.sinceDigest ?? { up: 0, down: 0 };
  state.sinceDigest = { up: since.up + counts.up, down: since.down + counts.down };
  saveFeedback(state);
  log(`Feedback: ${counts.up} 👍, ${counts.down} 👎 collected (${Object.keys(state.votes).length} votes in total)`);
  return counts;
}

/** Taps collected since the last digest (including by the 6am run); `reset` once the digest is sent. */
export function tapsSinceDigest(path = FEEDBACK_PATH) {
  return loadFeedback(path).sinceDigest ?? { up: 0, down: 0 };
}

export function resetTapsSinceDigest(path = FEEDBACK_PATH): void {
  const state = loadFeedback(path);
  state.sinceDigest = { up: 0, down: 0 };
  saveFeedback(state, path);
}

/** Per-channel weight multipliers learned from votes: STEP^(👍 − 👎), clamped. */
export function channelWeights(state: FeedbackState): Map<string, { weight: number; up: number; down: number }> {
  const tally = new Map<string, { up: number; down: number }>();
  for (const v of Object.values(state.votes)) {
    const t = tally.get(v.channelId) ?? { up: 0, down: 0 };
    v.vote === "up" ? t.up++ : t.down++;
    tally.set(v.channelId, t);
  }
  const out = new Map<string, { weight: number; up: number; down: number }>();
  for (const [ch, t] of tally) {
    const weight = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, STEP ** (t.up - t.down)));
    out.set(ch, { weight, ...t });
  }
  return out;
}

// `npm run feedback`: collect taps only (the 6am run), so none expire before the evening digest.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.loadEnvFile();
  } catch {}
  await collectFeedback();
}
