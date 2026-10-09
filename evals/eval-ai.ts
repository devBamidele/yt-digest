// Compares the plain formula with AI taste ranking (and, with --agent, the agent) on my labelled fixtures.
// The taste profile is built only from my 👍/👎 taps, never from these labels, so the test is fair.
// Fails (exit 1) if any selection exceeds its budget.
//   npm run eval:ai [-- --agent]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Store } from "../src/store.ts";
import { evalConfig } from "./eval-config.ts";
import { scoreVideo } from "../src/score.ts";
import { fmtDuration, select } from "../src/select.ts";
import { blend, rateUncached } from "../src/rank.ts";
import { weightsFromVotes } from "../src/feedback.ts";
import { evidenceFor, learnTaste, renderLearned, tasteText } from "../src/taste.ts";
import type { Video } from "../src/types.ts";
import { FIXTURES_PATH, type Fixture } from "./collect-fixtures.ts";

try {
  process.loadEnvFile();
} catch {}

const BUDGETS = [30, 60, 90, 120];
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
const { values } = parseArgs({ options: { agent: { type: "boolean", default: false } } });

const cfg = evalConfig();
const fixtures: Fixture[] = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));
const labelled = fixtures.filter((f) => typeof f.worth_watching === "boolean");
const label = new Map(labelled.map((f) => [f.video.videoId, f.worth_watching as boolean]));
const videos: Video[] = labelled.map((f) => ({ ...f.video, score: scoreVideo(f.video, new Date(f.collectedAt)) }));

// 1. Taste profile from taps only, excluding any tap on a fixture video.
// The owner's 👍/👎 from the database.
const { state } = await new Store().state(process.env.TELEGRAM_CHAT_ID ?? "");
const evidence = (await evidenceFor(state.votes.map((v) => ({ videoId: v.video_id, vote: v.vote })))).filter(
  (e) => !videos.some((v) => v.title === e.title),
);
console.log(`Building a taste profile from ${evidence.length} taps (none of them on the ${videos.length} labelled videos)…`);
const learned = await learnTaste(evidence, "", cfg.aiModel);
const taste = tasteText("", renderLearned(learned, evidence.length));

// 2. AI ratings for the labelled videos.
const { ratings } = await rateUncached(videos, taste, "", cfg.aiModel);

// 3. Ranking quality: how often does a "yes" video rank above a "no"? (50% = coin flip)
function pairwise(scoreOf: (v: Video) => number) {
  const yes = videos.filter((v) => label.get(v.videoId));
  const no = videos.filter((v) => !label.get(v.videoId));
  let wins = 0;
  for (const y of yes) for (const n of no) wins += scoreOf(y) > scoreOf(n) ? 1 : scoreOf(y) === scoreOf(n) ? 0.5 : 0;
  return pct(wins, yes.length * no.length);
}
const { eligible, rejected } = blend(videos, ratings, cfg);
const blended = new Map(eligible.map((v) => [v.videoId, v.score!]));
console.log(`\nRanking: a "yes" outranks a "no" in…`);
console.log(`  formula only        ${pairwise((v) => v.score!)}`);
console.log(`  AI fit only         ${pairwise((v) => ratings.get(v.videoId)?.fit ?? 5)}`);
console.log(`  blend (ai_weight ${cfg.aiWeight}) ${pairwise((v) => blended.get(v.videoId) ?? -1)}`);
console.log(`  (AI dropped ${rejected.length} as below min_fit ${cfg.minFit}: ${rejected.filter((v) => !label.get(v.videoId)).length} were your "no"s)`);

// 4. Selection at each budget.
type Picker = (budget: number) => Promise<Video[]>;
const pickers: [string, Picker][] = [
  ["formula", async (b) => select(videos, b, cfg.shortsRatio, cfg).picked],
  ["ai", async (b) => select(eligible, b, cfg.shortsRatio, cfg).picked],
];
if (values.agent) {
  const { runAgent } = await import("../src/agent.ts");
  pickers.push([
    "agent",
    async (b) => {
      const r = await runAgent({
        candidates: videos,
        cfg: { ...cfg, budgetMinutes: b },
        taste,
        request: "",
        dryRun: true,
        log: () => {},
        notes: [], // no saved agent notes: the eval starts clean
        weights: weightsFromVotes(state.votes.map((v) => ({ channelId: v.channel_id, vote: v.vote }))),
      });
      return r.picked;
    },
  ]);
}

let failed = false;
console.log(`\n${"picker".padEnd(8)}| budget | picked | time      | picks you'd watch | your yeses picked`);
const yesCount = videos.filter((v) => label.get(v.videoId)).length;
for (const [name, pick] of pickers) {
  for (const b of BUDGETS) {
    const picked = await pick(b);
    const total = picked.reduce((a, v) => a + (v.durationSeconds ?? 0), 0);
    const over = total > b * 60;
    failed ||= over;
    const good = picked.filter((v) => label.get(v.videoId)).length;
    console.log(
      `${name.padEnd(8)}| ${String(b).padStart(5)}m | ${String(picked.length).padStart(6)} | ${fmtDuration(total).padEnd(9)} | ` +
        `${pct(good, picked.length).padStart(17)} | ${pct(good, yesCount).padStart(17)}${over ? "  ✗ OVER BUDGET" : ""}`,
    );
  }
}

console.log(`\nAI fit per labelled video:`);
for (const v of [...videos].sort((a, b) => (ratings.get(b.videoId)?.fit ?? 0) - (ratings.get(a.videoId)?.fit ?? 0))) {
  const r = ratings.get(v.videoId);
  console.log(`  ${label.get(v.videoId) ? "yes" : "no "} fit ${String(r?.fit ?? "?").padStart(2)} | ${v.creator} | ${v.title.slice(0, 45)} | ${r?.reason ?? ""}`);
}

if (failed) {
  console.error("\n✗ FAIL: a selection exceeded its budget");
  process.exit(1);
}
console.log("\n✓ Budget never exceeded");
