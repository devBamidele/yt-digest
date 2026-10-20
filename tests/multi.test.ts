import { test } from "node:test";
import assert from "node:assert/strict";
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
  const store = {
    addCost: async () => void calls.push("addCost"),
    recordDigest: async () => void calls.push("recordDigest"),
    saveRatings: async () => void calls.push("saveRatings"),
    summaryStore: () => ({ get: async () => ({}), put: async () => {} }),
    alertOwner: async (key: string, text: string) => void alerts.push({ key, text }),
  };
  return { calls, alerts, store: store as any };
};

// Stand-in for the Claude API. The SDK client keeps the fetch it first saw, so install one stand-in
// up front and switch what it answers.
process.env.ANTHROPIC_API_KEY ||= "test";
let claudeAnswer: () => Response = () => new Response("no Claude in this test", { status: 500 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) =>
  String(url).includes("api.anthropic.com") ? claudeAnswer() : realFetch(url, init)) as any;
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
