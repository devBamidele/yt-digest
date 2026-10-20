import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppConfig } from "../src/config.ts";
import { alertIfOutOfCredit, runUser } from "../src/multi.ts";
import type { UserState } from "../src/store.ts";
import type { Video } from "../src/types.ts";

const v = (id: string, channelId: string, kind: "short" | "long" = "long"): Video => ({
  videoId: id, title: id, description: "", publishedAt: new Date(Date.now() - 3600_000).toISOString(), channelId, creator: "?",
  priorityWeight: 1, views: 1000, subscriberCount: 10_000, durationSeconds: kind === "short" ? 50 : 300, kind,
});
const state = (over: Partial<UserState> = {}): UserState => ({
  user: { chat_id: "9", name: "T", status: "active", timezone: "Africa/Lagos", delivery_hour: 18, delivery_minute: 0, budget_minutes: 30, shorts_ratio: 0.4, is_owner: 0, last_digest_at: null },
  creators: [{ id: "UCmine", name: "Mine" }],
  votes: [], sent: [{ video_id: "old", at: new Date().toISOString() }], requests: [],
  taste: { notes: "", learned: "", votes_used: 0 }, agentNotes: [], ratings: [],
  ...over,
});
const fakeStore = () => {
  const calls: string[] = [];
  const alerts: { key: string; text: string }[] = [];
  const digests: { sentVideoIds: string[]; lastRequestId: number | null; cost: number }[] = [];
  const store = {
    addCost: async () => void calls.push("addCost"),
    recordDigest: async (_chat: string, sentVideoIds: string[], lastRequestId: number | null, cost: number) => {
      calls.push("recordDigest");
      digests.push({ sentVideoIds, lastRequestId, cost });
    },
    saveRatings: async () => void calls.push("saveRatings"),
    summaryStore: () => ({ get: async () => ({}), put: async () => {} }),
    alertOwner: async (key: string, text: string) => void alerts.push({ key, text }),
  };
  return { calls, alerts, digests, store: store as any };
};

// Stand-ins for the Claude API and Telegram. The SDK client keeps the fetch it first saw, so install
// one stand-in up front and switch what it answers.
process.env.ANTHROPIC_API_KEY ||= "test";
let claudeAnswer: () => Response = () => new Response("no Claude in this test", { status: 500 });
const telegramSent: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  if (String(url).includes("api.anthropic.com")) return claudeAnswer();
  if (String(url).startsWith("https://api.telegram.org/")) {
    telegramSent.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: { message_id: 1 } });
  }
  return realFetch(url, init);
}) as any;
const outOfCredit = () =>
  Response.json({ type: "error", error: { type: "billing_error", message: "Your credit balance is too low to access the Anthropic API." } }, { status: 402 });

async function captureLogs(run: () => Promise<unknown>): Promise<string> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (s: string) => void logs.push(String(s));
  try {
    await run();
  } finally {
    console.log = orig;
  }
  return logs.join("\n");
}

test("only this person's channels, never anything already sent; dry runs don't record a digest", async () => {
  const app = { ...loadAppConfig(), mode: "formula" as const };
  const { calls, store } = fakeStore();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (s: string) => void logs.push(String(s));
  try {
    await runUser(app, store, state(), 0, [v("new", "UCmine"), v("old", "UCmine"), v("theirs", "UCother")], { dryRun: true, noSummaries: true });
  } finally {
    console.log = orig;
  }
  const out = logs.join("\n");
  assert.match(out, /1 candidates from 1 channels/);
  assert.match(out, /1\. new/);
  assert.doesNotMatch(out, /\b(old|theirs)\b\n/);
  assert.deepEqual(calls, []); // formula mode: no Claude cost, and a dry run records nothing
});

test("over twice the daily cap: formula only, no Claude at all", async () => {
  const app = loadAppConfig(); // mode agent by default
  const { store } = fakeStore();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (s: string) => void logs.push(String(s));
  try {
    await runUser(app, store, state({ requests: [{ id: 1, text: "2 hours", at: "" }] }), app.userDailyCapUsd * 2, [v("new", "UCmine")], { dryRun: true, noSummaries: false });
  } finally {
    console.log = orig;
  }
  const out = logs.join("\n");
  assert.match(out, /over the daily cap .*mode formula/);
  assert.doesNotMatch(out, /request:/); // the request isn't parsed by Claude either
});

test("public run output: users are numbered, and no names, chat ids or message text appear", async () => {
  const app = { ...loadAppConfig(), mode: "formula" as const };
  const { store } = fakeStore();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (s: string) => void logs.push(String(s));
  try {
    const st = state({ user: { ...state().user, name: "Ada Lovelace", chat_id: "123456789" } });
    await runUser(app, store, st, 0, [v("secret-pick", "UCmine")], { dryRun: true, noSummaries: true, publicLog: { label: "user 1" } });
  } finally {
    console.log = orig;
  }
  const out = logs.join("\n");
  assert.match(out, /\[user 1\] 1 candidates from 1 channels/);
  assert.doesNotMatch(out, /Ada|123456789|secret-pick/);
});

test("out of credit: the digest still goes out, and the owner is alerted once for the run", async () => {
  const app = loadAppConfig(); // mode agent
  const { store, alerts } = fakeStore();
  claudeAnswer = outOfCredit;
  const out = await captureLogs(() =>
    runUser(app, store, state({ requests: [{ id: 1, text: "30 min", at: "" }] }), 0, [v("new", "UCmine")], { dryRun: true, noSummaries: false }),
  );
  assert.match(out, /dry run: 1 videos/);
  await alertIfOutOfCredit(store);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].key, "credit");
  assert.match(alerts[0].text, /credit balance is too low/);
});

// Fake Claude replies: a JSON answer (for jsonCall) or a tool call (for the agent).
const usage = { input_tokens: 10, output_tokens: 10 };
const jsonAnswer = (data: object) => () =>
  Response.json({ id: "m", type: "message", role: "assistant", model: "m", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: JSON.stringify(data) }], usage });
const toolCall = (name: string, input: object) => () =>
  Response.json({ id: "m", type: "message", role: "assistant", model: "m", stop_reason: "tool_use", stop_sequence: null, content: [{ type: "tool_use", id: "t", name, input }], usage });
const badRequest = () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, { status: 400 });

async function runLog(mode: "agent" | "ai" | "formula", answer: () => Response) {
  claudeAnswer = answer;
  const logDir = mkdtempSync(join(tmpdir(), "runlog-"));
  const { store } = fakeStore();
  await captureLogs(() => runUser({ ...loadAppConfig(), mode }, store, state(), 0, [v("new", "UCmine")], { dryRun: true, noSummaries: true, logDir }));
  const [file] = readdirSync(logDir);
  return JSON.parse(readFileSync(join(logDir, file), "utf8"));
}

test("run log: the mode that actually picked, not the configured one", async () => {
  // AI ranking fails without throwing (every batch fails): the formula picked.
  let log = await runLog("ai", badRequest);
  assert.deepEqual([log.mode, log.configuredMode], ["formula", "ai"]);

  log = await runLog("ai", jsonAnswer({ ratings: [{ id: "new", fit: 8, reason: "fits" }] }));
  assert.deepEqual([log.mode, log.configuredMode], ["ai", "ai"]);

  // The agent fails, then AI ranking fails too: still the formula.
  log = await runLog("agent", badRequest);
  assert.deepEqual([log.mode, log.configuredMode], ["formula", "agent"]);

  // The agent proposes a small digest, is sent back once, and confirms it by resubmitting.
  log = await runLog("agent", toolCall("propose_selection", { video_ids: ["new"], reasons: [{ id: "new", why: "fits" }], intro: "Hi" }));
  assert.deepEqual([log.mode, log.configuredMode], ["agent", "agent"]);
});

test("a request Claude couldn't read isn't used up, and the digest says it wasn't applied", async () => {
  const app = { ...loadAppConfig(), mode: "formula" as const };
  const opts = { dryRun: false, noSummaries: true, logDir: mkdtempSync(join(tmpdir(), "runlog-")) };
  const st = state({ requests: [{ id: 7, text: "only 10 min", at: "" }] });

  let { store, digests } = fakeStore();
  claudeAnswer = badRequest;
  telegramSent.length = 0;
  await captureLogs(() => runUser(app, store, st, 0, [v("new", "UCmine")], opts));
  assert.equal(digests[0].lastRequestId, null); // kept for the next digest
  assert.match(telegramSent[0].text, /couldn't read your message/);

  // Read fine: used up, and no warning.
  ({ store, digests } = fakeStore());
  claudeAnswer = jsonAnswer({ budget_minutes: 10, shorts_share: -1, avoid: [], prefer: [], skip_today: false, deliver_at: "", daily_time: "", summary: "10 min" });
  telegramSent.length = 0;
  await captureLogs(() => runUser(app, store, st, 0, [v("new", "UCmine")], opts));
  assert.equal(digests[0].lastRequestId, 7);
  assert.doesNotMatch(telegramSent[0].text, /couldn't read/);
});
