import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import * as db from "../worker/db.ts";

// A local, in-memory D1 with the real schema: tests touch no live data.
let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let DB: db.D1;
before(async () => {
  proxy = await getPlatformProxy({ configPath: "worker/wrangler.toml", persist: false });
  DB = (proxy.env as any).DB;
  const statements = readFileSync("worker/schema.sql", "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
  for (const s of statements) await DB.prepare(s).run();
});
after(async () => proxy?.dispose());

test("users: created once, updated field by field", async () => {
  const u = await db.createUser(DB, "100", "Dele", true);
  assert.equal(u.status, "onboarding");
  assert.equal(u.is_owner, 1);
  await db.createUser(DB, "100", "Someone else"); // no-op
  await db.updateUser(DB, "100", { timezone: "Europe/London", delivery_hour: 7, budget_minutes: 30 });
  const v = (await db.getUser(DB, "100"))!;
  assert.equal(v.name, "Dele");
  assert.deepEqual([v.timezone, v.delivery_hour, v.budget_minutes, v.shorts_ratio], ["Europe/London", 7, 30, 0.4]);
});

test("invites work exactly once", async () => {
  const code = await db.createInvite(DB, "100");
  assert.match(code, /^[\w-]{12}$/);
  assert.equal(await db.redeemInvite(DB, code, "200"), true);
  assert.equal(await db.redeemInvite(DB, code, "300"), false);
  assert.equal(await db.redeemInvite(DB, "nope", "300"), false);
});

test("channels are replaced wholesale on import (dupes collapsed)", async () => {
  await db.createUser(DB, "200", "Friend");
  assert.equal(await db.replaceCreators(DB, "200", [{ id: "UCa", name: "A" }, { id: "UCb", name: "B" }, { id: "UCa", name: "A" }]), 2);
  await db.replaceCreators(DB, "200", [{ id: "UCc", name: "C" }]);
  assert.deepEqual((await db.userState(DB, "200"))!.creators, [{ id: "UCc", name: "C" }]);
});

test("state bundle: votes (latest wins), requests, taste, and what a digest uses up", async () => {
  await db.recordVote(DB, "200", "vid1", "UCc", "up");
  await db.recordVote(DB, "200", "vid1", "UCc", "down");
  await db.addRequest(DB, "200", "30 min tonight");
  await db.addRequest(DB, "200", "no football");
  await db.setTasteNotes(DB, "200", "Loves cooking");
  let s = (await db.userState(DB, "200"))!;
  assert.deepEqual(s.votes.map((v: any) => v.vote), ["down"]);
  assert.equal(s.taste.notes, "Loves cooking");
  assert.equal(s.requests.length, 2);

  // The digest used the first request only (the second arrived mid-run).
  const firstId = (s.requests[0] as any).id;
  await db.recordDigest(DB, "200", { sentVideoIds: ["vid1", "vid2"], lastRequestId: firstId, costUsd: 0.12 });
  s = (await db.userState(DB, "200"))!;
  assert.deepEqual(s.sent.map((x: any) => x.video_id).sort(), ["vid1", "vid2"]);
  assert.deepEqual(s.requests.map((r: any) => r.text), ["no football"]);
  assert.ok(s.user.last_digest_at);
  assert.equal(Math.round((await db.costToday(DB, "200")) * 100), 12);
});

test("due users: their local delivery hour, active, not already sent today", async () => {
  await db.createUser(DB, "300", "Lagos");
  await db.updateUser(DB, "300", { status: "active", timezone: "Africa/Lagos", delivery_hour: 18 });
  await db.createUser(DB, "400", "London");
  await db.updateUser(DB, "400", { status: "active", timezone: "Europe/London", delivery_hour: 18 });
  const at = new Date("2026-10-09T17:05:00Z"); // 18:05 in Lagos, 18:05 in London (BST)... both UTC+1 in October
  const due = (await db.dueUsers(DB, at)).map((u) => u.chat_id).sort();
  assert.deepEqual(due, ["300", "400"]);
  assert.deepEqual((await db.dueUsers(DB, new Date("2026-10-09T18:05:00Z"))).map((u) => u.chat_id), []);
  await db.recordDigest(DB, "300", { sentVideoIds: [], lastRequestId: null, costUsd: 0, at: "2026-10-09T17:06:00Z" });
  assert.deepEqual((await db.dueUsers(DB, at)).map((u) => u.chat_id), ["400"]);
  await db.updateUser(DB, "400", { status: "paused" });
  assert.deepEqual((await db.dueUsers(DB, at)).map((u) => u.chat_id), []);
});

test("ratings reset when the cache key changes; summaries are shared", async () => {
  await db.saveRatings(DB, "200", "k1", [{ video_id: "a", fit: 8, reason: "r" }]);
  await db.saveRatings(DB, "200", "k1", [{ video_id: "b", fit: 3, reason: "r" }]);
  assert.equal((await db.userState(DB, "200"))!.ratings.length, 2);
  await db.saveRatings(DB, "200", "k2", [{ video_id: "c", fit: 5, reason: "r" }]);
  assert.deepEqual((await db.userState(DB, "200"))!.ratings.map((r: any) => r.video_id), ["c"]);
  await db.putSummaries(DB, [{ video_id: "a", summary: "S", model: "m", prompt_version: 2 }]);
  assert.deepEqual((await db.getSummaries(DB, ["a", "zzz"])).map((s) => s.video_id), ["a"]);
});

test("agent notes keep only the latest 40", async () => {
  await db.addAgentNotes(DB, "200", Array.from({ length: 45 }, (_, i) => `note ${i}`));
  const notes = (await db.userState(DB, "200"))!.agentNotes as any[];
  assert.equal(notes.length, db.MAX_AGENT_NOTES);
  assert.equal(notes.at(-1).note, "note 44");
});

test("oauth state is single-use", async () => {
  await db.putOAuthState(DB, "st", "200", "ver");
  assert.deepEqual(await db.takeOAuthState(DB, "st").then((r) => r && [r.chat_id, r.verifier]), ["200", "ver"]);
  assert.equal(await db.takeOAuthState(DB, "st"), null);
});

test("/delete removes the user from every table", async () => {
  await db.deleteUser(DB, "200");
  assert.equal(await db.userState(DB, "200"), null);
  for (const t of ["creators", "votes", "sent", "requests", "taste", "agent_notes", "ratings", "usage"]) {
    const r = await DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE chat_id = ?`).bind("200").first<{ n: number }>();
    assert.equal(r!.n, 0, t);
  }
});

test("owner alerts: at most one per window", async () => {
  assert.equal(await db.claimAlert(DB, "dispatch", 55), true);
  assert.equal(await db.claimAlert(DB, "dispatch", 55), false);
  assert.equal(await db.claimAlert(DB, "other", 55), true);
  assert.equal(await db.claimAlert(DB, "dispatch", 0), true); // window passed
});
