import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { whenNext } from "../worker/index.ts";

test("reply timing follows Lagos time", () => {
  assert.equal(whenNext(new Date("2026-10-09T09:00:00Z")), "tonight around 6pm"); // 10:00 Lagos
  assert.equal(whenNext(new Date("2026-10-09T16:45:00Z")), "in your next digest"); // 17:45
  assert.equal(whenNext(new Date("2026-10-09T18:00:00Z")), "tomorrow around 6pm"); // 19:00
});

// A fake KV store and env, to check the webhook's security and storage without Cloudflare.
function setup() {
  const store = new Map<string, string>();
  const env = {
    EVENTS: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      list: async ({ prefix }: { prefix: string }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
    },
    TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "42", ANTHROPIC_API_KEY: "k", WEBHOOK_SECRET: "hook", EVENTS_TOKEN: "pull", AI_MODEL: "m",
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  return { store, env, ctx, pending };
}
const post = (body: object, secret = "hook") =>
  new Request("https://w/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify(body) });

test("webhook: rejects posts without Telegram's secret; stores real updates", async () => {
  const { store, env, ctx } = setup();
  assert.equal((await worker.fetch(post({ update_id: 1 }, "wrong"), env as any, ctx)).status, 403);
  assert.equal(store.size, 0);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}")) as any; // swallow the answerCallbackQuery
  try {
    const res = await worker.fetch(post({ update_id: 7, callback_query: { id: "q", data: "u|x|y", message: { chat: { id: 42 } } } }), env as any, ctx);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(store.has("u:000000000007"));
});

test("events endpoint needs the pull token and returns updates from the cursor on, in order", async () => {
  const { store, env, ctx } = setup();
  for (const id of [12, 3, 9]) store.set(`u:${String(id).padStart(12, "0")}`, JSON.stringify({ update_id: id }));
  const get = (auth: string, after: number) =>
    worker.fetch(new Request(`https://w/events?after=${after}`, { headers: { Authorization: auth } }), env as any, ctx);
  assert.equal((await get("Bearer nope", 0)).status, 403);
  const body = (await (await get("Bearer pull", 9)).json()) as any;
  assert.deepEqual(body.result.map((u: any) => u.update_id), [9, 12]);
});
