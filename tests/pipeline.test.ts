import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/classify.ts";
import { scoreVideo } from "../src/score.ts";
import { assertBudget, BudgetExceededError, select } from "../src/select.ts";
import type { Video } from "../src/types.ts";

const NOW = new Date("2026-10-08T17:00:00Z");
let n = 0;
function video(over: Partial<Video>): Video {
  n++;
  return {
    videoId: `v${n}`, title: `Video ${n}`, description: "", channelId: "UC", creator: "c",
    publishedAt: "2026-10-08T07:00:00Z", priorityWeight: 1, views: 1000, subscriberCount: 10_000,
    durationSeconds: 600, ...over,
  };
}

test("classify: 180s is a short, 181s is long", () => {
  const [a, b] = classify([video({ durationSeconds: 180 }), video({ durationSeconds: 181 })], 180);
  assert.equal(a.kind, "short");
  assert.equal(b.kind, "long");
});

test("score: small channel with a strong ratio beats a big channel with more raw views", () => {
  const small = video({ views: 5_000, subscriberCount: 20_000 });
  const big = video({ views: 200_000, subscriberCount: 5_000_000 });
  assert.ok(scoreVideo(small, NOW) > scoreVideo(big, NOW));
});

test("score: views per hour, so a fresh upload isn't punished", () => {
  const fresh = video({ views: 1000, publishedAt: "2026-10-08T15:00:00Z" }); // 2h old
  const old = video({ views: 5000, publishedAt: "2026-10-07T18:00:00Z" }); // 23h old
  assert.ok(scoreVideo(fresh, NOW) > scoreVideo(old, NOW));
});

test("score: priority weight multiplies, subscriber floor applies", () => {
  const a = video({ priorityWeight: 2 });
  assert.equal(scoreVideo(a, NOW), scoreVideo({ ...a, priorityWeight: 1 }, NOW) * 2);
  assert.equal(scoreVideo(video({ subscriberCount: 5 }), NOW), scoreVideo(video({ subscriberCount: 1000 }), NOW));
});

// A realistic random pool: mix of shorts and long-form with random scores.
function pool(seed: number): Video[] {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: 25 }, (_, i) => {
    const short = i % 3 === 0;
    return {
      ...video({ durationSeconds: short ? 20 + Math.floor(rand() * 160) : 240 + Math.floor(rand() * 3000) }),
      kind: short ? ("short" as const) : ("long" as const),
      score: rand(),
    };
  });
}

test("select: never over budget for 30/60/120 min across many pools", () => {
  for (const budget of [30, 60, 120]) {
    for (let seed = 1; seed <= 50; seed++) {
      const sel = select(pool(seed), budget, 0.3);
      assert.ok(sel.totalSeconds <= budget * 60, `budget ${budget}, seed ${seed}: ${sel.totalSeconds}s`);
      assert.equal(sel.picked.length + sel.dropped.length, 25);
    }
  }
});

test("select: shorts get roughly their share when there are enough of them", () => {
  for (const budget of [30, 60, 120]) {
    const sel = select(pool(7), budget, 0.3);
    const shortsTime = sel.picked.filter((v) => v.kind === "short").reduce((a, v) => a + v.durationSeconds!, 0);
    assert.ok(shortsTime > 0, `budget ${budget}: no shorts picked`);
    // Pass 1 caps shorts at their share; spillover can only add a little on top.
    assert.ok(shortsTime <= sel.shortsBudgetSeconds + (sel.budgetSeconds - sel.totalSeconds) + 180);
  }
});

test("select: spillover fills the budget when there are no shorts", () => {
  const longs = Array.from({ length: 10 }, () => ({ ...video({ durationSeconds: 600 }), kind: "long" as const, score: 1 }));
  const sel = select(longs, 60, 0.3);
  assert.equal(sel.totalSeconds, 3600); // 6 × 10 min, not just the 42-min long-form share
  assert.ok(sel.picked.some((v) => v.reason?.includes("spillover")));
});

test("select: a video longer than the budget is dropped with a reason", () => {
  const sel = select([{ ...video({ durationSeconds: 4000 }), kind: "long", score: 9 }], 60, 0.3);
  assert.equal(sel.picked.length, 0);
  assert.match(sel.dropped[0].reason!, /too long for today/);
});

test("select: empty input gives an empty selection", () => {
  const sel = select([], 60, 0.3);
  assert.equal(sel.picked.length, 0);
  assert.equal(sel.totalSeconds, 0);
});

test("assertBudget throws when over", () => {
  assert.throws(() => assertBudget([video({ durationSeconds: 3601 })], 3600), BudgetExceededError);
});

test("select: note explains an unfilled budget", () => {
  const few = [{ ...video({ durationSeconds: 600 }), kind: "long" as const, score: 1 }];
  assert.equal(select(few, 60, 0.3).note, "Only 10:00 of new content available.");
  assert.equal(select([], 60, 0.3).note, "No new videos today.");
  const tooLong = [
    { ...video({ durationSeconds: 1500 }), kind: "long" as const, score: 1 },
    { ...video({ durationSeconds: 2400 }), kind: "long" as const, score: 1 },
  ];
  assert.match(select(tooLong, 60, 0.3).note!, /unused: the remaining videos are too long/);
});

test("select: max per creator", () => {
  const spam = Array.from({ length: 6 }, (_, i) => ({
    ...video({ durationSeconds: 30, channelId: "UCspam", creator: "Spam" }), kind: "short" as const, score: 10 - i,
  }));
  const other = { ...video({ durationSeconds: 30, channelId: "UCother" }), kind: "short" as const, score: 0.1 };
  const sel = select([...spam, other], 60, 0.3, { maxPerCreator: 2 });
  assert.equal(sel.picked.filter((v) => v.channelId === "UCspam").length, 2);
  assert.ok(sel.picked.includes(sel.picked.find((v) => v.channelId === "UCother")!));
  // The two kept are the spam channel's highest-scored.
  assert.deepEqual(sel.picked.filter((v) => v.channelId === "UCspam").map((v) => v.score), [10, 9]);
  assert.match(sel.dropped[0].reason!, /creator cap \(2 higher-scored from Spam\)/);
});

test("select: no single video takes more than its share of the budget, or over the hard max", () => {
  const vids = [25, 35, 70].map((m) => ({ ...video({ durationSeconds: m * 60 }), kind: "long" as const, score: 1 }));
  const opts = { maxVideoMinutes: 60, maxVideoShare: 0.5 };
  assert.deepEqual(select(vids, 60, 0.3, opts).picked.map((v) => v.durationSeconds), [1500]); // ≤ 30 min
  assert.deepEqual(select(vids, 120, 0.3, opts).picked.map((v) => v.durationSeconds).sort(), [1500, 2100]); // 70 > 60 max
  assert.match(select(vids, 60, 0.3, opts).dropped[0].reason!, /too long for today \(max 30:00 per video\)/);
});
