// Step 5: pick the highest-scoring set of videos that fits the time budget,
// splitting the budget between shorts and long-form, then spilling unused time over.
// Plain code: the budget is a hard limit, enforced by assertBudget.
import type { Video } from "./types.ts";

const UNIT = 10; // seconds; knapsack resolution

export function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}:${String(s).padStart(2, "0")}`;
}

const units = (v: Video) => Math.ceil((v.durationSeconds ?? 0) / UNIT);

/** 0/1 knapsack: indices of items maximising total score within `cap` units. */
function knapsack(items: Video[], cap: number): Set<number> {
  const best = new Array(cap + 1).fill(0);
  const keep = items.map(() => new Array<boolean>(cap + 1).fill(false));
  items.forEach((v, i) => {
    const w = units(v);
    for (let c = cap; c >= w; c--) {
      const withItem = best[c - w] + (v.score ?? 0);
      if (withItem > best[c]) {
        best[c] = withItem;
        keep[i][c] = true;
      }
    }
  });
  const chosen = new Set<number>();
  for (let i = items.length - 1, c = cap; i >= 0; i--) {
    if (keep[i][c]) {
      chosen.add(i);
      c -= units(items[i]);
    }
  }
  return chosen;
}

export class BudgetExceededError extends Error {}

export function assertBudget(videos: Video[], budgetSeconds: number): void {
  const total = videos.reduce((sum, v) => sum + (v.durationSeconds ?? 0), 0);
  if (total > budgetSeconds) {
    throw new BudgetExceededError(`selected ${total}s exceeds budget ${budgetSeconds}s`);
  }
}

export interface Selection {
  picked: Video[];
  dropped: Video[];
  totalSeconds: number;
  budgetSeconds: number;
  shortsBudgetSeconds: number;
  note?: string; // set when the budget couldn't be filled, explaining why
}

/** Keep each creator's top `max` videos by score; the rest are over the cap. */
function capPerCreator(videos: Video[], max: number): { eligible: Video[]; capped: Set<Video> } {
  const counts = new Map<string, number>();
  const capped = new Set<Video>();
  const eligible: Video[] = [];
  for (const v of [...videos].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    const n = counts.get(v.channelId) ?? 0;
    if (n < max) eligible.push(v);
    else capped.add(v);
    counts.set(v.channelId, n + 1);
  }
  return { eligible, capped };
}

export interface SelectOptions {
  maxPerCreator?: number;
  maxVideoMinutes?: number;
  maxVideoShare?: number; // a single video may use at most this share of the budget
}

export function select(
  videos: Video[],
  budgetMinutes: number,
  shortsRatio: number,
  { maxPerCreator = Infinity, maxVideoMinutes = Infinity, maxVideoShare = 1 }: SelectOptions = {},
): Selection {
  const budgetSeconds = Math.floor(budgetMinutes * 60);
  const maxVideoSeconds = Math.min(maxVideoMinutes * 60, budgetSeconds * maxVideoShare);
  const capUnits = Math.floor(budgetSeconds / UNIT);
  const shortsCap = Math.round(capUnits * shortsRatio);
  const longCap = capUnits - shortsCap;

  // Cap per creator first, so one prolific channel can't fill the digest.
  // Videos too long for today's budget are out before anything else, and so is a whole kind
  // when the ratio says none of it ("no shorts" = 0, "only shorts" = 1).
  const banned = shortsRatio === 0 ? "short" : shortsRatio === 1 ? "long" : null;
  const fits = videos.filter((v) => (v.durationSeconds ?? 0) <= maxVideoSeconds && v.kind !== banned);
  const { eligible, capped } = capPerCreator(fits, maxPerCreator);
  const picked = new Map<Video, string>();

  // Pass 1: each side within its own share of the budget.
  for (const [kind, cap] of [["short", shortsCap], ["long", longCap]] as const) {
    const pool = eligible.filter((v) => v.kind === kind);
    for (const i of knapsack(pool, cap)) picked.set(pool[i], `${kind} share`);
  }

  // Pass 2: spill unused time over to whatever is left, of either kind.
  const usedUnits = [...picked.keys()].reduce((sum, v) => sum + units(v), 0);
  const rest = eligible.filter((v) => !picked.has(v));
  for (const i of knapsack(rest, capUnits - usedUnits)) picked.set(rest[i], "spillover");

  const pickedList = videos.filter((v) => picked.has(v)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const totalSeconds = pickedList.reduce((sum, v) => sum + (v.durationSeconds ?? 0), 0);
  assertBudget(pickedList, budgetSeconds);

  const left = budgetSeconds - totalSeconds;
  const result = videos.map((v) => {
    const d = v.durationSeconds ?? 0;
    const stats = `score ${(v.score ?? 0).toFixed(4)}, ${v.kind}, ${fmtDuration(d)}`;
    if (picked.has(v)) return { ...v, selected: true, reason: `picked (${picked.get(v)}): ${stats}` };
    const why =
      v.kind === banned ? `no ${banned === "short" ? "shorts" : "long videos"} tonight`
      : d > maxVideoSeconds ? `too long for today (max ${fmtDuration(Math.floor(maxVideoSeconds))} per video)`
      : capped.has(v) ? `creator cap (${maxPerCreator} higher-scored from ${v.creator})`
      : d > left ? `didn't fit (${fmtDuration(left)} left)`
      : "lower score than the picks";
    return { ...v, selected: false, reason: `dropped: ${why}; ${stats}` };
  });

  const available = videos.reduce((sum, v) => sum + (v.durationSeconds ?? 0), 0);
  let note: string | undefined;
  if (pickedList.length === 0) {
    note = videos.length ? "Nothing fits in your time budget today." : "No new videos today.";
  } else if (available < budgetSeconds) {
    note = `Only ${fmtDuration(available)} of new content available.`;
  } else if (left >= 5 * 60) {
    note = `${fmtDuration(left)} unused: the remaining videos are too long to fit.`;
  }

  return {
    note,
    picked: result.filter((v) => v.selected).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
    dropped: result.filter((v) => !v.selected),
    totalSeconds,
    budgetSeconds,
    shortsBudgetSeconds: shortsCap * UNIT,
  };
}
