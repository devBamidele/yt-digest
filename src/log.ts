// Writes one JSON log per run: what was fetched, scored, picked and dropped, and why.
import { mkdirSync, writeFileSync } from "node:fs";

export function lagosDate(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }); // YYYY-MM-DD
}

export function writeRunLog(entry: Record<string, unknown>, dir = "logs"): string {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${dir}/${lagosDate()}_${stamp}.json`;
  writeFileSync(path, JSON.stringify(entry, null, 2));
  return path;
}
