import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeIntoConfig, subsFromCsv } from "../src/import-subs.ts";

test("Takeout CSV parses, including quoted names", () => {
  const csv = `Channel Id,Channel Url,Channel Title
UCsBjURrPoezykLs9EqgamOA,http://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA,Fireship
UCHnyfMqiRRG1u-2MsSQLbXA,http://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA,"Veritasium, Derek"
`;
  assert.deepEqual(subsFromCsv(csv), [
    { id: "UCsBjURrPoezykLs9EqgamOA", name: "Fireship" },
    { id: "UCHnyfMqiRRG1u-2MsSQLbXA", name: "Veritasium, Derek" },
  ]);
});

test("merge keeps existing entries, weights and comments; adds only new ones", () => {
  const yaml = `# my config
daily_budget_minutes: 60
creators:
  - id: UCsBjURrPoezykLs9EqgamOA   # Fireship
    name: Fireship
    priority_weight: 1.5
`;
  const { text, added } = mergeIntoConfig(yaml, [
    { id: "UCsBjURrPoezykLs9EqgamOA", name: "Fireship" },
    { id: "UCHnyfMqiRRG1u-2MsSQLbXA", name: "Veritasium" },
  ]);
  assert.deepEqual(added.map((s) => s.name), ["Veritasium"]);
  assert.match(text, /# my config/);
  assert.match(text, /# Fireship/);
  assert.match(text, /priority_weight: 1.5/);
  assert.match(text, /- id: UCHnyfMqiRRG1u-2MsSQLbXA\n    name: Veritasium/);
});
