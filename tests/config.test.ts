import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAppConfig, parseAppConfig } from "../src/config.ts";

test("config.yaml loads app-wide settings (no channels or personal settings)", () => {
  const cfg = loadAppConfig();
  assert.equal(cfg.mode, "agent");
  assert.ok(cfg.userDailyCapUsd > 0);
  assert.ok(!("creators" in cfg) && !("budgetMinutes" in cfg));
});

test("missing settings get their defaults", () => {
  const cfg = parseAppConfig("");
  assert.deepEqual([cfg.shortsMaxSeconds, cfg.maxPerCreator, cfg.maxVideoShare, cfg.mode], [180, 2, 0.5, "agent"]);
});

test("bad values give clear errors", () => {
  assert.throws(() => parseAppConfig("max_video_share: 1.5"), /max_video_share/);
  assert.throws(() => parseAppConfig("max_per_creator: 1.5"), /max_per_creator/);
  assert.throws(() => parseAppConfig("mode: magic"), /mode must be/);
  assert.throws(() => parseAppConfig("user_daily_cap_usd: -1"), /user_daily_cap_usd/);
});
