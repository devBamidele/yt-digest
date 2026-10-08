import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, formatDigest, keyboard } from "../src/deliver.ts";
import { parseCallback } from "../src/feedback.ts";
import type { Selection } from "../src/select.ts";
import type { Video } from "../src/types.ts";

const vid = (i: number, kind: "short" | "long", over: Partial<Video> = {}): Video => ({
  videoId: `id${i}`, title: `Title ${i}`, description: "", publishedAt: "", channelId: "UC", creator: `Creator ${i}`,
  priorityWeight: 1, durationSeconds: kind === "short" ? 45 : 600, kind, summary: `Summary ${i}.`, ...over,
});
const sel = (picked: Video[], note?: string): Selection => ({
  picked, dropped: [], note, budgetSeconds: 3600, shortsBudgetSeconds: 1440,
  totalSeconds: picked.reduce((a, v) => a + v.durationSeconds!, 0),
});

test("digest has sections, links, summaries and the total at the bottom", () => {
  const picked = [vid(1, "long"), vid(2, "short")];
  const [{ text: msg }] = formatDigest(sel(picked), picked, 60, "Thu 8 Oct");
  assert.match(msg, /^📺 <b>Your YouTube digest<\/b> · Thu 8 Oct · 60 min/);
  assert.ok(msg.indexOf("🎬") < msg.indexOf("⚡"), "videos before shorts");
  assert.match(msg, /<a href="https:\/\/youtu.be\/id1">Title 1<\/a>/);
  assert.match(msg, /Creator 2 · 0:45\nSummary 2\./);
  assert.match(msg, /⏱ <b>Total: 10:45 of 60 min<\/b> · 1 videos \(10:00\) \+ 1 shorts \(0:45\)\n/);
});

test("titles are HTML-escaped so Telegram doesn't reject the message", () => {
  assert.equal(escapeHtml(`Tom & Jerry <3 "hi"`), `Tom &amp; Jerry &lt;3 "hi"`);
  const picked = [vid(1, "long", { title: "A <b> & C" })];
  assert.match(formatDigest(sel(picked), picked, 60, "d")[0].text, /A &lt;b&gt; &amp; C/);
});

test("long digests split into messages under Telegram's 4096-char limit, keeping every item", () => {
  const picked = Array.from({ length: 60 }, (_, i) => vid(i, i % 2 ? "short" : "long", { summary: "x".repeat(200) }));
  const msgs = formatDigest(sel(picked), picked, 120, "d");
  assert.ok(msgs.length > 1);
  for (const m of msgs) assert.ok(m.text.length <= 4096, `message is ${m.text.length} chars`);
  for (const v of picked) assert.ok(msgs.some((m) => m.text.includes(`youtu.be/${v.videoId}"`)));
  assert.match(msgs.at(-1)!.text, /⏱ <b>Total/);
  // Every video gets buttons, on the same message that lists it.
  assert.equal(msgs.reduce((a, m) => a + m.items.length, 0), 60);
  for (const m of msgs) for (const { video } of m.items) assert.ok(m.text.includes(`youtu.be/${video.videoId}"`));
});

test("empty day sends the note", () => {
  assert.match(formatDigest(sel([], "No new videos today."), [], 60, "d")[0].text, /No new videos today\./);
});

test("buttons: numbered 👍/👎 per video, 4 per row, payload fits Telegram's 64 bytes and round-trips", () => {
  const picked = [1, 2, 3].map((i) => vid(i, "long", { videoId: `abcdefghij${i}`, channelId: "UCsBjURrPoezykLs9EqgamOA" }));
  const kb = keyboard(picked.map((video, i) => ({ n: i + 1, video })));
  assert.deepEqual(kb.inline_keyboard.map((r) => r.map((b) => b.text)), [["1 👍", "1 👎", "2 👍", "2 👎"], ["3 👍", "3 👎"]]);
  const data = kb.inline_keyboard[0][1].callback_data;
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.deepEqual(parseCallback(data), { vote: "down", videoId: "abcdefghij1", channelId: "UCsBjURrPoezykLs9EqgamOA" });
});

test("feedback line shows under the header", () => {
  const picked = [vid(1, "long")];
  assert.match(formatDigest(sel(picked), picked, 60, "d", "Got your feedback: 2 👍, 1 👎")[0].text, /<i>Got your feedback: 2 👍, 1 👎<\/i>/);
});
