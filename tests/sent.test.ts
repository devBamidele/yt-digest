import { test } from "node:test";
import assert from "node:assert/strict";
import { markSent, unsent } from "../src/sent.ts";
import type { Video } from "../src/types.ts";

const v = (id: string) => ({ videoId: id }) as Video;

test("sent videos are filtered out of the next run", () => {
  const sent = markSent([v("a")], {}, new Date("2026-10-08T17:00:00Z"));
  assert.deepEqual(unsent([v("a"), v("b")], sent).map((x) => x.videoId), ["b"]);
});

test("entries older than 30 days are pruned", () => {
  const sent = { old: "2026-08-01T00:00:00Z", recent: "2026-10-01T00:00:00Z" };
  const next = markSent([v("new")], sent, new Date("2026-10-08T17:00:00Z"));
  assert.deepEqual(Object.keys(next).sort(), ["new", "recent"]);
});

test("sentToday uses the Lagos date", async () => {
  const { sentToday } = await import("../src/sent.ts");
  const now = new Date("2026-10-08T22:30:00Z"); // 23:30 in Lagos, still the 8th
  assert.equal(sentToday({ a: "2026-10-08T06:00:00Z" }, now), true);
  assert.equal(sentToday({ a: "2026-10-07T22:59:00Z" }, now), false); // 23:59 on the 7th in Lagos
  assert.equal(sentToday({}, now), false);
});
