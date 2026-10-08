// Runs the scorer + selector on the labelled fixtures and reports agreement with my labels.
// Fails (exit 1) if any selection exceeds its budget.
//   npm run eval:select
import { readFileSync } from "node:fs";
import { evalConfig } from "./eval-config.ts";
import { scoreVideo } from "../src/score.ts";
import { fmtDuration, select } from "../src/select.ts";
import { FIXTURES_PATH, type Fixture } from "./collect-fixtures.ts";

const BUDGETS = [30, 60, 90, 120];
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

const cfg = evalConfig();
const fixtures: Fixture[] = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));
const labelled = fixtures.filter((f) => typeof f.worth_watching === "boolean");
const label = new Map(labelled.map((f) => [f.video.videoId, f.worth_watching]));
// Re-score as of collection time, so changes to the formula show up here.
const videos = labelled.map((f) => ({ ...f.video, score: scoreVideo(f.video, new Date(f.collectedAt)) }));
const yes = videos.filter((v) => label.get(v.videoId));
const no = videos.filter((v) => !label.get(v.videoId));

console.log(`${labelled.length}/${fixtures.length} fixtures labelled (${yes.length} yes, ${no.length} no)`);
if (labelled.length === 0) {
  console.log(`Label some videos in ${FIXTURES_PATH} first (set "worth_watching" to true or false).`);
  process.exit(0);
}

// 1. Ranking: how often does a "yes" video score above a "no" video? (50% = coin flip.)
let wins = 0;
for (const y of yes) for (const n of no) wins += y.score! > n.score! ? 1 : y.score === n.score ? 0.5 : 0;
console.log(`\nRanking: a "yes" outscores a "no" in ${pct(wins, yes.length * no.length)} of pairs (50% = random)`);

// 2. Selection at each budget.
let failed = false;
console.log(`\nbudget | picked | time      | agree | picks you'd watch | your yeses picked`);
for (const budget of BUDGETS) {
  const sel = select(videos, budget, cfg.shortsRatio, cfg);
  const over = sel.totalSeconds > budget * 60;
  failed ||= over;
  const agree = videos.filter((v) => sel.picked.some((p) => p.videoId === v.videoId) === label.get(v.videoId)).length;
  const goodPicks = sel.picked.filter((v) => label.get(v.videoId)).length;
  console.log(
    `${String(budget).padStart(4)}m  | ${String(sel.picked.length).padStart(6)} | ${fmtDuration(sel.totalSeconds).padEnd(9)} | ` +
      `${pct(agree, videos.length).padStart(5)} | ${pct(goodPicks, sel.picked.length).padStart(17)} | ` +
      `${pct(goodPicks, yes.length).padStart(17)}${over ? "  ✗ OVER BUDGET" : ""}`,
  );
}

// 3. Biggest disagreements, to see what the formula gets wrong.
const ranked = [...videos].sort((a, b) => b.score! - a.score!);
const show = (v: (typeof videos)[number]) =>
  `    #${ranked.indexOf(v) + 1} ${v.kind} ${fmtDuration(v.durationSeconds!)} | ${v.creator} | ${v.title.slice(0, 70)}`;
console.log(`\n"No" videos the formula ranks highest:`);
ranked.filter((v) => !label.get(v.videoId)).slice(0, 3).forEach((v) => console.log(show(v)));
console.log(`"Yes" videos the formula ranks lowest:`);
ranked.filter((v) => label.get(v.videoId)).slice(-3).reverse().forEach((v) => console.log(show(v)));

if (failed) {
  console.error("\n✗ FAIL: a selection exceeded its budget");
  process.exit(1);
}
console.log("\n✓ Budget never exceeded");
