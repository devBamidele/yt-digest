// Data layer over Cloudflare D1 (SQLite). Used by the receiver for onboarding and by the
// /api routes the daily GitHub run calls. Every row is keyed by Telegram chat_id.

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number };
}
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1 {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
}

export interface User {
  chat_id: string;
  name: string;
  status: "onboarding" | "active" | "paused";
  step: string;
  timezone: string;
  delivery_hour: number;
  budget_minutes: number;
  shorts_ratio: number;
  is_owner: number;
  created_at: string;
  last_digest_at: string | null;
}

export const SENT_KEEP_DAYS = 30;
export const MAX_AGENT_NOTES = 40;
const OAUTH_STATE_MINUTES = 15;
const iso = (d = new Date()) => d.toISOString();

// ---------- users & invites ----------

export const getUser = (db: D1, chatId: string) => db.prepare("SELECT * FROM users WHERE chat_id = ?").bind(chatId).first<User>();

export async function createUser(db: D1, chatId: string, name: string, isOwner = false): Promise<User> {
  await db
    .prepare("INSERT INTO users (chat_id, name, is_owner, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (chat_id) DO NOTHING")
    .bind(chatId, name, isOwner ? 1 : 0, iso())
    .run();
  await db.prepare("INSERT INTO taste (chat_id) VALUES (?) ON CONFLICT (chat_id) DO NOTHING").bind(chatId).run();
  return (await getUser(db, chatId))!;
}

const USER_FIELDS = ["name", "status", "step", "timezone", "delivery_hour", "budget_minutes", "shorts_ratio"] as const;
export async function updateUser(db: D1, chatId: string, fields: Partial<Pick<User, (typeof USER_FIELDS)[number]>>) {
  const keys = USER_FIELDS.filter((k) => fields[k] !== undefined);
  if (!keys.length) return;
  await db
    .prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE chat_id = ?`)
    .bind(...keys.map((k) => fields[k]), chatId)
    .run();
}

export async function listUsers(db: D1): Promise<User[]> {
  return (await db.prepare("SELECT * FROM users ORDER BY created_at").all<User>()).results;
}

export async function createInvite(db: D1, createdBy: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_"); // 12 url-safe chars
  await db.prepare("INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)").bind(code, createdBy, iso()).run();
  return code;
}

/** Marks an invite as used by this chat. False if the code doesn't exist or was already used. */
export async function redeemInvite(db: D1, code: string, chatId: string): Promise<boolean> {
  const r = await db
    .prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL")
    .bind(chatId, iso(), code)
    .run();
  return r.meta.changes === 1;
}

// ---------- channels ----------

/** Replaces the channel list; with `nextStep`, moves the user on in the same write (so they can't get stuck). */
export async function replaceCreators(db: D1, chatId: string, subs: { id: string; name: string }[], nextStep?: string) {
  const unique = [...new Map(subs.map((s) => [s.id, s])).values()];
  await db.batch([
    db.prepare("DELETE FROM creators WHERE chat_id = ?").bind(chatId),
    ...unique.map((s) => db.prepare("INSERT INTO creators (chat_id, channel_id, name) VALUES (?, ?, ?)").bind(chatId, s.id, s.name)),
    ...(nextStep ? [db.prepare("UPDATE users SET step = ? WHERE chat_id = ?").bind(nextStep, chatId)] : []),
  ]);
  return unique.length;
}

// ---------- feedback & requests ----------

export async function recordVote(db: D1, chatId: string, videoId: string, channelId: string, vote: "up" | "down", at = iso()) {
  await db
    .prepare(
      "INSERT INTO votes (chat_id, video_id, channel_id, vote, at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (chat_id, video_id) DO UPDATE SET vote = excluded.vote, channel_id = excluded.channel_id, at = excluded.at",
    )
    .bind(chatId, videoId, channelId, vote, at)
    .run();
}

export async function addRequest(db: D1, chatId: string, text: string, at = iso()) {
  await db.prepare("INSERT INTO requests (chat_id, text, at) VALUES (?, ?, ?)").bind(chatId, text.slice(0, 1000), at).run();
}

// ---------- everything the daily run needs for one user ----------

export async function userState(db: D1, chatId: string) {
  const user = await getUser(db, chatId);
  if (!user) return null;
  const cutoff = iso(new Date(Date.now() - SENT_KEEP_DAYS * 86400_000));
  const [creators, votes, sent, requests, taste, notes, ratings] = await db.batch([
    db.prepare("SELECT channel_id AS id, name FROM creators WHERE chat_id = ? ORDER BY name").bind(chatId),
    db.prepare("SELECT video_id, channel_id, vote, at FROM votes WHERE chat_id = ?").bind(chatId),
    db.prepare("SELECT video_id, at FROM sent WHERE chat_id = ? AND at >= ?").bind(chatId, cutoff),
    db.prepare("SELECT id, text, at FROM requests WHERE chat_id = ? ORDER BY id").bind(chatId),
    db.prepare("SELECT notes, learned, votes_used FROM taste WHERE chat_id = ?").bind(chatId),
    db.prepare("SELECT note, at FROM agent_notes WHERE chat_id = ? ORDER BY id").bind(chatId),
    db.prepare("SELECT video_id, cache_key, fit, reason FROM ratings WHERE chat_id = ?").bind(chatId),
  ]);
  return {
    user,
    creators: creators.results,
    votes: votes.results,
    sent: sent.results,
    requests: requests.results,
    taste: taste.results[0] ?? { notes: "", learned: "", votes_used: 0 },
    agentNotes: notes.results,
    ratings: ratings.results,
  };
}

/** Active users whose local delivery hour is now and who haven't had today's digest. */
export async function dueUsers(db: D1, at = new Date()): Promise<User[]> {
  const users = (await db.prepare("SELECT * FROM users WHERE status = 'active'").all<User>()).results;
  return users.filter((u) => {
    const local = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleString("en-CA", { timeZone: u.timezone, ...opts });
    const hour = Number(local(at, { hour: "2-digit", hourCycle: "h23" }));
    const today = local(at, { year: "numeric", month: "2-digit", day: "2-digit" });
    const last = u.last_digest_at && local(new Date(u.last_digest_at), { year: "numeric", month: "2-digit", day: "2-digit" });
    return hour === u.delivery_hour && last !== today;
  });
}

/** After a digest goes out: record what was sent, use up the requests, stamp the time, add the cost. */
export async function recordDigest(
  db: D1,
  chatId: string,
  r: { sentVideoIds: string[]; lastRequestId: number | null; costUsd: number; at?: string },
) {
  const at = r.at ?? iso();
  const cutoff = iso(new Date(Date.parse(at) - SENT_KEEP_DAYS * 86400_000));
  await db.batch([
    ...r.sentVideoIds.map((id) =>
      db.prepare("INSERT INTO sent (chat_id, video_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(chatId, id, at),
    ),
    db.prepare("DELETE FROM sent WHERE chat_id = ? AND at < ?").bind(chatId, cutoff),
    db.prepare("DELETE FROM requests WHERE chat_id = ? AND id <= ?").bind(chatId, r.lastRequestId ?? 0),
    db.prepare("UPDATE users SET last_digest_at = ? WHERE chat_id = ?").bind(at, chatId),
    addCostStatement(db, chatId, r.costUsd, at),
  ]);
}

function addCostStatement(db: D1, chatId: string, costUsd: number, at = iso()) {
  return db
    .prepare("INSERT INTO usage (chat_id, day, cost_usd) VALUES (?, ?, ?) ON CONFLICT (chat_id, day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd")
    .bind(chatId, at.slice(0, 10), costUsd);
}

export async function addCost(db: D1, chatId: string, costUsd: number) {
  await addCostStatement(db, chatId, costUsd).run();
}

export async function costToday(db: D1, chatId: string): Promise<number> {
  const row = await db.prepare("SELECT cost_usd FROM usage WHERE chat_id = ? AND day = ?").bind(chatId, iso().slice(0, 10)).first<{ cost_usd: number }>();
  return row?.cost_usd ?? 0;
}

// ---------- taste, agent notes, ratings ----------

export async function setTasteNotes(db: D1, chatId: string, notes: string) {
  await db.prepare("UPDATE taste SET notes = ?, updated_at = ? WHERE chat_id = ?").bind(notes.slice(0, 2000), iso(), chatId).run();
}

export async function saveLearnedTaste(db: D1, chatId: string, learned: string, votesUsed: number) {
  await db.prepare("UPDATE taste SET learned = ?, votes_used = ?, updated_at = ? WHERE chat_id = ?").bind(learned, votesUsed, iso(), chatId).run();
}

export async function addAgentNotes(db: D1, chatId: string, notes: string[]) {
  if (!notes.length) return;
  await db.batch([
    ...notes.map((n) => db.prepare("INSERT INTO agent_notes (chat_id, note, at) VALUES (?, ?, ?)").bind(chatId, n.slice(0, 300), iso())),
    db
      .prepare("DELETE FROM agent_notes WHERE chat_id = ? AND id NOT IN (SELECT id FROM agent_notes WHERE chat_id = ? ORDER BY id DESC LIMIT ?)")
      .bind(chatId, chatId, MAX_AGENT_NOTES),
  ]);
}

/** Replaces cached ratings when the cache key (profile + request + model) changed; otherwise adds to them. */
export async function saveRatings(db: D1, chatId: string, cacheKey: string, items: { video_id: string; fit: number; reason: string }[]) {
  await db.batch([
    db.prepare("DELETE FROM ratings WHERE chat_id = ? AND cache_key != ?").bind(chatId, cacheKey),
    ...items.map((r) =>
      db
        .prepare("INSERT OR REPLACE INTO ratings (chat_id, video_id, cache_key, fit, reason) VALUES (?, ?, ?, ?, ?)")
        .bind(chatId, r.video_id, cacheKey, r.fit, r.reason),
    ),
  ]);
}

// ---------- shared summaries ----------

export async function getSummaries(db: D1, videoIds: string[]) {
  const out: { video_id: string; summary: string; model: string; prompt_version: number }[] = [];
  for (let i = 0; i < videoIds.length; i += 90) {
    const ids = videoIds.slice(i, i + 90); // stay under SQLite's bound-parameter limit
    const r = await db
      .prepare(`SELECT video_id, summary, model, prompt_version FROM summaries WHERE video_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<(typeof out)[number]>();
    out.push(...r.results);
  }
  return out;
}

export async function putSummaries(db: D1, items: { video_id: string; summary: string; model: string; prompt_version: number }[]) {
  if (!items.length) return;
  await db.batch(
    items.map((s) =>
      db
        .prepare("INSERT OR REPLACE INTO summaries (video_id, summary, model, prompt_version, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(s.video_id, s.summary, s.model, s.prompt_version, iso()),
    ),
  );
}

// ---------- Google sign-in ----------

export async function putOAuthState(db: D1, state: string, chatId: string, verifier: string) {
  await db.batch([
    db.prepare("DELETE FROM oauth_states WHERE created_at < ?").bind(iso(new Date(Date.now() - OAUTH_STATE_MINUTES * 60_000))),
    db.prepare("INSERT INTO oauth_states (state, chat_id, verifier, created_at) VALUES (?, ?, ?, ?)").bind(state, chatId, verifier, iso()),
  ]);
}

/** One-time use: returns and deletes the state if it exists and hasn't expired. */
export async function takeOAuthState(db: D1, state: string) {
  const row = await db.prepare("SELECT chat_id, verifier, created_at FROM oauth_states WHERE state = ?").bind(state).first<{ chat_id: string; verifier: string; created_at: string }>();
  await db.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();
  if (!row || Date.now() - Date.parse(row.created_at) > OAUTH_STATE_MINUTES * 60_000) return null;
  return row;
}

// ---------- /delete ----------

export async function deleteUser(db: D1, chatId: string) {
  const tables = ["creators", "votes", "sent", "requests", "taste", "agent_notes", "ratings", "usage", "oauth_states", "users"];
  await db.batch(tables.map((t) => db.prepare(`DELETE FROM ${t} WHERE chat_id = ?`).bind(chatId)));
}
