// Step 7: format the digest and send it via Telegram.
import { fmtDuration, type Selection } from "./select.ts";
import type { Video } from "./types.ts";

const MAX_LEN = 4096; // Telegram's per-message limit

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function item(v: Video, n: number): string {
  const url = `https://youtu.be/${v.videoId}`;
  return [
    `<b>${n}. <a href="${url}">${escapeHtml(v.title)}</a></b>`,
    `${escapeHtml(v.creator)} · ${fmtDuration(v.durationSeconds ?? 0)}`,
    escapeHtml(v.summary ?? ""),
  ].join("\n");
}

/** Builds the digest as one or more Telegram messages, each under the length limit. */
export function formatDigest(sel: Selection, picked: Video[], budgetMinutes: number, date: string): string[] {
  const header = `📺 <b>Your YouTube digest</b> · ${date} · ${budgetMinutes} min`;
  if (picked.length === 0) return [`${header}\n\n${escapeHtml(sel.note ?? "Nothing new today.")}`];

  const long = picked.filter((v) => v.kind === "long");
  const shorts = picked.filter((v) => v.kind === "short");
  const blocks: string[] = [header];
  let n = 1;
  if (long.length) blocks.push(`🎬 <b>Videos</b>`, ...long.map((v) => item(v, n++)));
  if (shorts.length) blocks.push(`⚡ <b>Shorts</b>`, ...shorts.map((v) => item(v, n++)));

  const sum = (vs: Video[]) => vs.reduce((a, v) => a + (v.durationSeconds ?? 0), 0);
  let footer =
    `⏱ <b>Total: ${fmtDuration(sel.totalSeconds)} of ${budgetMinutes} min</b> · ` +
    `${long.length} videos (${fmtDuration(sum(long))}) + ${shorts.length} shorts (${fmtDuration(sum(shorts))})`;
  if (sel.note) footer += `\nℹ️ ${escapeHtml(sel.note)}`;
  blocks.push(footer);

  // Pack blocks into as few messages as fit.
  const messages: string[] = [];
  let cur = "";
  for (const b of blocks) {
    const next = cur ? `${cur}\n\n${b}` : b;
    if (next.length > MAX_LEN && cur) {
      messages.push(cur);
      cur = b;
    } else {
      cur = next;
    }
  }
  if (cur) messages.push(cur);
  return messages;
}

export async function sendTelegram(text: string, attempt = 1): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  });
  const body = await res.json();
  if (body.ok) return;
  const wait = body.parameters?.retry_after;
  if (res.status === 429 && wait && attempt <= 3) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    return sendTelegram(text, attempt + 1);
  }
  throw new Error(`Telegram sendMessage failed: ${body.description ?? res.status}`);
}

export async function deliver(messages: string[]): Promise<void> {
  for (const m of messages) await sendTelegram(m);
}
