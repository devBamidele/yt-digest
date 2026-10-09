import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, escapeHtml, formatDigest, keyboard } from "../src/deliver.ts";
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

test("header, one message per video (long-form first) with its own buttons, then the total", () => {
  const picked = [vid(2, "short"), vid(1, "long")];
  const msgs = formatDigest(sel(picked), picked, 60, "Thu 8 Oct");
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0].text, "📺 <b>Your YouTube digest</b>\nThu 8 Oct · 60 min\n\n🎬 1 video · 10:00   ⚡ 1 short · 0:45");
  assert.equal(msgs[0].video, undefined);
  assert.equal(msgs[1].video?.videoId, "id1");
  assert.equal(msgs[1].text, `🎬 <b>1. <a href="https://youtu.be/id1">Title 1</a></b>\nCreator 1 · 10:00\n\nSummary 1.`);
  assert.match(msgs[2].text, /^⚡ <b>2\./);
  assert.match(msgs[3].text, /^⏱ <b>Total: 10:45 of 60 min<\/b>/);
  assert.equal(msgs[3].video, undefined);
});

test("titles are HTML-escaped so Telegram doesn't reject the message", () => {
  assert.equal(escapeHtml(`Tom & Jerry <3 "hi"`), `Tom &amp; Jerry &lt;3 "hi"`);
  const picked = [vid(1, "long", { title: "A <b> & C" })];
  assert.match(formatDigest(sel(picked), picked, 60, "d")[1].text, /A &lt;b&gt; &amp; C/);
});

test("every message fits Telegram's 4096-char limit", () => {
  const picked = Array.from({ length: 60 }, (_, i) => vid(i, i % 2 ? "short" : "long", { title: "t".repeat(100), summary: "x".repeat(400) }));
  const msgs = formatDigest(sel(picked), picked, 120, "d");
  assert.equal(msgs.length, 62);
  for (const m of msgs) assert.ok(m.text.length <= 4096);
});

test("empty day sends just the note", () => {
  const msgs = formatDigest(sel([], "No new videos today."), [], 60, "d");
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /No new videos today\./);
});

test("buttons: one 👍/👎 row per video, payload fits Telegram's 64 bytes and round-trips", () => {
  const v = vid(1, "long", { videoId: "abcdefghij1", channelId: "UCsBjURrPoezykLs9EqgamOA" });
  const kb = keyboard(v);
  assert.deepEqual(kb.inline_keyboard.map((r) => r.map((b) => b.text)), [["👍", "👎"]]);
  const data = kb.inline_keyboard[0][1].callback_data;
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.equal(data, "d|abcdefghij1|UCsBjURrPoezykLs9EqgamOA"); // what the worker splits on "|"
});

test("header: intro, request and feedback each get their own block; empty kinds are left out", () => {
  const picked = Array.from({ length: 30 }, (_, i) => vid(i, "short", { durationSeconds: 85 }));
  const [{ text }] = formatDigest(sel(picked), picked, 45, "Thu 8 Oct", {
    intro: "Tonight is mostly comedy.",
    request: "45 min, only shorts, funny content",
    taps: { up: 4, down: 4 },
  });
  assert.equal(
    text,
    [
      "📺 <b>Your YouTube digest</b>\nThu 8 Oct · 45 min",
      "<i>Tonight is mostly comedy.</i>",
      "🎯 Tonight: 45 min, only shorts, funny content (as you asked)\n🙏 Got your feedback: 4 👍, 4 👎. Thanks!",
      "⚡ 30 shorts · 42:30",
    ].join("\n\n"),
  );
  // No taps and no request: those lines don't appear at all.
  assert.doesNotMatch(formatDigest(sel(picked), picked, 45, "d", { taps: { up: 0, down: 0 } })[0].text, /Got your feedback|Tonight:/);
});

test("delivery marks each video as soon as its message is sent, and stops at a failure", async () => {
  const picked = [vid(1, "long"), vid(2, "long"), vid(3, "long")];
  const msgs = formatDigest(sel(picked), picked, 60, "d");
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "1";
  const realFetch = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const fail = (body.text ?? body.caption).includes("Title 2");
    return { status: fail ? 400 : 200, json: async () => (fail ? { ok: false, description: "boom" } : { ok: true }) };
  }) as any;
  const delivered: string[] = [];
  try {
    await assert.rejects(deliver(msgs, (v) => delivered.push(v.videoId)), /boom/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(delivered, ["id1"]); // id2 failed, id3 never sent: both stay eligible tomorrow
  assert.equal(sent[0].disable_notification, false); // header notifies
  assert.equal(sent[1].disable_notification, true); // the rest are silent
  assert.ok(sent[1].reply_markup.inline_keyboard);
  assert.equal(sent[1].photo, "https://i.ytimg.com/vi/id1/mqdefault.jpg"); // video as thumbnail + caption
  assert.match(sent[1].caption, /Title 1/);
});

test("titles lose trailing hashtags, but hashtags mid-title and all-hashtag titles stay", async () => {
  const { cleanTitle } = await import("../src/deliver.ts");
  assert.equal(cleanTitle("Reverse Engineering Games #ai #meme #comedy #gaming #mod"), "Reverse Engineering Games");
  assert.equal(cleanTitle("Try Not To Laugh Pt. 840😹🤣😂#ifyoulaughyoulose#dontlaughchallenge"), "Try Not To Laugh Pt. 840😹🤣😂");
  assert.equal(cleanTitle("The #1 Street Food in NYC"), "The #1 Street Food in NYC");
  assert.equal(cleanTitle("#shorts #funny"), "#shorts #funny");
});

test("a video whose thumbnail fails is sent as a text message instead", async () => {
  const v = vid(7, "long");
  const [, m] = formatDigest(sel([v]), [v], 60, "d");
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "1";
  const realFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const method = url.split("/").pop()!;
    methods.push(method);
    const ok = method !== "sendPhoto";
    return { status: ok ? 200 : 400, json: async () => (ok ? { ok: true } : { ok: false, description: "failed to get HTTP URL content" }) };
  }) as any;
  try {
    const { sendVideo } = await import("../src/deliver.ts");
    assert.equal(await sendVideo(m as any, { log: () => {} }), "text");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(methods, ["sendPhoto", "sendMessage"]);
});
