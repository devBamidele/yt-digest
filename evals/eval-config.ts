import { loadAppConfig } from "../src/config.ts";
import type { Config } from "../src/types.ts";

/** Eval settings: app defaults from config.yaml plus a fixed 60 min / 40% shorts. */
export function evalConfig(): Config {
  return { ...loadAppConfig(), budgetMinutes: 60, shortsRatio: 0.4, creators: [] };
}
