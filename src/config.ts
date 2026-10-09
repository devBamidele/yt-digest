// App-wide settings from config.yaml. Personal settings (channels, watch time, shorts mix,
// delivery time) live per user in D1; multi.ts builds each user's Config from both.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Config } from "./types.ts";

export interface AppConfig extends Omit<Config, "creators" | "budgetMinutes" | "shortsRatio"> {
  userDailyCapUsd: number;
}

/** Parses and validates config.yaml text; anything missing gets its default. */
export function parseAppConfig(text: string): AppConfig {
  const raw = parse(text) ?? {};
  const cfg: AppConfig = {
    shortsMaxSeconds: raw.shorts_max_seconds ?? 180,
    backlogDays: raw.backlog_days ?? 7,
    maxPerCreator: raw.max_per_creator ?? 2,
    maxVideoMinutes: raw.max_video_minutes ?? 60,
    maxVideoShare: raw.max_video_share ?? 0.5,
    summaryModel: raw.summary_model ?? "claude-sonnet-5-5",
    mode: raw.mode ?? "agent",
    aiModel: raw.ai_model ?? "claude-opus-5-5",
    aiShortlist: raw.ai_shortlist ?? 120,
    aiWeight: raw.ai_weight ?? 0.7,
    minFit: raw.min_fit ?? 4,
    agentMaxToolCalls: raw.agent_max_tool_calls ?? 20,
    userDailyCapUsd: raw.user_daily_cap_usd ?? 0.4,
  };

  const check = (ok: boolean, msg: string) => {
    if (!ok) throw new Error(`config.yaml: ${msg}`);
  };
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  check(num(cfg.backlogDays) && cfg.backlogDays > 0, `backlog_days must be a positive number, got ${cfg.backlogDays}`);
  check(Number.isInteger(cfg.maxPerCreator) && cfg.maxPerCreator > 0, `max_per_creator must be a positive whole number, got ${cfg.maxPerCreator}`);
  check(num(cfg.maxVideoMinutes) && cfg.maxVideoMinutes > 0, `max_video_minutes must be a positive number, got ${cfg.maxVideoMinutes}`);
  check(num(cfg.maxVideoShare) && cfg.maxVideoShare > 0 && cfg.maxVideoShare <= 1, `max_video_share must be between 0 and 1, got ${cfg.maxVideoShare}`);
  check(["formula", "ai", "agent"].includes(cfg.mode), `mode must be formula, ai or agent, got ${cfg.mode}`);
  check(num(cfg.aiWeight) && cfg.aiWeight >= 0 && cfg.aiWeight <= 1, `ai_weight must be between 0 and 1, got ${cfg.aiWeight}`);
  check(num(cfg.userDailyCapUsd) && cfg.userDailyCapUsd >= 0, `user_daily_cap_usd must be a number ≥ 0, got ${cfg.userDailyCapUsd}`);
  return cfg;
}

export function loadAppConfig(path = "config.yaml"): AppConfig {
  return parseAppConfig(readFileSync(path, "utf8"));
}
