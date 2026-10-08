import { test } from "node:test";
import assert from "node:assert/strict";
import { applyUpdates, channelWeights, MAX_WEIGHT, MIN_WEIGHT, type FeedbackState } from "../src/feedback.ts";

const CH = "UCsBjURrPoezykLs9EqgamOA";
const tap = (update_id: number, data: string, chat = 42) => ({
  update_id,
  callback_query: { data, message: { chat: { id: chat }, date: 1_780_000_000 } },
});

test("taps from my chat are recorded; the latest tap on a video wins; offset advances", () => {
  const s: FeedbackState = { offset: 0, votes: {} };
  const counts = applyUpdates(s, [tap(10, `u|vid1abcdefg|${CH}`), tap(11, `d|vid1abcdefg|${CH}`), tap(12, `u|vid2abcdefg|${CH}`)], "42");
  assert.deepEqual(counts, { up: 2, down: 1 });
  assert.equal(s.votes.vid1abcdefg.vote, "down");
  assert.equal(s.offset, 13);
});

test("taps from other chats and junk payloads are ignored", () => {
  const s: FeedbackState = { offset: 0, votes: {} };
  applyUpdates(s, [tap(1, `u|vid1abcdefg|${CH}`, 999), tap(2, "hello"), { update_id: 3, message: { text: "hi" } }], "42");
  assert.deepEqual(s.votes, {});
  assert.equal(s.offset, 4);
});

test("channel weight = 1.5^(👍−👎), clamped", () => {
  const vote = (v: "up" | "down", ch = CH) => ({ vote: v, channelId: ch, at: "" });
  const s: FeedbackState = {
    offset: 0,
    votes: { a: vote("down"), b: vote("down"), c: vote("up"), d: vote("up", "UCother0000000000000000a") },
  };
  const w = channelWeights(s);
  assert.equal(w.get(CH)!.weight, 1 / 1.5); // 1 up, 2 down
  assert.equal(w.get("UCother0000000000000000a")!.weight, 1.5);
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`v${i}`, vote("down")]));
  assert.equal(channelWeights({ offset: 0, votes: many }).get(CH)!.weight, MIN_WEIGHT);
  const loved = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`v${i}`, vote("up")]));
  assert.equal(channelWeights({ offset: 0, votes: loved }).get(CH)!.weight, MAX_WEIGHT);
});
