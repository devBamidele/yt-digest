// Saves a varied sample of real candidates to evals/fixtures/videos.json for hand-labelling.
// Set "worth_watching" to true/false on each video, then run the eval.
//   npm run fixtures:collect [-- --count 25] [-- --force]
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { addStats, fetchUploads } from "../src/fetch.ts";
import { classify } from "../src/classify.ts";
import { score } from "../src/score.ts";
import type { Video } from "../src/types.ts";

try {
  process.loadEnvFile();
} catch {}

export const FIXTURES_PATH = "evals/fixtures/videos.json";

export interface Fixture {
  worth_watching: boolean | null; // ← fill this in
  url: string;
  collectedAt: string; // scores are computed as of this time
  video: Video;
}

/** Evenly spaced picks across the score ranking, so the sample has good, middling and weak videos. */
function spread<T>(sorted: T[], n: number): T[] {
  if (sorted.length <= n) return sorted;
  return Array.from({ length: n }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (n - 1))]);
}

export function sample(videos: Video[], count: number, shortsRatio: number): Video[] {
  // One video per creator (their best), so the sample covers many channels.
  const best = new Map<string, Video>();
  for (const v of videos) {
    const cur = best.get(v.channelId);
    if (!cur || (v.score ?? 0) > (cur.score ?? 0)) best.set(v.channelId, v);
  }
  const byScore = [...best.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const nShorts = Math.round(count * shortsRatio);
  return [
    ...spread(byScore.filter((v) => v.kind === "short"), nShorts),
    ...spread(byScore.filter((v) => v.kind === "long"), count - nShorts),
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: { count: { type: "string", default: "25" }, force: { type: "boolean", default: false } },
  });
  if (existsSync(FIXTURES_PATH) && !values.force) {
    console.error(`✗ ${FIXTURES_PATH} already exists (it may have your labels). Use --force to overwrite.`);
    process.exit(1);
  }

  const cfg = loadConfig();
  const now = new Date();
  const since = new Date(now.getTime() - cfg.backlogDays * 86400_000);
  console.log(`Fetching uploads from ${cfg.creators.length} creators…`);
  const videos = score(classify(await addStats(await fetchUploads(cfg, since, () => {})), cfg.shortsMaxSeconds), now);

  const fixtures: Fixture[] = sample(videos, Number(values.count), cfg.shortsRatio).map((v) => ({
    worth_watching: null,
    url: `https://youtu.be/${v.videoId}`,
    collectedAt: now.toISOString(),
    video: v,
  }));

  mkdirSync("evals/fixtures", { recursive: true });
  writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2) + "\n");
  console.log(`Saved ${fixtures.length} videos to ${FIXTURES_PATH}:`);
  for (const f of fixtures) console.log(`  ${f.video.kind === "short" ? "S" : "L"} ${f.video.creator} | ${f.video.title}`);
}
