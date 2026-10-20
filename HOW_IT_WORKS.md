# YouTube Digest Bot: how it works

## What it is, in one paragraph
A private, invite-only Telegram bot that sends each user one message a day with the best new videos from the YouTube channels they subscribe to. The picks fit a watch-time budget the user chooses (for example 60 minutes), with a set mix of Shorts and long videos. Each video comes with a 2-sentence AI summary, a link, and 👍/👎 buttons. Over time the bot learns what each person likes from those taps. The owner (the developer) runs it for themselves and up to about 5 invited friends. The owner pays the Claude API costs, and each friend has a daily spending cap.

It is written in TypeScript on Node 22, run directly with `tsx` with no build step. It has very few dependencies (`@anthropic-ai/sdk`, `yaml`, `fast-xml-parser`) and uses no frameworks. Tests use `node:test`.

## The two halves

### 1. The always-on receiver: a Cloudflare Worker (`worker/`)
This is the bot's "front desk". Telegram sends every message and button tap to it through a webhook, and it replies right away.

- **Onboarding** ([worker/onboarding.ts](worker/onboarding.ts)): a user opens an invite link (`t.me/<bot>?start=<code>`), then connects YouTube through Google sign-in (OAuth with PKCE, read-only; the token is used once to import subscriptions and is never stored). They then pick a watch time, a Shorts/long mix, a delivery time and time zone, and can describe their interests in their own words. If Google sign-in isn't available, they can upload a Google Takeout `subscriptions.csv` instead, or give a public @handle.
- **Commands** ([worker/commands.ts](worker/commands.ts)): `/settings`, `/sync`, `/pause`, `/resume`, `/delete` (erases all of the user's data) and `/help`. The owner also has `/invite` (one-time invite links) and `/users` (each user's status, today's spend, and a heartbeat health check).
- **Free-text messages** such as "30 min tonight, only shorts, nothing about money, send it at 9pm" are parsed by Claude ([src/request.ts](src/request.ts)) into structured settings for the next digest. A time change is applied immediately; content preferences are stored for the next run. If Claude can't read a message, the bot says nothing has changed yet and keeps the message for the digest run to try again.
- **Votes**: 👍/👎 taps are saved per video and per channel.
- **Pinned status message** ([worker/status.ts](worker/status.ts)): each user has one pinned message showing "Next digest: … in 9h 40m", updated every 5 minutes.
- **Scheduler**: a Cloudflare cron runs every 5 minutes. It records a heartbeat, works out who is due, and if anyone is, starts a GitHub Actions run through `workflow_dispatch`. If that dispatch fails, it alerts the owner on Telegram, at most once an hour.
- **Private API** (`/api/*`, bearer-token protected, [worker/api.ts](worker/api.ts)): the GitHub run reads and writes all per-user data through this API.
- **Storage**: Cloudflare D1 (SQLite). See [worker/schema.sql](worker/schema.sql). Every table is keyed by Telegram `chat_id`. The tables are users, invites, creators (channels), votes, sent, requests, taste, agent_notes, ratings, summaries (shared across users), usage (daily cost), oauth_states and app_state.
- **Timing rules** ([worker/time.ts](worker/time.ts)): times are kept on a 5-minute grid, a missed check still delivers within 30 minutes, and there is at most one digest per user per day (a 23-hour cooldown).

### 2. The digest builder: GitHub Actions (`src/`, entry point [src/multi.ts](src/multi.ts))
[.github/workflows/users.yml](.github/workflows/users.yml) runs the tests, then `npm run digest:users -- --due`. For every user who is due:

1. **Fetch** ([src/fetch.ts](src/fetch.ts)): new uploads from the last 7 days via free YouTube RSS feeds, then views, duration and subscriber counts via the YouTube Data API in batches. Each channel is fetched only once, however many users follow it.
2. **Classify**: a video of 180 seconds or less is a "short"; anything longer is "long".
3. **Score** ([src/score.ts](src/score.ts)): `(views ÷ hours since upload) ÷ max(subscribers, 1000) × channel weight`. This rewards videos doing unusually well for their channel's size, not raw view counts. The channel weight comes from votes: each net 👍 multiplies it by 1.5 and each net 👎 divides it by 1.5, kept between 0.1 and 3.
4. **Pick**, in one of three modes (set in `config.yaml`; default `agent`). Each mode falls back to the next if it fails:
   - **agent** ([src/agent.ts](src/agent.ts)): a hand-written Claude tool-use loop, with no framework. Its tools are `get_new_uploads`, `get_stats`, `get_top_comments`, `read_memory`, `write_memory`, `propose_selection` and `skip_today`, capped at 20 tool calls. The agent only *proposes* a selection; code checks it (budget, at most 2 videos per channel, maximum video length, Shorts mix within 15%) and sends rejections back with the reason. The agent never sends messages itself.
   - **ai** ([src/rank.ts](src/rank.ts)): Claude rates the top 120 candidates 0–10 for fit with the user's taste profile and tonight's request. The final score is 0.7 × fit + 0.3 × formula rank, and anything with a fit below 4 is dropped. Ratings are cached.
   - **formula** ([src/select.ts](src/select.ts)): plain code with no AI. It runs a 0/1 knapsack separately for the Shorts budget and the long-video budget, then a second pass so unused time on one side goes to the other.
   - In every mode, the budget is a hard rule enforced by an assertion: a digest over budget crashes the run instead of being sent.
   - A failed AI rating batch doesn't throw; its videos just keep their formula score. The run log records both `configuredMode` and `mode`, the one that actually produced the picks, so a run configured as `agent` that fell back shows `mode: "formula"`.
5. **Taste profile** ([src/taste.ts](src/taste.ts)): each user has "notes" (their own words, never rewritten by Claude) and "learned" (Likes/Dislikes written by Claude from their votes). The learned part is rebuilt after every 3 new votes.
6. **Summarize** ([src/summarize.ts](src/summarize.ts)): 2 sentences per video, written from the title and description only (transcripts are not used, on purpose). Uses Claude Sonnet 5.5, which won an eval for fewest made-up claims. Summaries are cached per video and shared across users. If a summary can't be written, the first non-link line of the description is shown instead, or the title if there is none.
7. **Deliver** ([src/deliver.ts](src/deliver.ts)): one Telegram message per video, each with its own 👍/👎 buttons, plus a header and footer showing total time used and any note such as "only 39 min of new content today". The run then records what was sent so no video is sent to the same user twice.

## Cost control
[src/cost.ts](src/cost.ts) estimates the dollar cost of every Claude call from its token usage: the agent, AI ranking, taste updates, summaries, reading tonight's request in the digest run, and the bot reading each message. A call the API rejects adds nothing. Non-owner users have a daily cap of $0.40. Once a user passes the cap, agent mode is downgraded to AI ranking on a cheaper model. At twice the cap, the run uses the formula only, and summaries fall back to the video description. The owner is exempt.

**Out of credit.** If the Claude API reports a billing error (out of credit), every AI step falls back as above and digests still go out, picked by the formula. The owner gets a Telegram alert at most once an hour, from the digest run or from the bot, whichever hits the error first.

## Other pieces
- [config.yaml](config.yaml): app-wide defaults (models, Shorts threshold, per-channel cap, length limits, cost cap). Personal settings live in D1.
- `evals/`: offline evaluations against 25 hand-labelled videos (selection agreement, summary quality judged by an LLM, and formula vs AI vs agent).
- `tests/`: unit and integration tests (`node:test`) for most modules: budget never exceeded, scoring, the agent's selection rules, onboarding and messages through the real webhook with a local D1, the API, time parsing, fallbacks when Claude fails, and so on. Claude and Telegram are faked in the tests. `src/cost.ts` and `src/log.ts` have no tests of their own.
- [PLAN.md](PLAN.md): the design record and its history. v1 was one user, the formula, and state saved in git. v2 added the taste profile, AI ranking, the agent and the receiver. v3, the current version, is multi-user with D1.

## Useful commands
- `npm test`, `npm run typecheck`
- `npm run worker:deploy`: redeploy the receiver after changing `worker/` or `src/request.ts`, which the worker imports
- `npm run db:migrate`: apply the schema to D1
- `npm run digest:users -- --user <chat_id> --dry-run`: preview one user's digest without sending it

## Design principles to respect
- Hard rules (budget, caps, sending) live in code; the LLM only suggests.
- Every AI step has a fallback that doesn't need Claude.
- The watch-time budget can change on every run; never hard-code it.
- Use few dependencies and no frameworks.
