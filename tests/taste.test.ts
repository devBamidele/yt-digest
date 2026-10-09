import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLearned, tasteText } from "../src/taste.ts";

test("the profile Claude sees: notes first, then what was learned, without HTML comments", () => {
  const learned = renderLearned({ likes: ["quick science facts"], dislikes: ["wealth-mindset clips"], tentative: [], summary: "S." }, 22);
  assert.match(learned, /<!-- .*from 22 votes/);
  assert.match(learned, /\*\*Likes\*\*\n- quick science facts/);
  assert.match(learned, /\*\*Tentative \(one vote so far\)\*\*\n- \(none yet\)/);
  const t = tasteText("No crypto, ever.", learned);
  assert.match(t, /^My own notes:\nNo crypto, ever\.\n\nLearned from my feedback:\nS\./);
  assert.doesNotMatch(t, /<!--/);
});

test("empty profile reads as none / nothing yet", () => {
  assert.equal(tasteText("", ""), "My own notes:\n(none)\n\nLearned from my feedback:\n(nothing yet)");
});
