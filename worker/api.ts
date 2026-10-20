// Private API for the daily GitHub run (Bearer EVENTS_TOKEN). It reads and writes per-user data
// here instead of in repo files.
import * as db from "./db.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export async function handleApi(
  request: Request,
  env: { DB: db.D1; EVENTS_TOKEN: string },
  alertOwner: (key: string, text: string) => Promise<boolean>,
): Promise<Response> {
  if (request.headers.get("Authorization") !== `Bearer ${env.EVENTS_TOKEN}`) return json({ ok: false, error: "forbidden" }, 403);
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const body = request.method === "POST" ? ((await request.json().catch(() => null)) as any) : null;
  if (request.method === "POST" && !body) return json({ ok: false, error: "expected a JSON body" }, 400);

  // GET /api/due?at=<iso>  → users whose digest is due at that moment
  if (request.method === "GET" && parts[1] === "due") {
    const at = url.searchParams.get("at");
    const users = await db.dueUsers(env.DB, at ? new Date(at) : new Date());
    return json({ ok: true, users: users.map((u) => u.chat_id) });
  }

  // POST /api/alert {key, text} → Telegram to the owner, at most once an hour per key
  if (request.method === "POST" && parts[1] === "alert") {
    if (!body.key || !body.text) return json({ ok: false, error: "key and text are required" }, 400);
    return json({ ok: true, sent: await alertOwner(String(body.key), String(body.text).slice(0, 1000)) });
  }

  // /api/summaries/lookup and /api/summaries: shared summary cache
  if (parts[1] === "summaries" && request.method === "POST") {
    if (parts[2] === "lookup") return json({ ok: true, summaries: await db.getSummaries(env.DB, (body.videoIds ?? []).map(String)) });
    await db.putSummaries(env.DB, body.items ?? []);
    return json({ ok: true });
  }

  // /api/users/:id/...
  if (parts[1] === "users" && parts[2]) {
    const chatId = parts[2];
    const user = await db.getUser(env.DB, chatId);
    if (!user) return json({ ok: false, error: "no such user" }, 404);
    const action = parts[3];

    if (request.method === "GET" && action === "state") {
      return json({ ok: true, state: await db.userState(env.DB, chatId), costToday: await db.costToday(env.DB, chatId) });
    }
    if (request.method === "POST") {
      switch (action) {
        case "digest":
          await db.recordDigest(env.DB, chatId, {
            sentVideoIds: (body.sentVideoIds ?? []).map(String),
            lastRequestId: body.lastRequestId ?? null,
            costUsd: Number(body.costUsd ?? 0),
          });
          return json({ ok: true });
        case "taste":
          await db.saveLearnedTaste(env.DB, chatId, String(body.learned ?? ""), Number(body.votesUsed ?? 0));
          return json({ ok: true });
        case "ratings":
          await db.saveRatings(env.DB, chatId, String(body.cacheKey), body.items ?? []);
          return json({ ok: true });
        case "agent-notes":
          await db.addAgentNotes(env.DB, chatId, (body.notes ?? []).map(String));
          return json({ ok: true });
        case "cost":
          await db.addCost(env.DB, chatId, Number(body.costUsd ?? 0));
          return json({ ok: true });
      }
    }
  }
  return json({ ok: false, error: "not found" }, 404);
}
