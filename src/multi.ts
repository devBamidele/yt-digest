// v3 runner: builds and sends the digest for every user who is due (or one user), reading and
// writing their data through the receiver's private API. Channel feeds and video stats are fetched
// once and shared; everything else is per user.
//   npm run digest:users -- --due            (what the 5-minute schedule runs)
//   npm run digest:users -- --user <chat_id> [--dry-run] [--no-summaries]
import { parseArgs } from "node:util";
import { runAgent } from "./agent.ts";
import { classify } from "./classify.ts";
import { CREDIT_ALERT, creditError } from "./claude.ts";
import { loadAppConfig, type AppConfig } from "./config.ts";
import { costUsd } from "./cost.ts";
import { deliver, formatDigest, sendTelegram } from "./deliver.ts";
import { weightsFromVotes } from "./feedback.ts";
import { addStats, fetchUploads } from "./fetch.ts";
import { writeRunLog } from "./log.ts";
import { blend, rateUncached, ratingsKey, shortlist, type Rating } from "./rank.ts";
import { parseRequests, requestForPrompt, type TonightRequest } from "./request.ts";
import { score } from "./score.ts";
import { assertBudget, fmtDuration, select, type Selection } from "./select.ts";
import { Store, type UserState } from "./store.ts";
import { fallbackSummary, summarize } from "./summarize.ts";
import { evidenceFor, learnTasteWithUsage, REBUILD_AFTER_VOTES, renderLearned, tasteText } from "./taste.ts";
import type { Config, Video } from "./types.ts";

try {
  process.loadEnvFile();
} catch {}

interface Options {
  dryRun: boolean;
  noSummaries: boolean;
  /** Run output is public (GitHub Actions logs of a public repo): name users "user 1", "user 2"…
   *  and leave out what they asked for, the agent's tool calls and dry-run message text. */
  publicLog?: { label: string };
  /** Where the run log goes (default logs/<chat_id>). */
  logDir?: string;
}

/** One user's digest. Returns a short outcome line for the run summary. */
export async function runUser(app: AppConfig, store: Store, st: UserState, costToday: number, pool: Video[], opts: Options): Promise<string> {
  const u = st.user;
  const chat = u.chat_id;
  const log = (s: string) => console.log(`[${opts.publicLog?.label ?? (u.name || chat)}] ${s}`);
  const detail = opts.publicLog ? () => {} : log;
  let cost = 0;

  // Per-user config: app defaults + this person's settings and channels.
  const cfg: Config = {
    ...app,
    budgetMinutes: u.budget_minutes,
    shortsRatio: u.shorts_ratio,
    creators: st.creators.map((c) => ({ id: c.id, name: c.name, priorityWeight: 1 })),
  };

  // Daily cap (owner exempt): past it, cheaper picking; past twice it, no Claude at all.
  const capped = !u.is_owner && costToday >= app.userDailyCapUsd;
  const hardCapped = !u.is_owner && costToday >= 2 * app.userDailyCapUsd;
  if (hardCapped) cfg.mode = "formula";
  else if (capped) Object.assign(cfg, { mode: cfg.mode === "agent" ? "ai" : cfg.mode, aiModel: app.summaryModel });
  if (capped) log(`over the daily cap ($${costToday.toFixed(2)}): mode ${cfg.mode}`);

  // Tonight's request (messages since the last digest).
  let tonight: TonightRequest | null = null;
  let requestUnread = false; // then the messages are kept for the next digest, not used up
  const lastRequestId = st.requests.at(-1)?.id ?? null;
  if (st.requests.length && !hardCapped) {
    try {
      const r = await parseRequests(st.requests, cfg.aiModel);
      cost += costUsd(cfg.aiModel, r.usage);
      tonight = r.request;
      if (tonight.budget_minutes) cfg.budgetMinutes = tonight.budget_minutes;
      if (tonight.shorts_share >= 0) cfg.shortsRatio = tonight.shorts_share / 100;
      detail(`request: ${tonight.summary || "(nothing actionable)"}`);
    } catch (e) {
      requestUnread = true;
      log(`! couldn't read the request (${(e as Error).message}); keeping it for next time`);
    }
  }

  const finish = async (sentIds: string[]) => {
    if (opts.dryRun) {
      if (cost) await store.addCost(chat, cost);
    } else {
      await store.recordDigest(chat, sentIds, requestUnread ? null : lastRequestId, cost);
    }
  };

  if (tonight?.skip_today) {
    if (!opts.dryRun) await sendTelegram("📺 Skipping today's digest, as you asked. See you tomorrow!", { chatId: chat });
    await finish([]);
    return "skipped (asked)";
  }

  // Candidates: unsent uploads from this person's channels, weighted by their 👍/👎.
  const mine = new Map(st.creators.map((c) => [c.id, c.name]));
  const sent = new Set(st.sent.map((s) => s.video_id));
  const weights = weightsFromVotes(st.votes.map((v) => ({ channelId: v.channel_id, vote: v.vote })));
  const videos = score(
    pool
      .filter((v) => mine.has(v.channelId) && !sent.has(v.videoId))
      .map((v) => ({ ...v, creator: mine.get(v.channelId)!, priorityWeight: weights.get(v.channelId)?.weight ?? 1 })),
  );
  log(`${videos.length} candidates from ${mine.size} channels | mode ${cfg.mode} | ${cfg.budgetMinutes} min, ${Math.round(cfg.shortsRatio * 100)}% shorts`);

  // Refresh the taste profile when enough new votes arrived.
  let learned = st.taste.learned;
  if (cfg.mode !== "formula" && st.votes.length - st.taste.votes_used >= REBUILD_AFTER_VOTES) {
    try {
      const evidence = await evidenceFor(st.votes.map((v) => ({ videoId: v.video_id, vote: v.vote })));
      const r = await learnTasteWithUsage(evidence, st.taste.notes, cfg.aiModel);
      cost += costUsd(cfg.aiModel, r.usage);
      learned = renderLearned(r.learned, st.votes.length);
      if (!opts.dryRun) await store.saveTaste(chat, learned, st.votes.length);
      log(`taste profile updated from ${st.votes.length} votes`);
    } catch (e) {
      log(`! taste update failed (${(e as Error).message})`);
    }
  }
  const taste = tasteText(st.taste.notes, learned);
  const request = requestForPrompt(tonight);

  // Pick: agent → AI ranking → formula, each falling back to the next. `pickedBy` is the one that
  // actually produced the picks, which is what the run log records.
  let sel: Selection | undefined;
  let pickedBy: Config["mode"] = "formula";
  let intro: string | undefined;
  if (cfg.mode === "agent" && videos.length) {
    const agent = await runAgent({
      candidates: shortlist(videos, cfg.aiShortlist, cfg.shortsRatio),
      cfg,
      taste,
      request,
      dryRun: opts.dryRun,
      log: detail,
      notes: st.agentNotes.map((n) => `${n.at.slice(0, 10)}: ${n.note}`),
      weights,
    });
    cost += costUsd(cfg.aiModel, agent.usage);
    if (agent.notesWritten.length) await store.addAgentNotes(chat, agent.notesWritten);
    log(`agent ${agent.outcome} after ${agent.toolLog.length} tool calls${agent.error ? `: ${agent.error}` : ""}`);
    if (agent.outcome === "skipped") {
      if (!opts.dryRun) await sendTelegram(`📺 No digest today. ${agent.skipped}`, { chatId: chat });
      await finish([]);
      return "skipped (agent)";
    }
    if (agent.outcome === "selected") {
      const budgetSeconds = Math.floor(cfg.budgetMinutes * 60);
      assertBudget(agent.picked, budgetSeconds);
      const totalSeconds = agent.picked.reduce((a, v) => a + (v.durationSeconds ?? 0), 0);
      const left = budgetSeconds - totalSeconds;
      intro = agent.intro;
      pickedBy = "agent";
      sel = {
        picked: agent.picked,
        dropped: [],
        totalSeconds,
        budgetSeconds,
        shortsBudgetSeconds: Math.round(budgetSeconds * cfg.shortsRatio),
        note: left >= 5 * 60 ? `${fmtDuration(left)} left unused: quality over filling time.` : undefined,
      };
    }
  }
  if (!sel) {
    let pickFrom = videos;
    if (cfg.mode !== "formula" && videos.length) {
      try {
        const short = shortlist(videos, cfg.aiShortlist, cfg.shortsRatio);
        const key = ratingsKey(taste, request, cfg.aiModel);
        const ratings = new Map<string, Rating>(st.ratings.filter((r) => r.cache_key === key).map((r) => [r.video_id, { fit: r.fit, reason: r.reason }]));
        const todo = short.filter((v) => !ratings.has(v.videoId));
        const fresh = await rateUncached(todo, taste, request, cfg.aiModel, log);
        cost += costUsd(cfg.aiModel, fresh.usage);
        for (const [id, r] of fresh.ratings) ratings.set(id, r);
        if (fresh.ratings.size && !opts.dryRun) {
          await store.saveRatings(chat, key, [...fresh.ratings].map(([video_id, r]) => ({ video_id, ...r })));
        }
        pickFrom = blend(short, ratings, cfg).eligible;
        log(`AI ratings: ${short.length - todo.length} cached, ${fresh.ratings.size} new`);
        // Failed batches don't throw: with no ratings at all, the formula alone did the picking.
        if (ratings.size) pickedBy = "ai";
        else log("! no AI ratings; picking by the formula");
      } catch (e) {
        log(`! AI ranking failed (${(e as Error).message}); using the formula`);
      }
    }
    sel = select(pickFrom, cfg.budgetMinutes, cfg.shortsRatio, cfg);
    if (cfg.mode !== "formula" && pickFrom.length === 0 && videos.length) sel.note = "Nothing new fits your taste today.";
  }

  // Summaries (shared cache across users).
  let picked = sel.picked;
  if (opts.noSummaries || hardCapped) {
    picked = picked.map((v) => ({ ...v, summary: hardCapped ? fallbackSummary(v) : undefined }));
  } else {
    const r = await summarize(picked, app.summaryModel, log, store.summaryStore());
    picked = r.videos;
    cost += costUsd(app.summaryModel, { input: r.stats.inputTokens, output: r.stats.outputTokens });
  }

  // Deliver to this person's chat.
  const day = new Date().toLocaleDateString("en-GB", { timeZone: u.timezone, weekday: "short", day: "numeric", month: "short" });
  const since = u.last_digest_at ? Date.parse(u.last_digest_at) : 0;
  const recent = st.votes.filter((v) => Date.parse(v.at) > since);
  const taps = { up: recent.filter((v) => v.vote === "up").length, down: recent.filter((v) => v.vote === "down").length };
  const messages = formatDigest(sel, picked, cfg.budgetMinutes, day, { intro, request: tonight?.summary || undefined, requestUnread, taps });

  const outcome = `${picked.length} videos (${pickedBy}), ${fmtDuration(sel.totalSeconds)} of ${cfg.budgetMinutes} min, ~$${cost.toFixed(3)}`;
  if (opts.dryRun) {
    log(`dry run: ${outcome}`);
    if (!opts.publicLog) for (const m of messages) console.log(`${m.text.replace(/<[^>]+>/g, "")}${m.video ? "\n[👍] [👎]" : ""}\n---`);
    await finish([]);
  } else {
    const delivered: string[] = [];
    try {
      await deliver(messages, (v) => delivered.push(v.videoId), chat);
    } finally {
      await finish(delivered); // records what reached them even if a later message failed
    }
    log(`sent: ${outcome}`);
  }
  writeRunLog(
    { ranAt: new Date().toISOString(), user: chat, mode: pickedBy, configuredMode: cfg.mode, tonight, cost, picked, note: sel.note },
    opts.logDir ?? `logs/${chat}`,
  );
  return outcome;
}

/** Tells the owner if any Claude call in this run failed for lack of credit. */
export async function alertIfOutOfCredit(store: Store) {
  if (creditError()) await store.alertOwner("credit", CREDIT_ALERT);
}

async function main() {
  const { values } = parseArgs({
    options: {
      due: { type: "boolean", default: false },
      user: { type: "string" },
      at: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "no-summaries": { type: "boolean", default: false },
    },
  });
  const app = loadAppConfig();
  const store = new Store();
  const ids = values.user ? [values.user] : values.due ? await store.due(values.at ? new Date(values.at) : new Date()) : [];
  if (!ids.length) {
    console.log(values.user || values.due ? "Nobody is due right now." : "Pass --due or --user <chat_id>.");
    return;
  }

  const states = await Promise.all(ids.map((id) => store.state(id)));
  // Fetch each channel once, however many people follow it.
  const channels = new Map(states.flatMap((s) => s.state.creators.map((c) => [c.id, c.name] as const)));
  const since = new Date(Date.now() - app.backlogDays * 86400_000);
  console.log(`${ids.length} user(s) due; fetching ${channels.size} channels…`);
  const uploads = await fetchUploads({ creators: [...channels].map(([id, name]) => ({ id, name, priorityWeight: 1 })) } as Config, since, () => {});
  const pool = classify(await addStats(uploads, () => {}), app.shortsMaxSeconds);
  console.log(`${uploads.length} uploads, ${pool.length} with stats`);

  // Actions logs are public in a public repo: keep names and personal details out of them.
  const publicRun = process.env.GITHUB_ACTIONS === "true";
  let failures = 0;
  for (const [i, { state, costToday }] of states.entries()) {
    const publicLog = publicRun ? { label: `user ${i + 1}` } : undefined;
    try {
      await runUser(app, store, state, costToday, pool, { dryRun: values["dry-run"], noSummaries: values["no-summaries"], publicLog });
    } catch (e) {
      failures++;
      console.error(`[${publicLog?.label ?? (state.user.name || state.user.chat_id)}] ✗ failed: ${(e as Error).stack ?? e}`);
    }
  }
  if (creditError()) console.log(`! Claude API is out of credit (${creditError()}); alerting the owner`);
  await alertIfOutOfCredit(store).catch((e) => console.error(`! couldn't alert the owner: ${(e as Error).message}`));
  if (failures) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
