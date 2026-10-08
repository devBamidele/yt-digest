import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackSummary, videoPrompt } from "../src/summarize.ts";
import type { Video } from "../src/types.ts";

const v = (description: string): Video => ({
  videoId: "x", title: "Why RAG fails", description, publishedAt: "", channelId: "UC", creator: "Small ML",
  priorityWeight: 1, durationSeconds: 754, kind: "long",
});

test("prompt carries channel, title, length and description", () => {
  const p = videoPrompt(v("Chunking matters more than the model."));
  assert.match(p, /<channel>Small ML<\/channel>/);
  assert.match(p, /<title>Why RAG fails<\/title>/);
  assert.match(p, /<length>12:34 \(long-form\)<\/length>/);
  assert.match(p, /Chunking matters more than the model\./);
  assert.match(videoPrompt(v("  ")), /\(no description\)/);
});

test("fallback uses the first non-link line of the description", () => {
  assert.equal(fallbackSummary(v("https://sponsor.link\n\nA deep dive into chunking.\nMore")), "A deep dive into chunking.");
  assert.equal(fallbackSummary(v("")), "(No summary available.)");
});
