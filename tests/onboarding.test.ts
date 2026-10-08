import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import worker from "../worker/index.ts";
import * as db from "../worker/db.ts";
import { firstDigestDay, importedFromGoogle, parseHour, parseTimezone } from "../worker/onboarding.ts";

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let env: any;
let sent: { method: string; body: any }[] = [];
const realFetch = globalThis.fetch;

before(async () => {
  proxy = await getPlatformProxy({ configPath: "worker/wrangler.toml", persist: false });
  env = {
    ...(proxy.env as any),
    EVENTS: { put: async () => {}, get: async () => null, list: async () => ({ keys: [], list_complete: true }) },
    TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1", WEBHOOK_SECRET: "hook", EVENTS_TOKEN: "pull",
    GOOGLE_WEB_CLIENT_ID: "cid", GOOGLE_WEB_CLIENT_SECRET: "sec", YOUTUBE_API_KEY: "yk", ANTHROPIC_API_KEY: "ak", AI_MODEL: "m",
  };
  for (const s of readFileSync("worker/schema.sql", "utf8").replace(/--.*$/gm, "").split(";").map((x) => x.trim()).filter(Boolean)) {
    await env.DB.prepare(s).run();
  }
  // Fake Telegram: record every call.
  globalThis.fetch = (async (url: string, init: any) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      sent.push({ method: String(url).split("/").pop()!, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }
    return realFetch(url, init);
  }) as any;
});
after(async () => {
  globalThis.fetch = realFetch;
  await proxy?.dispose();
});

// Runs one update through the webhook and waits for the background handling to finish.
async function update(u: any) {
  const pending: Promise<unknown>[] = [];
  const res = await worker.fetch(
    new Request("https://bot.example/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "hook" }, body: JSON.stringify(u) }),
    env,
    { waitUntil: (p) => void pending.push(p) },
  );
  await Promise.all(pending);
  return res;
}
let id = 100;
const msg = (chat: string, text: string, extra: object = {}) => update({ update_id: id++, message: { chat: { id: Number(chat), type: "private" }, from: { first_name: "Ada" }, date: 1_780_000_000, text, ...extra } });
const tap = (chat: string, data: string) => update({ update_id: id++, callback_query: { id: `q${id}`, data, message: { message_id: 5, chat: { id: Number(chat) } } } });
const lastText = () => sent.filter((s) => s.method === "sendMessage").at(-1)?.body.text as string;

test("strangers get the invite-only message and no account", async () => {
  sent = [];
  await msg("777", "/start");
  assert.match(lastText(), /invite-only/);
  assert.equal(await db.getUser(env.DB, "777"), null);
  await msg("777", "/start not-a-code");
  assert.equal(await db.getUser(env.DB, "777"), null);
});

test("full onboarding with an invite: connect → budget → mix → hour → time zone → interests → active", async () => {
  const code = await db.createInvite(env.DB, "1");
  sent = [];
  await msg("200", `/start ${code}`);
  assert.match(sent[0].body.text, /Welcome, Ada/);
  const connect = sent.at(-1)!.body;
  assert.match(connect.text, /Step 1 of 6: connect YouTube/);
  assert.match(connect.reply_markup.inline_keyboard[0][0].url, /^https:\/\/bot\.example\/oauth\/start\?u=200&sig=/);

  // Google sign-in comes back with 3 channels (the /oauth/callback path calls this).
  await importedFromGoogle({ db: env.DB, tg: async (m, b) => void sent.push({ method: m, body: b }), origin: "https://bot.example", secret: "hook", youtubeApiKey: "", botToken: "t" }, "200",
    [{ id: "UCa", name: "A" }, { id: "UCb", name: "B" }, { id: "UCc", name: "C" }]);
  assert.match(sent.at(-2)!.body.text, /Found 3 channels/);
  assert.match(lastText(), /Step 2 of 6/);

  await tap("200", "ob|budget|90");
  assert.match(lastText(), /Step 3 of 6/);
  await tap("200", "ob|mix|shorts");
  assert.match(lastText(), /Step 4 of 6/);
  await msg("200", "8pm");
  assert.match(lastText(), /Step 5 of 6/);
  await msg("200", "Atlantis");
  assert.match(lastText(), /don't know that one/);
  await msg("200", "Accra");
  assert.match(lastText(), /Step 6 of 6/);
  await msg("200", "tech reviews and Nigerian food, no crypto");
  assert.match(lastText(), /You're set!/);
  assert.match(lastText(), /3 channels\n• 90 min a day, mostly shorts\n• Every day at 20:00 \(Africa\/Accra\)/);

  const u = (await db.getUser(env.DB, "200"))!;
  assert.deepEqual([u.status, u.budget_minutes, u.shorts_ratio, u.delivery_hour, u.timezone], ["active", 90, 0.7, 20, "Africa/Accra"]);
  assert.equal((await db.userState(env.DB, "200"))!.taste.notes, "tech reviews and Nigerian food, no crypto");

  // The invite is used up.
  sent = [];
  await msg("300", `/start ${code}`);
  assert.match(lastText(), /invite-only/);
});

test("after setup: taps are saved per user and answered instantly", async () => {
  sent = [];
  await tap("200", "u|vidAAAAAAA1|UCa");
  assert.equal(sent[0].method, "answerCallbackQuery");
  assert.match(sent[0].body.text, /Noted: more like this/);
  assert.deepEqual((await db.userState(env.DB, "200"))!.votes.map((v: any) => [v.video_id, v.vote]), [["vidAAAAAAA1", "up"]]);
});

test("old buttons from an earlier step are ignored", async () => {
  const code = await db.createInvite(env.DB, "1");
  await msg("400", `/start ${code}`);
  await tap("400", "ob|budget|30"); // not at that step yet
  assert.equal((await db.getUser(env.DB, "400"))!.budget_minutes, 60);
});

test("the owner can start without an invite", async () => {
  await msg("1", "/start");
  const u = (await db.getUser(env.DB, "1"))!;
  assert.equal(u.is_owner, 1);
  assert.equal(u.step, "connect");
});

test("sign-in link: forged signatures are refused; a real one redirects to Google with a stored state", async () => {
  const bad = await worker.fetch(new Request("https://bot.example/oauth/start?u=400&sig=forged"), env, { waitUntil() {} });
  assert.equal(bad.status, 403);
  sent = [];
  await msg("400", "/start"); // resend the connect prompt to get a real link
  const link = sent.at(-1)!.body.reply_markup.inline_keyboard[0][0].url;
  const res = await worker.fetch(new Request(link), env, { waitUntil() {} });
  assert.equal(res.status, 302);
  const google = new URL(res.headers.get("Location")!);
  assert.equal(google.origin, "https://accounts.google.com");
  assert.equal(google.searchParams.get("redirect_uri"), "https://bot.example/oauth/callback");
  assert.equal(google.searchParams.get("scope"), "https://www.googleapis.com/auth/youtube.readonly");
  assert.ok(await db.takeOAuthState(env.DB, google.searchParams.get("state")!));
});

test("parsing typed times and time zones", () => {
  assert.equal(parseHour("8pm"), 20);
  assert.equal(parseHour("07:30"), 7);
  assert.equal(parseHour("12am"), 0);
  assert.equal(parseHour("25"), null);
  assert.equal(parseTimezone("Lagos"), "Africa/Lagos");
  assert.equal(parseTimezone("Europe/Paris"), "Europe/Paris");
  assert.equal(parseTimezone("UTC+1"), "Etc/GMT-1");
  assert.equal(parseTimezone("GMT-5"), "Etc/GMT+5");
  assert.equal(parseTimezone("Narnia"), null);
  assert.equal(firstDigestDay("Africa/Lagos", 18, new Date("2026-10-09T10:00:00Z")), "today");
  assert.equal(firstDigestDay("Africa/Lagos", 18, new Date("2026-10-09T20:00:00Z")), "tomorrow");
});
