// Step 7: format the digest and send it via Telegram.
import { callbackData } from "./feedback.ts";
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

export interface DigestMessage {
  text: string;
  items: { n: number; video: Video }[]; // the numbered videos in this message, for its 👍/👎 buttons
}

/** Rows of [n 👍][n 👎][m 👍][m 👎] for the videos in one message. */
export function keyboard(items: DigestMessage["items"]) {
  const buttons = items.flatMap(({ n, video }) => [
    { text: `${n} 👍`, callback_data: callbackData("up", video.videoId, video.channelId) },
    { text: `${n} 👎`, callback_data: callbackData("down", video.videoId, video.channelId) },
  ]);
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  return { inline_keyboard: rows };
}

/** Builds the digest as one or more Telegram messages, each under the length limit. */
export function formatDigest(
  sel: Selection,
  picked: Video[],
  budgetMinutes: number,
  date: string,
  feedbackLine?: string,
): DigestMessage[] {
  let header = `📺 <b>Your YouTube digest</b> · ${date} · ${budgetMinutes} min`;
  if (feedbackLine) header += `\n<i>${escapeHtml(feedbackLine)}</i>`;
  if (picked.length === 0) return [{ text: `${header}\n\n${escapeHtml(sel.note ?? "Nothing new today.")}`, items: [] }];

  const long = picked.filter((v) => v.kind === "long");
  const shorts = picked.filter((v) => v.kind === "short");
  const blocks: { text: string; item?: { n: number; video: Video } }[] = [{ text: header }];
  let n = 1;
  const add = (vs: Video[]) => vs.forEach((v) => blocks.push({ text: item(v, n), item: { n: n++, video: v } }));
  if (long.length) blocks.push({ text: `🎬 <b>Videos</b>` }), add(long);
  if (shorts.length) blocks.push({ text: `⚡ <b>Shorts</b>` }), add(shorts);

  const sum = (vs: Video[]) => vs.reduce((a, v) => a + (v.durationSeconds ?? 0), 0);
  let footer =
    `⏱ <b>Total: ${fmtDuration(sel.totalSeconds)} of ${budgetMinutes} min</b> · ` +
    `${long.length} videos (${fmtDuration(sum(long))}) + ${shorts.length} shorts (${fmtDuration(sum(shorts))})`;
  if (sel.note) footer += `\nℹ️ ${escapeHtml(sel.note)}`;
  footer += `\n👍/👎 below teach it what you like; taps are picked up on the next run.`;
  blocks.push({ text: footer });

  // Pack blocks into as few messages as fit.
  const messages: DigestMessage[] = [];
  let cur: DigestMessage = { text: "", items: [] };
  for (const b of blocks) {
    const next = cur.text ? `${cur.text}\n\n${b.text}` : b.text;
    if (next.length > MAX_LEN && cur.text) {
      messages.push(cur);
      cur = { text: b.text, items: [] };
    } else {
      cur.text = next;
    }
    if (b.item) cur.items.push(b.item);
  }
  if (cur.text) messages.push(cur);
  return messages;
}

export async function sendTelegram(text: string, replyMarkup?: object, attempt = 1): Promise<void> {
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
      ...(replyMarkup && { reply_markup: replyMarkup }),
    }),
  });
  const body = await res.json();
  if (body.ok) return;
  const wait = body.parameters?.retry_after;
  if (res.status === 429 && wait && attempt <= 3) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    return sendTelegram(text, replyMarkup, attempt + 1);
  }
  throw new Error(`Telegram sendMessage failed: ${body.description ?? res.status}`);
}

export async function deliver(messages: DigestMessage[]): Promise<void> {
  for (const m of messages) await sendTelegram(m.text, m.items.length ? keyboard(m.items) : undefined);
}
