// 👍/👎 feedback: the button payload, and how votes become per-channel weights.
// (Taps themselves are received by the worker and stored in D1.)

// Each net 👍 multiplies a channel's weight by STEP, each net 👎 divides by it, within [MIN, MAX].
export const STEP = 1.5;
export const MIN_WEIGHT = 0.1;
export const MAX_WEIGHT = 3;

/** Button payload; Telegram allows 64 bytes. "u|<11-char video id>|<24-char channel id>" is 38. */
export function callbackData(vote: "up" | "down", videoId: string, channelId: string): string {
  return `${vote === "up" ? "u" : "d"}|${videoId}|${channelId}`;
}

/** Per-channel weight multipliers learned from votes: STEP^(👍 − 👎), clamped. */
export function weightsFromVotes(votes: { channelId: string; vote: "up" | "down" }[]): Map<string, { weight: number; up: number; down: number }> {
  const tally = new Map<string, { up: number; down: number }>();
  for (const v of votes) {
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
