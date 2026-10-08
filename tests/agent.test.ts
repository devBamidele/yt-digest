import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSelection } from "../src/agent.ts";
import { parseConfig } from "../src/config.ts";
import type { Video } from "../src/types.ts";

const cfg = parseConfig(`creators:\n  - id: UCsBjURrPoezykLs9EqgamOA`, 60); // 60 min, max 2 per creator, ≤30 min per video
const v = (id: string, minutes: number, creator = id): Video => ({
  videoId: id, title: id, description: "", publishedAt: "", channelId: "UC", creator, priorityWeight: 1,
  durationSeconds: minutes * 60, kind: minutes <= 3 ? "short" : "long",
});
const byId = new Map([v("a", 20), v("b", 20), v("c", 15), v("d", 31), v("e", 1, "Spam"), v("f", 1, "Spam"), v("g", 1, "Spam")].map((x) => [x.videoId, x]));

test("a valid selection passes", () => {
  assert.deepEqual(validateSelection(["a", "b", "c"], byId, cfg), []);
});

test("over budget is rejected, with how much over", () => {
  const p = validateSelection(["a", "b", "c", "e"], byId, { ...cfg, budgetMinutes: 50 });
  assert.match(p.join(), /over the 50:00 budget by 6:00/);
});

test("per-creator cap, per-video limit, unknown and duplicate ids are rejected", () => {
  assert.match(validateSelection(["e", "f", "g"], byId, cfg).join(), /3 videos from Spam \(max 2\)/);
  assert.match(validateSelection(["d"], byId, cfg).join(), /over the 30:00 per-video limit/);
  assert.match(validateSelection(["zzz"], byId, cfg).join(), /unknown ids: zzz/);
  assert.match(validateSelection(["a", "a"], byId, cfg).join(), /duplicate ids/);
});

test("mix: too few shorts is rejected when enough shorts exist; fine when they don't", () => {
  const shorts = Array.from({ length: 20 }, (_, i) => v(`s${i}`, 2, `S${i}`)); // 40 min of shorts available
  const longs = [v("l1", 25, "L1"), v("l2", 25, "L2"), v("l3", 8, "L3")];
  const pool = new Map([...shorts, ...longs].map((x) => [x.videoId, x]));
  // 58 min of long-form, 0 shorts, with a 40% shorts target (24 min) → rejected
  assert.match(validateSelection(["l1", "l2", "l3"], pool, { ...cfg, shortsRatio: 0.4 }).join(), /shorts take 0:00, aim for about 24:00/);
  // 25 min long + 12 shorts (24 min) → fine
  assert.deepEqual(validateSelection(["l1", ...shorts.slice(0, 12).map((x) => x.videoId)], pool, { ...cfg, shortsRatio: 0.4 }), []);
  // With no shorts among the candidates, all long-form is fine.
  const onlyLong = new Map(longs.map((x) => [x.videoId, x]));
  assert.deepEqual(validateSelection(["l1", "l2", "l3"], onlyLong, { ...cfg, shortsRatio: 0.4 }), []);
});

test("mix: 'no shorts' / 'only shorts' tonight are strict", () => {
  const pool = new Map([v("l", 20, "L"), v("s", 2, "S")].map((x) => [x.videoId, x]));
  assert.match(validateSelection(["l", "s"], pool, { ...cfg, shortsRatio: 0 }).join(), /no shorts tonight/);
  assert.match(validateSelection(["l", "s"], pool, { ...cfg, shortsRatio: 1 }).join(), /only shorts tonight/);
});
