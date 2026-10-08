-- YouTube digest v3: per-user data. Apply with: npm run db:migrate
-- Every table is keyed by Telegram chat_id; /delete removes a user's rows from all of them.

CREATE TABLE IF NOT EXISTS users (
  chat_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'onboarding', -- onboarding | active | paused
  step TEXT NOT NULL DEFAULT 'connect',      -- onboarding step, see worker/onboarding.ts
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  delivery_hour INTEGER NOT NULL DEFAULT 18, -- local time: hour 0-23 …
  delivery_minute INTEGER NOT NULL DEFAULT 0, -- … and minute, in 5-minute steps
  budget_minutes INTEGER NOT NULL DEFAULT 60,
  shorts_ratio REAL NOT NULL DEFAULT 0.4,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_digest_at TEXT,                        -- taps after this count as "since the last digest"
  next_digest_at TEXT                         -- one-off delivery time from a message (UTC), if any
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_by TEXT,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS creators (
  chat_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (chat_id, channel_id)
);

CREATE TABLE IF NOT EXISTS votes (
  chat_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  vote TEXT NOT NULL, -- up | down; the latest tap on a video wins
  at TEXT NOT NULL,
  PRIMARY KEY (chat_id, video_id)
);

CREATE TABLE IF NOT EXISTS sent (
  chat_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (chat_id, video_id)
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS taste (
  chat_id TEXT PRIMARY KEY,
  notes TEXT NOT NULL DEFAULT '',   -- the user's own words; never rewritten by Claude
  learned TEXT NOT NULL DEFAULT '', -- rewritten by Claude from votes
  votes_used INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  note TEXT NOT NULL,
  at TEXT NOT NULL
);

-- AI ratings are only valid for one taste profile + request + model (cache_key).
CREATE TABLE IF NOT EXISTS ratings (
  chat_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  fit INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (chat_id, video_id)
);

-- Summaries depend only on the video, so they're shared by everyone.
CREATE TABLE IF NOT EXISTS summaries (
  video_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  chat_id TEXT NOT NULL,
  day TEXT NOT NULL, -- YYYY-MM-DD, UTC
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, day)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sent_by_time ON sent (chat_id, at);
CREATE INDEX IF NOT EXISTS votes_by_time ON votes (chat_id, at);
CREATE INDEX IF NOT EXISTS requests_by_user ON requests (chat_id, id);
