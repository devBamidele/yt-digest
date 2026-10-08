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
