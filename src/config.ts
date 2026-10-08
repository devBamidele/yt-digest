// Step 1: load creators.yaml, validate it, apply per-run overrides.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Config } from "./types.ts";

export function parseConfig(text: string, budgetOverride?: number): Config {
  const raw = parse(text) ?? {};

  const cfg: Config = {
    budgetMinutes: budgetOverride ?? raw.daily_budget_minutes ?? 60,
    shortsRatio: raw.shorts_ratio ?? 0.3,
    shortsMaxSeconds: raw.shorts_max_seconds ?? 180,
    backlogDays: raw.backlog_days ?? 7,
    maxPerCreator: raw.max_per_creator ?? 2,
    maxVideoMinutes: raw.max_video_minutes ?? 60,
    maxVideoShare: raw.max_video_share ?? 0.5,
    summaryModel: raw.summary_model ?? "claude-sonnet-5-5",
    creators: [],
  };

  if (!(typeof cfg.budgetMinutes === "number" && cfg.budgetMinutes > 0)) {
    throw new Error(`budget must be a positive number of minutes, got ${cfg.budgetMinutes}`);
  }
  if (!(typeof cfg.shortsRatio === "number" && cfg.shortsRatio >= 0 && cfg.shortsRatio <= 1)) {
    throw new Error(`shorts_ratio must be between 0 and 1, got ${cfg.shortsRatio}`);
  }
  if (!(typeof cfg.backlogDays === "number" && cfg.backlogDays > 0)) {
    throw new Error(`backlog_days must be a positive number, got ${cfg.backlogDays}`);
  }
  if (!(Number.isInteger(cfg.maxPerCreator) && cfg.maxPerCreator > 0)) {
    throw new Error(`max_per_creator must be a positive whole number, got ${cfg.maxPerCreator}`);
  }
  if (!(typeof cfg.maxVideoMinutes === "number" && cfg.maxVideoMinutes > 0)) {
    throw new Error(`max_video_minutes must be a positive number, got ${cfg.maxVideoMinutes}`);
  }
  if (!(typeof cfg.maxVideoShare === "number" && cfg.maxVideoShare > 0 && cfg.maxVideoShare <= 1)) {
    throw new Error(`max_video_share must be between 0 and 1, got ${cfg.maxVideoShare}`);
  }
  if (!Array.isArray(raw.creators) || raw.creators.length === 0) {
    throw new Error("creators.yaml needs at least one creator");
  }

  for (const c of raw.creators) {
    if (typeof c?.id !== "string" || !/^UC[\w-]{22}$/.test(c.id)) {
      throw new Error(`creator ${JSON.stringify(c)} needs a channel id like UCxxxxxxxxxxxxxxxxxxxxxx`);
    }
    const weight = c.priority_weight ?? 1;
    if (typeof weight !== "number" || weight <= 0) {
      throw new Error(`creator ${c.id} has an invalid priority_weight: ${weight}`);
    }
    cfg.creators.push({ id: c.id, name: c.name ?? c.id, priorityWeight: weight });
  }
  return cfg;
}

export function loadConfig(path = "creators.yaml", budgetOverride?: number): Config {
  return parseConfig(readFileSync(path, "utf8"), budgetOverride);
}
