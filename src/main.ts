// Runs the digest pipeline. Steps are added here as they are built.
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { addStats, fetchUploads } from "./fetch.ts";
import { classify } from "./classify.ts";
import { score } from "./score.ts";
import { assertBudget, fmtDuration, select, type Selection } from "./select.ts";
import { runAgent, type AgentResult } from "./agent.ts";
import { writeRunLog } from "./log.ts";
import { loadSent, markSent, saveSent, unsent } from "./sent.ts";
import { summarize } from "./summarize.ts";
import { deliver, formatDigest } from "./deliver.ts";
import {
  channelWeights,
  clearRequests,
  collectFeedback,
  loadFeedback,
  pendingRequests,
  resetTapsSinceDigest,
  tapsSinceDigest,
} from "./feedback.ts";
import { parseRequests, requestForPrompt, type TonightRequest } from "./request.ts";
import { sendTelegram } from "./deliver.ts";
import { lagosDate } from "./log.ts";
import { blend, rate, shortlist } from "./rank.ts";
import { maybeUpdateTaste, tasteForPrompt } from "./taste.ts";
import type { Video } from "./types.ts";

// Local runs read secrets from .env; in CI they come from the environment.
try {
  process.loadEnvFile();
} catch {}

const HELP = `Usage: npm run digest -- [options]

  --budget <min>   time budget for this run in minutes (default: creators.yaml)
  --hours <n>      look back this many hours for uploads (default: backlog_days from creators.yaml)
  --no-summaries   skip Claude summaries (free test runs)
  --dry-run        print the Telegram message instead of sending it (nothing is marked as sent)
  --collect-feedback  also collect 👍/👎 taps on a local run (GitHub runs always do)
  --config <path>  config file (default: creators.yaml)
  --help           show this message`;

const { values } = parseArgs({
  options: {
    budget: { type: "string" },
    hours: { type: "string" },
    config: { type: "string", default: "creators.yaml" },
    "no-summaries": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "collect-feedback": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const budget = values.budget === undefined ? undefined : Number(values.budget);
const cfg = loadConfig(values.config, budget);


// Collect 👍/👎 taps since the last run and turn them into per-channel weights.
// Only GitHub runs collect: Telegram hands each tap out once, so a local run would take it from the repo's state.
let feedback = { up: 0, down: 0 }; // collected by this run, for the log
if (process.env.GITHUB_ACTIONS || values["collect-feedback"]) {
  try {
    feedback = await collectFeedback();
  } catch (e) {
    console.log(`  ! couldn't collect feedback (${(e as Error).message}); using what's saved`);
  }
}
const learned = channelWeights(loadFeedback());

// Tonight's request: messages sent to the bot since the last digest, parsed by Claude.
let tonight: TonightRequest | null = null;
const requests = pendingRequests();
if (requests.length) {
  try {
    tonight = await parseRequests(requests, cfg.aiModel);
    console.log(`Request for tonight (${requests.length} message(s)): ${tonight.summary || "(nothing actionable)"}`);
    // Tonight-only overrides of creators.yaml; --budget on the command line still wins.
    if (tonight.budget_minutes && budget === undefined) cfg.budgetMinutes = tonight.budget_minutes;
    if (tonight.shorts_share >= 0) cfg.shortsRatio = tonight.shorts_share / 100;
  } catch (e) {
    console.log(`  ! couldn't read tonight's request (${(e as Error).message}); using defaults`);
  }
}
if (tonight?.skip_today) {
  const msg = "📺 Skipping tonight's digest, as you asked. See you tomorrow!";
  if (values["dry-run"]) console.log(`\n--- Telegram preview ---\n${msg}`);
  else {
    await sendTelegram(msg);
    clearRequests();
  }
  writeRunLog({ ranAt: new Date().toISOString(), date: lagosDate(), skipped: "requested", requests, tonight });
  console.log("Skipped tonight, as requested.");
  process.exit(0);
}

console.log(
  `${cfg.creators.length} creators | mode: ${cfg.mode} | budget: ${cfg.budgetMinutes} min | ` +
    `mix: ${Math.round(cfg.shortsRatio * 100)}% shorts / ${Math.round((1 - cfg.shortsRatio) * 100)}% long-form`,
);

// Refresh the taste profile when enough new taps have arrived (AI modes only).
if (cfg.mode !== "formula") {
  try {
    await maybeUpdateTaste(cfg.aiModel);
  } catch (e) {
    console.log(`  ! couldn't update the taste profile (${(e as Error).message}); using the saved one`);
  }
}

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
// Your manual priority_weight × what your 👍/👎 taught it about this channel.
videos = videos.map((v) => ({ ...v, priorityWeight: v.priorityWeight * (learned.get(v.channelId)?.weight ?? 1) }));
videos = score(classify(videos, cfg.shortsMaxSeconds));

// Agent mode: Claude investigates the shortlist with tools and proposes the set; code validates it.
// If the agent fails for any reason, the run falls back to AI ranking below.
let agent: AgentResult | undefined;
let sel: Selection | undefined;
if (cfg.mode === "agent" && videos.length) {
  console.log(`\nAgent (max ${cfg.agentMaxToolCalls} tool calls):`);
  agent = await runAgent({
    candidates: shortlist(videos, cfg.aiShortlist, cfg.shortsRatio),
    cfg,
    taste: tasteForPrompt(),
    request: requestForPrompt(tonight),
    dryRun: values["dry-run"],
  });
  const u = agent.usage;
  console.log(`  Agent ${agent.outcome} after ${agent.toolLog.length} tool calls (${u.input} in / ${u.output} out / ${u.cacheRead} cached tokens)${agent.error ? `: ${agent.error}` : ""}`);
  if (agent.outcome === "skipped") {
    const msg = `📺 No digest tonight. ${agent.skipped}`;
    if (values["dry-run"]) console.log(`\n--- Telegram preview ---\n${msg}`);
    else {
      await sendTelegram(msg);
      clearRequests();
    }
    writeRunLog({ ranAt: new Date().toISOString(), date: lagosDate(), config: cfg, skipped: "agent", reason: agent.skipped, agent, tonight });
    process.exit(0);
  }
  if (agent.outcome === "selected") {
    const budgetSeconds = Math.floor(cfg.budgetMinutes * 60);
    assertBudget(agent.picked, budgetSeconds); // validated in the tool already; checked again before anything is sent
    const totalSeconds = agent.picked.reduce((a, v) => a + (v.durationSeconds ?? 0), 0);
    const chosen = new Set(agent.picked.map((v) => v.videoId));
    const left = budgetSeconds - totalSeconds;
    sel = {
      picked: agent.picked,
      dropped: videos.filter((v) => !chosen.has(v.videoId)).map((v) => ({ ...v, selected: false, reason: "not chosen by agent" })),
      totalSeconds,
      budgetSeconds,
      shortsBudgetSeconds: Math.round(budgetSeconds * cfg.shortsRatio),
      note: left >= 5 * 60 ? `${fmtDuration(left)} left unused: quality over filling time.` : undefined,
    };
  }
}

// AI taste ranking: Claude rates the formula's shortlist against the taste profile, then the
// budgeted selector picks from the blend. Any failure falls back to the formula.
let pool: Video[] = videos;
let tasteRejected: Video[] = [];
if (!sel && cfg.mode !== "formula" && videos.length) {
  try {
    const short = shortlist(videos, cfg.aiShortlist, cfg.shortsRatio);
    const ratings = await rate(short, tasteForPrompt(), requestForPrompt(tonight), cfg.aiModel);
    ({ eligible: pool, rejected: tasteRejected } = blend(short, ratings, cfg));
    console.log(`  Shortlisted ${short.length}; ${tasteRejected.length} rated below min_fit ${cfg.minFit} and dropped`);
  } catch (e) {
    console.log(`  ! AI ranking failed (${(e as Error).message}); using the formula`);
    pool = videos;
  }
}
if (!sel) {
  sel = select(pool, cfg.budgetMinutes, cfg.shortsRatio, cfg);
  if (cfg.mode !== "formula" && pool.length === 0 && videos.length) sel.note = "Skip today: nothing new fits your taste.";
  sel.dropped.push(...tasteRejected);
}

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
  console.log(`  ✓ ${v.creator} | ${v.title}\n      ${v.reason}${v.fit === undefined ? "" : ` | fit ${v.fit}/10: ${v.fitReason}`}`);
  if (v.summary) console.log(`      → ${v.summary}`);
}
if (sel.dropped.length) console.log(`\nDropped ${sel.dropped.length} (first 10; all are in the log):`);
for (const v of sel.dropped.slice(0, 10)) console.log(`  ✗ ${v.creator} | ${v.title}\n      ${v.reason}`);

// Step 7: deliver. Only a successful send marks videos as sent.
const day = new Date().toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", weekday: "short", day: "numeric", month: "short" });
const taps = tapsSinceDigest(); // includes taps the 6am run collected
const headerLines = [
  agent?.intro,
  tonight?.summary && `Tonight: ${tonight.summary} (as you asked)`,
  taps.up + taps.down && `Got your feedback: ${taps.up} 👍, ${taps.down} 👎. Thanks!`,
].filter(Boolean);
const feedbackLine = headerLines.length ? headerLines.join("\n") : undefined;
const messages = formatDigest(sel, picked, cfg.budgetMinutes, day, feedbackLine);
let delivery: string;
if (values["dry-run"]) {
  console.log(`\n--- Telegram preview (${messages.length} message${messages.length > 1 ? "s" : ""}, not sent) ---`);
  for (const m of messages) console.log(`${m.text}${m.video ? "\n[👍] [👎]" : ""}\n---`);
  delivery = "dry-run";
} else {
  // Mark each video as sent as soon as its own message goes through, even if a later one fails.
  const delivered: typeof picked = [];
  try {
    await deliver(messages, (v) => delivered.push(v));
  } finally {
    saveSent(markSent(delivered, sent));
  }
  resetTapsSinceDigest(); // acknowledged in this digest's header
  clearRequests(); // tonight's request has been used
  delivery = `sent ${messages.length} message(s)`;
  console.log(`\n✓ Sent to Telegram (${messages.length} messages); ${delivered.length} videos marked as sent`);
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
  feedbackCollected: feedback,
  requests,
  tonight,
  agent, // every tool call with its input, result and timing
  learnedWeights: Object.fromEntries(learned),
  summaryModel: values["no-summaries"] ? null : cfg.summaryModel,
  summaryStats,
  delivery,
  date: lagosDate(),
  picked,
  dropped: sel.dropped,
});
console.log(`\nLog: ${logPath}`);
