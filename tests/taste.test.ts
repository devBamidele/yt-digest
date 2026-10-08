import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readTaste, renderLearned, tasteForPrompt, writeLearned } from "../src/taste.ts";

const tmp = () => `${mkdtempSync(`${tmpdir()}/taste-`)}/taste.md`;

test("rewriting the learned section never touches My notes", () => {
  const path = tmp();
  writeFileSync(path, `# Taste profile\n\n## My notes\nNo crypto, ever.\nLove Nigerian food.\n\n## Learned from your feedback\nold stuff\n`);
  writeLearned(renderLearned({ likes: ["quick science facts"], dislikes: ["wealth-mindset clips"], tentative: [], summary: "S." }, 22), path);
  const out = readFileSync(path, "utf8");
  assert.match(out, /## My notes\nNo crypto, ever\.\nLove Nigerian food\.\n\n## Learned from your feedback\n/);
  assert.doesNotMatch(out, /old stuff/);
  assert.match(out, /- quick science facts/);
  assert.equal(readTaste(path).votesUsed, 22);
});

test("prompt version drops HTML comments and includes both sections", () => {
  const path = tmp();
  writeFileSync(path, `## My notes\n<!-- hint -->\nNo crypto.\n\n## Learned from your feedback\n<!-- from 3 votes -->\nLikes cooking.\n`);
  const p = tasteForPrompt(path);
  assert.doesNotMatch(p, /hint|<!--/);
  assert.match(p, /My own notes:\nNo crypto\./);
  assert.match(p, /Learned from my feedback:\nLikes cooking\./);
});

test("a missing file reads as an empty template", () => {
  const t = readTaste(`${tmp()}-missing`);
  assert.equal(t.votesUsed, 0);
  assert.match(t.full, /## My notes/);
});
