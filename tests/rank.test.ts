import { test } from "node:test";
import assert from "node:assert/strict";
import { blend, ratingsKey, shortlist } from "../src/rank.ts";
import type { Video } from "../src/types.ts";

let n = 0;
const v = (kind: "short" | "long", score: number): Video => ({
  videoId: `v${++n}`, title: "t", description: "", publishedAt: "", channelId: "UC", creator: "c",
  priorityWeight: 1, durationSeconds: kind === "short" ? 40 : 600, kind, score,
});

test("shortlist keeps the top formula scores per kind, split like the budget", () => {
  const vids = [...Array.from({ length: 10 }, (_, i) => v("long", i)), ...Array.from({ length: 10 }, (_, i) => v("short", i))];
  const s = shortlist(vids, 10, 0.4);
  assert.equal(s.filter((x) => x.kind === "short").length, 4);
  assert.equal(s.filter((x) => x.kind === "long").length, 6);
  assert.deepEqual(s.filter((x) => x.kind === "short").map((x) => x.score), [9, 8, 7, 6]);
});

test("blend: AI fit dominates at ai_weight 0.7, low fits are dropped, unrated keep the formula", () => {
  const popular = v("long", 100); // formula's favourite
  const niche = v("long", 1); // formula's least favourite
  const disliked = v("long", 50);
  const unrated = v("long", 60);
  const ratings = new Map([
    [popular.videoId, { fit: 5, reason: "neutral" }],
    [niche.videoId, { fit: 10, reason: "loves this" }],
    [disliked.videoId, { fit: 2, reason: "football" }],
  ]);
  const { eligible, rejected } = blend([popular, niche, disliked, unrated], ratings, { aiWeight: 0.7, minFit: 4 });
  const score = (id: string) => eligible.find((x) => x.videoId === id)!.score!;
  assert.ok(score(niche.videoId) > score(popular.videoId), "a 10/10 fit beats a popular 5/10");
  assert.deepEqual(rejected.map((x) => x.videoId), [disliked.videoId]);
  assert.match(rejected[0].reason!, /not your taste \(fit 2\/10: football\)/);
  assert.ok(eligible.some((x) => x.videoId === unrated.videoId));
});

test("ratings cache key changes with the profile, the request or the model", () => {
  const k = ratingsKey("likes cooking", "", "m");
  assert.notEqual(k, ratingsKey("likes cooking, no football", "", "m"));
  assert.notEqual(k, ratingsKey("likes cooking", "30 min tonight", "m"));
  assert.notEqual(k, ratingsKey("likes cooking", "", "other"));
  assert.equal(k, ratingsKey("likes cooking", "", "m"));
});
