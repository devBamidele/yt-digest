# YouTube Digest Bot

A private, invite-only Telegram bot that sends each person one message a day with the best new videos from the YouTube channels they subscribe to. The picks fit a watch-time budget they choose (say 60 minutes), with a set mix of Shorts and long videos. Each video comes with a two-sentence summary, a link and 👍/👎 buttons, and the bot learns each person's taste from those taps. You can also message it in plain words, such as "30 min tonight, only shorts, nothing about money", to change a single day.

TypeScript on Node 22, run with `tsx` (no build step). Three runtime dependencies (`@anthropic-ai/sdk`, `yaml`, `fast-xml-parser`), no frameworks.

## How it works

- **The receiver** ([worker/](worker/)) is a Cloudflare Worker with a D1 database. It answers Telegram right away, runs onboarding (Google sign-in to import subscriptions), handles commands and votes, and every 5 minutes starts a GitHub Actions run for anyone whose delivery time has come.
- **The digest builder** ([src/multi.ts](src/multi.ts), run by [.github/workflows/users.yml](.github/workflows/users.yml)) fetches new uploads, scores them, picks the day's videos, writes summaries and sends them.

Videos are picked in one of three modes, each falling back to the next:

| Mode | What picks the videos |
|---|---|
| `agent` (default) | A hand-written Claude tool-use loop that looks at stats and comments, then *proposes* a selection. Code checks it (budget, per-channel cap, length limits, Shorts mix) and sends rejections back with the reason. |
| `ai` | Claude rates each candidate 0–10 against the person's taste; the score blends that with the formula. |
| `formula` | No AI: views per hour relative to channel size, then a knapsack that fits the budget. |

The budget is a hard rule in code in every mode: a digest over budget crashes the run instead of being sent. The model only ever suggests; code decides and sends.

## When things go wrong

- **Every Claude step has a fallback that doesn't need Claude.** The agent falls back to AI ranking, and AI ranking falls back to the formula. A missing summary is replaced by the description's first line, or the title. The run log records which mode actually picked the videos.
- **Cost cap:** every Claude call's cost is estimated and counted per person per day. Past the cap, the run uses cheaper picking; past twice the cap, no Claude at all. The owner is exempt.
- **Out of credit:** digests still go out, and the owner gets a Telegram alert (at most once an hour).
- **Scheduling problems:** if the cron can't start a run, the owner is alerted, and `/users` shows a heartbeat from the last scheduled check.
- **Unreadable messages:** if Claude can't read a message, the bot says nothing changed and keeps the message to try again.

## Run your own

You need: a Telegram bot token (from @BotFather) and your own Telegram chat ID, a YouTube Data API key, a Google Cloud OAuth client of type "Web application", an Anthropic API key, a Cloudflare account and a GitHub fork of this repo.

1. `npm ci`
2. Create the database: `npx wrangler d1 create yt_digest --config worker/wrangler.toml`, put the printed `database_id` in [worker/wrangler.toml](worker/wrangler.toml), then `npm run db:migrate`.
3. In `wrangler.toml`, set `GITHUB_REPO` (your fork) and `BOT_USERNAME`. Set the receiver's secrets listed there with `npx wrangler secret put NAME --config worker/wrangler.toml`. `TELEGRAM_CHAT_ID` is your own chat, which makes you the owner. `GH_DISPATCH_TOKEN` is a fine-grained GitHub token with Actions read and write on your fork.
4. `npm run worker:deploy`, then point Telegram at it, using `WEBHOOK_SECRET` as the secret token:
   `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/telegram&secret_token=<WEBHOOK_SECRET>"`
5. In Google Cloud, add `https://<your-worker>.workers.dev/oauth/callback` as a redirect URI, and add each user's Google account as a test user.
6. In your fork's GitHub Actions secrets, set `YOUTUBE_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `EVENTS_URL` (the worker's address) and `EVENTS_TOKEN` (the same value as the worker's secret).
7. Send `/start` to your bot. As the owner, `/invite` makes one-time invite links for others.

[.env.example](.env.example) lists every variable. App-wide settings (models, mode, caps) are in [config.yaml](config.yaml); personal settings are set in the bot.

## Development

- `npm test`: unit and integration tests (`node:test`; Claude and Telegram are faked). The workflow runs them before every digest run.
- `npm run typecheck`
- `npm run digest:users -- --user <chat_id> --dry-run`: preview one person's digest without sending it.
- `npm run eval:select`, `npm run eval:summaries`, `npm run eval:ai`: offline evals against hand-labelled videos.

## More

- [HOW_IT_WORKS.md](HOW_IT_WORKS.md): a fuller tour of the system.
- [PLAN.md](PLAN.md): the design record from v1 (one user, formula only) through v3 (invite-only, multi-user), including the decisions that changed along the way.
