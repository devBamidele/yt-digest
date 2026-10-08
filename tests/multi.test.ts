import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAppConfig } from "../src/config.ts";
import { runUser } from "../src/multi.ts";
import type { UserState } from "../src/store.ts";
import type { Video } from "../src/types.ts";

const v = (id: string, channelId: string, kind: "short" | "long" = "long"): Video => ({
  videoId: id, title: id, description: "", publishedAt: new Date(Date.now() - 3600_000).toISOString(), channelId, creator: "?",
  priorityWeight: 1, views: 1000, subscriberCount: 10_000, durationSeconds: kind === "short" ? 50 : 300, kind,
});
const state = (over: Partial<UserState> = {}): UserState => ({
  user: { chat_id: "9", name: "T", status: "active", timezone: "Africa/Lagos", delivery_hour: 18, budget_minutes: 30, shorts_ratio: 0.4, is_owner: 0, last_digest_at: null },
  creators: [{ id: "UCmine", name: "Mine" }],
  votes: [], sent: [{ video_id: "old", at: new Date().toISOString() }], requests: [],
  taste: { notes: "", learned: "", votes_used: 0 }, agentNotes: [], ratings: [],
  ...over,
});
const fakeStore = () => {
  const calls: string[] = [];
  return { calls, store: { addCost: async () => void calls.push("addCost"), recordDigest: async () => void calls.push("recordDigest") } as any };
};

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
