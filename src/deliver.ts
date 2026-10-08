// Step 7: format the digest and send it via Telegram, one message per video with its own 👍/👎.
import { callbackData } from "./feedback.ts";
import { fmtDuration, type Selection } from "./select.ts";
import type { Video } from "./types.ts";

const SEND_GAP_MS = 400; // stay well under Telegram's per-chat rate limit

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface DigestMessage {
  text: string;
  video?: Video; // set on per-video messages: gets 👍/👎 buttons and is marked sent once delivered
}

export function keyboard(v: Video) {
  return {
    inline_keyboard: [
      [
        { text: "👍", callback_data: callbackData("up", v.videoId, v.channelId) },
        { text: "👎", callback_data: callbackData("down", v.videoId, v.channelId) },
      ],
    ],
  };
}

function item(v: Video, n: number): string {
  const url = `https://youtu.be/${v.videoId}`;
  return [
    `${v.kind === "short" ? "⚡" : "🎬"} <b>${n}. <a href="${url}">${escapeHtml(v.title)}</a></b>`,
    `${escapeHtml(v.creator)} · ${fmtDuration(v.durationSeconds ?? 0)}`,
    escapeHtml(v.summary ?? ""),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Header message, one message per video (long-form first, then shorts), then the total. */
export function formatDigest(
  sel: Selection,
  picked: Video[],
  budgetMinutes: number,
  date: string,
  feedbackLine?: string,
): DigestMessage[] {
  let header = `📺 <b>Your YouTube digest</b> · ${date} · ${budgetMinutes} min`;
  if (feedbackLine) header += `\n<i>${escapeHtml(feedbackLine)}</i>`;
  if (picked.length === 0) return [{ text: `${header}\n\n${escapeHtml(sel.note ?? "Nothing new today.")}` }];

  const long = picked.filter((v) => v.kind === "long");
  const shorts = picked.filter((v) => v.kind === "short");
  const sum = (vs: Video[]) => vs.reduce((a, v) => a + (v.durationSeconds ?? 0), 0);
  const counts = `${long.length} videos (${fmtDuration(sum(long))}) + ${shorts.length} shorts (${fmtDuration(sum(shorts))})`;
  header += `\n🎬 ${counts.replace(" + ", " · ⚡ ")}`;

  let footer = `⏱ <b>Total: ${fmtDuration(sel.totalSeconds)} of ${budgetMinutes} min</b> · ${counts}`;
  if (sel.note) footer += `\nℹ️ ${escapeHtml(sel.note)}`;
  footer += `\nTap 👍/👎 under a video to get more or less from that channel. Taps are picked up on the next run.`;

  return [
    { text: header },
    ...[...long, ...shorts].map((video, i) => ({ text: item(video, i + 1), video })),
    { text: footer },
  ];
}

export async function sendTelegram(
  text: string,
  { replyMarkup, silent = false }: { replyMarkup?: object; silent?: boolean } = {},
  attempt = 1,
): Promise<void> {
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
      disable_notification: silent,
      ...(replyMarkup && { reply_markup: replyMarkup }),
    }),
  });
  const body = await res.json();
  if (body.ok) return;
  const wait = body.parameters?.retry_after;
  if (res.status === 429 && wait && attempt <= 3) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    return sendTelegram(text, { replyMarkup, silent }, attempt + 1);
  }
  throw new Error(`Telegram sendMessage failed: ${body.description ?? res.status}`);
}

/**
 * Sends the messages in order; only the first one notifies. Calls `onDelivered` for each video
 * as soon as its message is sent, so a failure partway through never repeats earlier videos.
 */
export async function deliver(messages: DigestMessage[], onDelivered: (v: Video) => void = () => {}): Promise<void> {
  for (const [i, m] of messages.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    await sendTelegram(m.text, { replyMarkup: m.video && keyboard(m.video), silent: i > 0 });
    if (m.video) onDelivered(m.video);
  }
}
