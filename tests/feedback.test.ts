import { test } from "node:test";
import assert from "node:assert/strict";
import { callbackData, MAX_WEIGHT, MIN_WEIGHT, weightsFromVotes } from "../src/feedback.ts";

const CH = "UCsBjURrPoezykLs9EqgamOA";
const vote = (v: "up" | "down", channelId = CH) => ({ vote: v, channelId });

test("channel weight = 1.5^(👍−👎), clamped", () => {
  const w = weightsFromVotes([vote("down"), vote("down"), vote("up"), vote("up", "UCother0000000000000000a")]);
  assert.equal(w.get(CH)!.weight, 1 / 1.5); // 1 up, 2 down
  assert.deepEqual([w.get(CH)!.up, w.get(CH)!.down], [1, 2]);
  assert.equal(w.get("UCother0000000000000000a")!.weight, 1.5);
  assert.equal(weightsFromVotes(Array.from({ length: 20 }, () => vote("down"))).get(CH)!.weight, MIN_WEIGHT);
  assert.equal(weightsFromVotes(Array.from({ length: 20 }, () => vote("up"))).get(CH)!.weight, MAX_WEIGHT);
});

test("button payload fits Telegram's 64 bytes", () => {
  const data = callbackData("up", "abcdefghij1", CH);
  assert.equal(data, `u|abcdefghij1|${CH}`);
  assert.ok(Buffer.byteLength(data) <= 64);
});
