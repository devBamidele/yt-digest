import { test } from "node:test";
import assert from "node:assert/strict";
import { cooldownNotice, countdown, isDue, nextDigest, nextDigestTime, statusLine } from "../worker/time.ts";

const lagos = (day: number, hhmm: string) => new Date(`2026-10-${String(day).padStart(2, "0")}T${hhmm}:00+01:00`);
const base = { timezone: "Africa/Lagos", delivery_hour: 10, delivery_minute: 0, last_digest_at: null as string | null, next_digest_at: null as string | null };

test("one digest a day: after a 10am digest, nothing else for 23 hours", () => {
  const u = { ...base, last_digest_at: lagos(9, "10:03").toISOString() };
  // Moving the daily time to later today doesn't give a second digest…
  const moved = { ...u, delivery_hour: 20 };
  assert.equal(isDue(moved, lagos(9, "20:00")), false);
  assert.equal(nextDigest(moved, lagos(9, "14:00")), "tomorrow at 8pm");
  // …and neither does a one-off "send it now".
  const now = { ...u, next_digest_at: lagos(9, "14:00").toISOString() };
  assert.equal(isDue(now, lagos(9, "14:05")), false);
  assert.match(cooldownNotice(u, lagos(9, "14:00"))!, /next one can come tomorrow at 9:03am \(in 19h 3m\)/);
});

test("the daily digest doesn't drift: tomorrow's 10am check still delivers", () => {
  const u = { ...base, last_digest_at: lagos(9, "10:03").toISOString() };
  assert.equal(isDue(u, lagos(10, "10:00")), true);
  assert.equal(nextDigestTime(u, lagos(9, "12:00"))!.toISOString(), lagos(10, "10:00").toISOString());
});

test("moving the time earlier waits out the cooldown", () => {
  const u = { ...base, delivery_hour: 8, last_digest_at: lagos(9, "10:03").toISOString() }; // 8am < 23h after 10:03
  assert.equal(isDue(u, lagos(10, "08:00")), false);
  assert.equal(nextDigest(u, lagos(9, "12:00")), "Sun at 8am");
});

test("first digest ever: no cooldown", () => {
  assert.equal(isDue(base, lagos(9, "10:00")), true);
  assert.equal(cooldownNotice(base, lagos(9, "10:00")), null);
});

test("countdown and pinned status line", () => {
  assert.equal(countdown(lagos(9, "19:40"), lagos(9, "10:00")), "in 9h 40m");
  assert.equal(countdown(lagos(9, "10:35"), lagos(9, "10:00")), "in 35m");
  assert.equal(countdown(lagos(9, "12:00"), lagos(9, "10:00")), "in 2h");
  const u = { ...base, last_digest_at: lagos(9, "10:03").toISOString() };
  assert.equal(statusLine(u, lagos(9, "10:20")), "📺 Next digest: tomorrow at 10am · in 23h 40m · ⏳ one a day");
  assert.equal(statusLine({ ...u, status: "paused" }, lagos(9, "10:20")), "⏸ Digests paused · send /resume to restart");
  assert.equal(statusLine(base, lagos(9, "10:00")), "📺 Your digest is on its way…");
});

test("seconds on the clock don't shift the next digest to the next 5-minute mark", () => {
  const u = { ...base, delivery_hour: 20, delivery_minute: 30 };
  const at = new Date(lagos(9, "08:47").getTime() + 37_000); // 08:47:37
  assert.equal(nextDigestTime(u, at)!.toISOString(), lagos(9, "20:30").toISOString());
});
