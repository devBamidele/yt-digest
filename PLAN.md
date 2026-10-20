# YouTube Digest — Plan

Every day at 18:00 WAT (17:00 UTC), send one Telegram message with the best new videos from my chosen creators. The picks must fit a time budget I choose for that run (30 min, 1 h, 2 h…), with a fair mix of shorts and long-form. Each pick gets a short summary and a link.

---

## 1. Decisions

| Topic | Decision |
|---|---|
| Language / runtime | TypeScript on Node 22, run with `tsx` (no build step) |
| Dependencies | `yaml`, `fast-xml-parser`, `@anthropic-ai/sdk`; dev: `tsx`, `typescript`. Native `fetch` for HTTP, `node:test` for tests. No frameworks. |
| Budget | Dynamic. Default from `creators.yaml`; overridden by `--budget <min>` (v1) or a Telegram message like "2 hours" (v2). |
| Shorts vs long-form | Short = duration ≤ `shorts_max_seconds` (default 180) |
| Mix | `shorts_ratio` (set to 0.4, by time) of the budget goes to shorts, the rest to long-form. Scales with any budget. Unused time spills over to the other side. |
| Score | `(views / hours_since_upload) / max(subscribers, 1000) × priority_weight`. Never sort by raw views. The 1000-sub floor keeps tiny channels from scoring off the chart. |
| Selection | Plain code (knapsack), never an LLM. The budget is a hard limit, checked by an assertion. |
| Creators | Imported from my YouTube subscriptions: `npm run import-subs -- --login` (one-time Google sign-in, read-only, works when private; nothing stored), `-- @handle` (public subscriptions only) or `-- --csv subscriptions.csv` (Google Takeout). Merged into creators.yaml; existing weights are kept. |
| Backlog | Candidates = uploads from the last `backlog_days` (default 7) that haven't been sent yet. Sent video IDs are kept in `state/sent.json` (pruned after 30 days), so each video is sent at most once and slow days still fill up. |
| Per-creator cap | `max_per_creator` (default 2): at most 2 videos from one channel per digest |
| Max video length | A single video may use at most `max_video_share` (default 0.5) of the day's budget, and never more than `max_video_minutes` (default 60) |
| Budget honesty | If there isn't enough content to fill the budget, the digest says so (e.g. "Only 39 min of new content today"). |
| Summaries | From title + description only (no transcripts). Claude Sonnet 5.5 (`summary_model`), 2 sentences, structured JSON output, cached by video ID + prompt version. Chosen by `eval:summaries` on 10 videos: Sonnet 5.5 beat Opus 5.5 (fewer made-up claims, half the cost) and Haiku 4.5 (7/10 had made-up claims). |
| Delivery | Telegram bot |
| Scheduling | GitHub Actions cron `0 17 * * *`. Secrets as repo secrets → env vars. **Replaced in v3:** a Cloudflare cron every 5 minutes starts the GitHub run (section 10). |
| State | `state/` (summary cache, memory.json, Telegram offset) and `logs/` are committed back to the repo by the workflow after each run. **Replaced in v3:** state lives in Cloudflare D1; `logs/` stays local and is gitignored. |
| RSS fetching | At most 10 feeds in parallel, so 100+ creators don't hammer YouTube |
| Telegram input | Always-on Cloudflare Worker (`worker/`, `npm run worker:deploy`) receives every message and tap via webhook, stores it in KV for 30 days, answers taps instantly and replies to requests with what Claude understood. GitHub runs read stored updates from its `/events` endpoint (EVENTS_URL / EVENTS_TOKEN). Without those, they fall back to Telegram `getUpdates`. **Replaced in v3:** no KV, `/events` or `getUpdates`; the webhook writes straight to D1 and runs read it through `/api/*` (section 10). |

## 2. Project layout

```
creators.yaml           config (channels, weights, default budget, mix)
src/
  types.ts              shared Video type
  config.ts             step 1  load + validate config, apply --budget
  fetch.ts              step 2  RSS uploads + YouTube API stats
  classify.ts           step 3  short | long
  score.ts              step 4  score formula
  select.ts             step 5  budgeted, mix-aware selection
  summarize.ts          step 6  Claude summaries + cache
  deliver.ts            step 7  Telegram send
  log.ts                run log writer
  main.ts               runs the pipeline, CLI flags
  import-subs.ts        imports my subscriptions into creators.yaml
  sent.ts               backlog: which videos were already sent
  agent/                v2 only (see section 6)
evals/
  fixtures/videos.json  ~20 saved videos + my yes/no labels
  eval-select.ts        scorer+selector agreement vs labels
  eval-summaries.ts     LLM-as-judge on 10 summaries
tests/                  unit tests (node:test)
state/  logs/           persisted between runs
.github/workflows/digest.yml
```

## 3. Data shape

One record moves through the pipeline. Each step adds fields to it.

```ts
interface Video {
  videoId: string; title: string; description: string;
  publishedAt: string; channelId: string; creator: string; priorityWeight: number;  // fetch (RSS)
  views: number; durationSeconds: number; subscriberCount: number;                 // fetch (API)
  kind: "short" | "long";                                                          // classify
  score: number;                                                                   // score
  selected?: boolean; reason?: string;                                             // select
  summary?: string;                                                                // summarize
}
```

## 4. Selection algorithm (step 5)

Inputs: scored videos, `budgetSeconds`, `shortsRatio`.

1. `shortsBudget = round(budget × shortsRatio)`, `longBudget = budget − shortsBudget`.
2. **Pass 1:** run a 0/1 knapsack on each side within its own budget, maximising total score. Work in 10-second units to keep it fast.
3. **Pass 2 (spillover):** `leftover = budget − used`. Run a knapsack over all unpicked videos (either kind) within `leftover`. This way an empty shorts day still fills the hour with long-form, and the reverse.
4. Skip any video longer than the whole budget. If nothing is picked, send "Nothing new worth your time today."
5. **Assert** `sum(duration) ≤ budget`. If it fails, the run crashes; it never sends.
6. Every video gets a `reason`, e.g. `picked: score 0.27, long, 22m` or `dropped: didn't fit (34m, 3m left)`.

## 5. Build steps (v1)

Each step is run for real before the next one starts.

| # | Step | Done when |
|---|---|---|
| 0 | Scaffold: package.json, tsconfig, `npm run digest` | `npm run digest -- --help` works |
| 1 | `config.ts` | Loads the real creators.yaml; bad IDs, ratio or budget give clear errors; `--budget 30` overrides the default |
| 2 | `fetch.ts` | Prints last-24h uploads for my channels with views, duration and subs. One bad feed doesn't stop the run. ≤ ~5 quota units per run. |
| 3 | `classify.ts` | Unit test: 180 s → short, 181 s → long |
| 4 | `score.ts` | Unit test: a small channel with a strong ratio beats a big channel with more raw views |
| 5 | `select.ts` | Unit tests for 30/60/120 min: never over budget, mix within ±1 item of the ratio, spillover works when one side is empty |
| 5b | Import + backlog + budget note | `import-subs` adds my real subscriptions; already-sent videos are skipped; the run prints a note when content < budget |
| — | **Evals (before polish)** | `npm run eval:select` prints agreement with my labels. It fails if any budget is exceeded on budgets 30/60/120. |
| 6 | `summarize.ts` | 2-sentence summaries print in the terminal. A second run makes 0 API calls (cache hit). |
| — | `eval:summaries` | Judge scores 10 summaries (accuracy 1–5, hallucinated claims yes/no); report printed |
| 7 | `deliver.ts` | The message arrives on my phone: title, creator, duration, summary, link, and total time at the bottom |
| 8 | GitHub Actions | A manual `workflow_dispatch` run delivers. Then the cron is enabled. |

Each run writes `logs/YYYY-MM-DD.json`: config used, everything fetched, every score, every pick or drop with its reason, summary cache hits/misses, and the delivery result.

## 6. v2: AI and agent (built 2026-10-08)

`mode` in creators.yaml picks how the digest is chosen: `formula` (v1), `ai`, or `agent` (default).

| Part | What it does | Where |
|---|---|---|
| Taste profile | Claude writes Likes / Dislikes / Tentative from my 👍/👎 (titles looked up from YouTube). "My notes" is mine and never rewritten. Rebuilt when ≥3 new votes arrive. | `src/taste.ts`, `state/taste.md`, `npm run taste` |
| AI ranking (`ai`) | Claude rates the formula's top 120 against the profile and tonight's request (0–10, with a reason). Score = 0.7 × fit + 0.3 × formula percentile; fit < 4 is dropped. Ratings cached until the profile/request changes. Falls back to the formula on failure: a failed batch doesn't throw, its videos just go unrated, and the run log's `mode` says `formula` when no ratings came back at all. | `src/rank.ts`, `state/ratings.json` |
| Tonight's request | Messages to the bot during the day ("30 min tonight, mostly shorts, no money stuff") → tonight-only budget, shorts/long mix ("no shorts" and "only shorts" are strict), avoid/prefer topics, or skip. creators.yaml values are just the defaults. Parsed by Claude at the next run; `--budget` still wins. | `src/request.ts` |
| Agent (`agent`) | Manual tool-use loop (no framework). Tools: get_new_uploads, get_stats, get_top_comments, read_memory, write_memory, propose_selection, skip_today. Capped at `agent_max_tool_calls` (20). Every tool call is printed in the run's output (left out of public GitHub Actions logs) but not saved in the run log file. | `src/agent.ts`, `state/agent-notes.md` |

Rules stay in code: `propose_selection` is validated (budget, per-creator cap, per-video length, shorts mix within 15%; a selection under 80% of the budget is sent back once and accepted if resubmitted unchanged) and rejected with the reason so the agent can fix it; the budget is asserted again before sending. The agent never sends messages itself (deliberate change from the original send_message tool). If the agent fails (refusal, tool-call cap, error) the run falls back to AI ranking.

**Eval (`npm run eval:ai -- --agent`)**: profile built from taps only, tested on the 25 hand labels. First results (small sample, noisy):
- Ranking ("yes" above "no"): formula 63%, AI fit 65%, blend 61–68% depending on run.
- Picks I'd watch: formula 69–89%, AI 67–80%, agent 75–83% (but the agent picks few on a 25-video pool).
- Budget never exceeded in any mode.

Next: turn accumulated 👍/👎 into eval labels so the comparison stops resting on 25 videos.

## 7. Secrets (env vars)

`YOUTUBE_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

## 8. What I need to provide

1. My list of creators (channel URLs or @handles; their `UC…` IDs can be looked up)
2. A YouTube Data API key (needed at step 2)
3. About 20 videos labelled worth watching yes/no (needed before the evals; a helper script will dump candidates to label)
4. A Telegram bot token and chat ID (needed at step 7)

## 9. Open questions (sensible defaults used until told otherwise)

- ~~Cap per creator~~: decided, 2 (real data showed one channel taking 7 slots).
- ~~Summary model~~: decided by eval, Claude Sonnet 5.5.
- ~~Look-back window~~: replaced by the backlog (7 days, minus already-sent videos).
- Minimum score, so weak videos aren't sent just to fill time? (To be decided from eval results.)

---

## 10. v3: invite-only, multiple users (planned 2026-10-08)

Decisions: invite-only for me + up to ~5 friends; I pay for Claude with a per-user daily cap; each person picks their own delivery time and time zone. Then wipe all current data and onboard myself fresh through the bot.

### Architecture
| Piece | Today | v3 |
|---|---|---|
| State | JSON/markdown files in `state/`, committed to the repo | **Cloudflare D1** (SQL) next to the receiver; nothing personal in git |
| Telegram | Receiver only accepts my chat | Receiver serves any **invited** chat; everyone else gets "this bot is invite-only" |
| Onboarding | I edit files and run scripts | Guided in the bot (below) |
| Schedule | GitHub cron at 17:00 UTC (late or skipped) | **Cloudflare cron**, planned hourly, now **every 5 minutes** (delivery times are on a 5-minute grid) → starts the GitHub run with the users due at that moment |
| Pipeline | One user, reads/writes files | Same code, per user, reading/writing through the receiver's private API. Channel feeds and summaries are fetched/generated **once** and shared |
| Costs | Uncapped | Per-user daily Claude cap; past it: AI ranking with a cheaper model, then formula only. Owner exempt. Every Claude call's estimated cost counts, including the bot reading each message. If Claude is out of credit, the owner gets a Telegram alert (at most hourly) |

### Config
`creators.yaml` is removed. Channel lists and personal settings (watch time, shorts mix, delivery time, time zone) live per user in D1: channels come from each person's YouTube (onboarding and `/sync`), settings from buttons (`/settings`). A small `config.yaml` keeps only app-wide defaults (models, per-creator cap, length limits, per-user cost cap). Manual per-channel `priority_weight` goes away; 👍/👎 does that job per person.
Subscription import errors get friendly bot messages: `subscriptionForbidden`, `accountClosed`, `accountSuspended`, `subscriberNotFound`.

### D1 tables
`users` (chat_id, name, status onboarding/active/paused, onboarding step, timezone, delivery_hour, budget_minutes, shorts_ratio, mode, is_owner), `invites` (code, used_by), `creators` (chat_id, channel_id, name, priority_weight), `votes`, `sent`, `requests`, `taste` (notes, learned, votes_used), `agent_notes`, `ratings` (per user), `summaries` (shared by video), `usage` (chat_id, day, cost), `oauth_states` (short-lived).

### Onboarding in the bot
1. `t.me/<bot>?start=<invite code>` → welcome. (No code or used code → invite-only message.)
2. **Connect YouTube** button → Google sign-in in the browser → the receiver's `/oauth/callback` imports subscriptions (read-only scope, token used once and not stored) → "Found 154 channels ✓".
   Fallbacks if Google refuses (not on the test-user list): send `subscriptions.csv` from Takeout, or an @handle with public subscriptions.
3. Buttons: default watch time (30/60/90/120), shorts mix (mostly long / balanced / mostly shorts), delivery time (common hours) + time zone (city or UTC offset).
4. "Tell me what you're into" (free text → taste "My notes"; can skip).
5. "You're set: first digest at 18:00 (Africa/Lagos)."
Commands after: `/settings`, `/sync` (re-import subscriptions), `/pause` / `/resume`, `/delete` (erase everything about me), `/help`; owner only: `/invite`, `/users`.

### Build steps (each tested before the next)
1. D1 schema + data layer + receiver API (`/api/...`, bearer-token protected).
2. Onboarding state machine + Google web sign-in + CSV fallback; test end to end with me.
3. Pipeline per user via the API; shared feed fetch and summary cache; per-user caps.
4. Cloudflare cron (hourly at first, every 5 minutes since `1f5af87`) → GitHub `workflow_dispatch` with the due users; GitHub's own cron removed.
5. Commands (`/settings`, `/sync`, `/pause`, `/delete`, `/invite`, `/users`).
6. **Full wipe** (decided 2026-10-08): delete state/ (votes, taste, requests, sent history, caches), the receiver's stored updates and local logs; keep `evals/fixtures/` (test data). Then onboard me through the bot like any new user, then invite friends.

### What I need to do
- Google Cloud: create an OAuth client of type **Web application** with redirect URI `https://yt-digest-bot.bamideledavid-ajewole.workers.dev/oauth/callback`; add each friend's Google email under Audience → Test users (max 100).
- GitHub: a fine-grained token with "Actions: read and write" on this repo only, so Cloudflare can start runs.

### Status (2026-10-08): v3 live
Steps 1–6 done. The single-user v2 path is retired (src/main.ts, the terminal importer, the laptop Google sign-in, digest.yml and feedback.yml, creators.yaml and state/ are gone; raw update storage in KV removed). All data was wiped; the 25 hand labels in evals/fixtures/ were kept. Evals read config.yaml and the owner's channels/votes from the database.
Everyone (owner included) now onboards with /start in the bot.
