import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAppConfig, parseConfig } from "../src/config.ts";

const ID = "UCsBjURrPoezykLs9EqgamOA";

test("config.yaml loads app-wide defaults (no channels or personal settings)", () => {
  const cfg = loadAppConfig();
  assert.equal(cfg.mode, "agent");
  assert.ok(cfg.userDailyCapUsd > 0);
  assert.ok(!("creators" in cfg));
});

test("defaults apply", () => {
  const cfg = parseConfig(`creators:\n  - id: ${ID}`);
  assert.equal(cfg.budgetMinutes, 60);
  assert.equal(cfg.shortsRatio, 0.3);
  assert.equal(cfg.shortsMaxSeconds, 180);
  assert.equal(cfg.creators[0].priorityWeight, 1);
});

test("budget override wins", () => {
  const cfg = parseConfig(`daily_budget_minutes: 60\ncreators:\n  - id: ${ID}`, 30);
  assert.equal(cfg.budgetMinutes, 30);
});

test("bad values give clear errors", () => {
  assert.throws(() => parseConfig(`creators:\n  - id: mkbhd`), /channel id/);
  assert.throws(() => parseConfig(`shorts_ratio: 1.5\ncreators:\n  - id: ${ID}`), /shorts_ratio/);
  assert.throws(() => parseConfig(`creators:\n  - id: ${ID}`, 0), /budget/);
  assert.throws(() => parseConfig(`creators:\n  - id: ${ID}`, NaN), /budget/);
  assert.throws(() => parseConfig(`creators: []`), /at least one/);
});
