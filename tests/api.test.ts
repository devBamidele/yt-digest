import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import worker from "../worker/index.ts";
import * as db from "../worker/db.ts";

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let env: any;
before(async () => {
  proxy = await getPlatformProxy({ configPath: "worker/wrangler.toml", persist: false });
  env = { ...(proxy.env as any), EVENTS_TOKEN: "pull" };
  for (const s of readFileSync("worker/schema.sql", "utf8").replace(/--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) {
    await env.DB.prepare(s).run();
  }
  await db.createUser(env.DB, "500", "Ada");
  await db.updateUser(env.DB, "500", { status: "active", delivery_hour: 18 });
  await db.addRequest(env.DB, "500", "45 min, only shorts");
});
after(async () => proxy?.dispose());

const call = (path: string, init: RequestInit = {}, token = "pull") =>
  worker.fetch(new Request(`https://w${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }), env, { waitUntil() {} });
const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

test("api needs the token", async () => {
  assert.equal((await call("/api/due", {}, "wrong")).status, 403);
});

test("due → state → digest round trip", async () => {
  const due = (await (await call("/api/due?at=2026-10-09T17:10:00Z")).json()) as any;
  assert.deepEqual(due.users, ["500"]);
  const st = (await (await call("/api/users/500/state")).json()) as any;
  assert.equal(st.state.user.name, "Ada");
  assert.equal(st.state.requests[0].text, "45 min, only shorts");
  const reqId = st.state.requests[0].id;
  assert.equal((await post("/api/users/500/digest", { sentVideoIds: ["v1"], lastRequestId: reqId, costUsd: 0.05 })).status, 200);
  const after = (await (await call("/api/users/500/state")).json()) as any;
  assert.deepEqual(after.state.sent.map((s: any) => s.video_id), ["v1"]);
  assert.equal(after.state.requests.length, 0);
  assert.equal(Math.round(after.costToday * 100), 5);
});

test("taste, ratings, agent notes and shared summaries", async () => {
  await post("/api/users/500/taste", { learned: "Likes action", votesUsed: 3 });
  await post("/api/users/500/ratings", { cacheKey: "k", items: [{ video_id: "v2", fit: 7, reason: "action" }] });
  await post("/api/users/500/agent-notes", { notes: ["Channel X reposts"] });
  await post("/api/summaries", { items: [{ video_id: "v2", summary: "S", model: "m", prompt_version: 2 }] });
  const st = ((await (await call("/api/users/500/state")).json()) as any).state;
  assert.equal(st.taste.learned, "Likes action");
  assert.equal(st.ratings[0].fit, 7);
  assert.equal(st.agentNotes[0].note, "Channel X reposts");
  const sums = (await (await post("/api/summaries/lookup", { videoIds: ["v2"] })).json()) as any;
  assert.equal(sums.summaries[0].summary, "S");
});

test("unknown users and routes are 404", async () => {
  assert.equal((await call("/api/users/999/state")).status, 404);
  assert.equal((await call("/api/nope")).status, 404);
});

test("owner alerts from the digest run: sent to the owner's chat at most once an hour per key", async () => {
  const realFetch = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return Response.json({ ok: true });
  }) as any;
  try {
    env.TELEGRAM_CHAT_ID = "1";
    const first = (await (await post("/api/alert", { key: "credit", text: "⚠️ out of credit" })).json()) as any;
    const again = (await (await post("/api/alert", { key: "credit", text: "⚠️ out of credit" })).json()) as any;
    assert.deepEqual([first.sent, again.sent], [true, false]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /\/sendMessage$/);
    assert.deepEqual(sent[0].body, { chat_id: "1", text: "⚠️ out of credit" });
    assert.equal((await post("/api/alert", { text: "no key" })).status, 400);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("cron check: starts the GitHub run only when someone is due, passing the exact moment", async () => {
  const { checkDue } = await import("../worker/index.ts");
  const realFetch = globalThis.fetch;
  const dispatched: any[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    dispatched.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  }) as any;
  try {
    const e = { ...env, GITHUB_REPO: "me/repo", GH_DISPATCH_TOKEN: "gh" };
    // User 500 (Lagos, 18:00) had a digest the day before. Pin its time: the round-trip test stamps the real
    // clock, and a cooldown measured from today would make this fixed date look "not due" forever.
    await env.DB.prepare("UPDATE users SET last_digest_at = ? WHERE chat_id = ?").bind("2026-10-09T17:10:00.000Z", "500").run();
    assert.equal(await checkDue(e, Date.parse("2026-10-10T10:00:00Z")), "nobody due"); // 11:00 Lagos
    assert.equal(dispatched.length, 0);
    assert.equal(await checkDue(e, Date.parse("2026-10-10T17:00:00Z")), "started run for 1 user(s)"); // 18:00 Lagos
    assert.equal(dispatched[0].url, "https://api.github.com/repos/me/repo/actions/workflows/users.yml/dispatches");
    assert.deepEqual(dispatched[0].body, { ref: "main", inputs: { at: "2026-10-10T17:00:00.000Z" } });
  } finally {
    globalThis.fetch = realFetch;
  }
});
