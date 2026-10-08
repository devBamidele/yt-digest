// Runs the digest pipeline. Steps are added here as they are built.
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { addStats, fetchUploads } from "./fetch.ts";
import { classify } from "./classify.ts";
import { score } from "./score.ts";
import { fmtDuration, select } from "./select.ts";
import { writeRunLog } from "./log.ts";
import { loadSent, markSent, saveSent, unsent } from "./sent.ts";
import { summarize } from "./summarize.ts";
import { deliver, formatDigest } from "./deliver.ts";
import { lagosDate } from "./log.ts";

// Local runs read secrets from .env; in CI they come from the environment.
try {
  process.loadEnvFile();
} catch {}

const HELP = `Usage: npm run digest -- [options]

  --budget <min>   time budget for this run in minutes (default: creators.yaml)
  --hours <n>      look back this many hours for uploads (default: backlog_days from creators.yaml)
  --no-summaries   skip Claude summaries (free test runs)
  --dry-run        print the Telegram message instead of sending it (nothing is marked as sent)
  --config <path>  config file (default: creators.yaml)
  --help           show this message`;

const { values } = parseArgs({
  options: {
    budget: { type: "string" },
    hours: { type: "string" },
    config: { type: "string", default: "creators.yaml" },
    "no-summaries": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const budget = values.budget === undefined ? undefined : Number(values.budget);
const cfg = loadConfig(values.config, budget);

console.log(
  `${cfg.creators.length} creators | budget: ${cfg.budgetMinutes} min | ` +
    `mix: ${Math.round(cfg.shortsRatio * 100)}% shorts / ${Math.round((1 - cfg.shortsRatio) * 100)}% long-form`,
);

const hours = values.hours === undefined ? cfg.backlogDays * 24 : Number(values.hours);
const since = new Date(Date.now() - hours * 3600_000);
console.log(`\nFetching uploads since ${since.toISOString()}`);
let videos = await fetchUploads(cfg, since);

const fetched = videos.length;
const sent = loadSent();
videos = unsent(videos, sent);
const alreadySent = fetched - videos.length;
console.log(`${fetched} uploads, ${alreadySent} already sent, ${videos.length} candidates`);
videos = await addStats(videos);
videos = score(classify(videos, cfg.shortsMaxSeconds));
const sel = select(videos, cfg.budgetMinutes, cfg.shortsRatio, cfg);

const shortsUsed = sel.picked.filter((v) => v.kind === "short").reduce((a, v) => a + v.durationSeconds!, 0);
console.log(
  `\nPicked ${sel.picked.length} of ${videos.length} | ${fmtDuration(sel.totalSeconds)} of ${cfg.budgetMinutes} min ` +
    `(shorts ${fmtDuration(shortsUsed)} of ${fmtDuration(sel.shortsBudgetSeconds)} share)`,
);
if (sel.note) console.log(`  ℹ ${sel.note}`);
let picked = sel.picked;
let summaryStats;
if (!values["no-summaries"]) {
  ({ videos: picked, stats: summaryStats } = await summarize(picked, cfg.summaryModel));
  const s = summaryStats;
  console.log(`  Summaries: ${s.cached} cached, ${s.generated} new, ${s.failed} failed (${s.inputTokens} in / ${s.outputTokens} out tokens)`);
}
for (const v of picked) {
  console.log(`  ✓ ${v.creator} | ${v.title}\n      ${v.reason}`);
  if (v.summary) console.log(`      → ${v.summary}`);
}
if (sel.dropped.length) console.log(`\nDropped ${sel.dropped.length} (first 10; all are in the log):`);
for (const v of sel.dropped.slice(0, 10)) console.log(`  ✗ ${v.creator} | ${v.title}\n      ${v.reason}`);

// Step 7: deliver. Only a successful send marks videos as sent.
const day = new Date().toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", weekday: "short", day: "numeric", month: "short" });
const messages = formatDigest(sel, picked, cfg.budgetMinutes, day);
let delivery: string;
if (values["dry-run"]) {
  console.log(`\n--- Telegram preview (${messages.length} message${messages.length > 1 ? "s" : ""}, not sent) ---`);
  for (const m of messages) console.log(`${m}\n---`);
  delivery = "dry-run";
} else {
  await deliver(messages);
  saveSent(markSent(picked, sent));
  delivery = `sent ${messages.length} message(s)`;
  console.log(`\n✓ Sent to Telegram (${messages.length} message${messages.length > 1 ? "s" : ""}); ${picked.length} videos marked as sent`);
}

const logPath = writeRunLog({
  ranAt: new Date().toISOString(),
  config: cfg,
  since: since.toISOString(),
  fetched,
  alreadySent,
  withStats: videos.length,
  budgetSeconds: sel.budgetSeconds,
  shortsBudgetSeconds: sel.shortsBudgetSeconds,
  totalSeconds: sel.totalSeconds,
  note: sel.note,
  summaryModel: values["no-summaries"] ? null : cfg.summaryModel,
  summaryStats,
  delivery,
  date: lagosDate(),
  picked,
  dropped: sel.dropped,
});
console.log(`\nLog: ${logPath}`);
