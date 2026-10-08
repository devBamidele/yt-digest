import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import worker from "../worker/index.ts";
import * as db from "../worker/db.ts";
import { importedFromGoogle, parseTimezone } from "../worker/onboarding.ts";
import { isDue, nextDigest, parseTime } from "../worker/time.ts";

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let env: any;
let sent: { method: string; body: any }[] = [];
const realFetch = globalThis.fetch;

before(async () => {
  proxy = await getPlatformProxy({ configPath: "worker/wrangler.toml", persist: false });
  env = {
    ...(proxy.env as any),
    TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1", WEBHOOK_SECRET: "hook", EVENTS_TOKEN: "pull",
    GOOGLE_WEB_CLIENT_ID: "cid", BOT_USERNAME: "test_bot", GOOGLE_WEB_CLIENT_SECRET: "sec", YOUTUBE_API_KEY: "yk", ANTHROPIC_API_KEY: "ak", AI_MODEL: "m",
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
  await msg("200", "8:32pm");
  assert.match(sent.filter((s) => s.method === "sendMessage").at(-2)!.body.text, /I'll use <b>20:30<\/b>/);
  assert.match(lastText(), /Step 5 of 6/);
  await msg("200", "Atlantis");
  assert.match(lastText(), /don't know that one/);
  await msg("200", "Accra");
  assert.match(lastText(), /Step 6 of 6/);
  await msg("200", "tech reviews and Nigerian food, no crypto");
  assert.match(lastText(), /You're set!/);
  assert.match(lastText(), /3 channels\n• 90 min a day, mostly shorts\n• Every day at 20:30 \(Africa\/Accra\)/);

  const u = (await db.getUser(env.DB, "200"))!;
  assert.deepEqual([u.status, u.budget_minutes, u.shorts_ratio, u.delivery_hour, u.delivery_minute, u.timezone], ["active", 90, 0.7, 20, 30, "Africa/Accra"]);
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
  const t = (s: string) => {
    const r = parseTime(s);
    return r && `${r.hour}:${r.minute}${r.rounded ? " (rounded)" : ""}`;
  };
  assert.equal(t("8pm"), "20:0");
  assert.equal(t("22:30"), "22:30");
  assert.equal(t("7:15am"), "7:15");
  assert.equal(t("22.45"), "22:45");
  assert.equal(t("22:32"), "22:30 (rounded)");
  assert.equal(t("10:58"), "11:0 (rounded)");
  assert.equal(t("23:58"), "0:0 (rounded)");
  assert.equal(t("12am"), "0:0");
  assert.equal(t("25"), null);
  assert.equal(t("13pm"), null);
  assert.equal(t("10:75"), null);
  assert.equal(parseTimezone("Lagos"), "Africa/Lagos");
  assert.equal(parseTimezone("Europe/Paris"), "Europe/Paris");
  assert.equal(parseTimezone("UTC+1"), "Etc/GMT-1");
  assert.equal(parseTimezone("GMT-5"), "Etc/GMT+5");
  assert.equal(parseTimezone("Narnia"), null);
});

test("due at the delivery minute, within the catch-up window, once a day", () => {
  const u = { timezone: "Africa/Lagos", delivery_hour: 22, delivery_minute: 30, last_digest_at: null as string | null };
  const lagos = (hhmm: string) => new Date(`2026-10-09T${hhmm}:00+01:00`);
  assert.equal(isDue(u, lagos("22:25")), false);
  assert.equal(isDue(u, lagos("22:30")), true);
  assert.equal(isDue(u, lagos("22:55")), true); // a missed check catches up
  assert.equal(isDue(u, lagos("23:00")), false); // but not hours later
  assert.equal(isDue({ ...u, last_digest_at: lagos("22:31").toISOString() }, lagos("22:35")), false); // already sent today
  assert.equal(nextDigest(u, lagos("10:00")), "today at 10:30pm");
  assert.equal(nextDigest(u, lagos("22:40")), "in the next few minutes");
  assert.equal(nextDigest(u, lagos("23:30")), "tomorrow at 10:30pm");
});

test("/settings: buttons change watch time and mix; typed answers change time and time zone", async () => {
  sent = [];
  await msg("200", "/settings");
  assert.match(lastText(), /Your settings[\s\S]*Watch time: 90 min/);
  await tap("200", "set|budget");
  await tap("200", "set|budget|120");
  assert.match(lastText(), /✓ Watch time: 120 min/);
  await tap("200", "set|mix|long");
  await tap("200", "set|hour");
  await msg("200", "7am");
  assert.match(lastText(), /✓ Delivery time: 07:00/);
  await tap("200", "set|hour");
  await msg("200", "7:15am");
  assert.match(lastText(), /✓ Delivery time: 07:15 .*Next digest/);
  await tap("200", "set|timezone");
  await msg("200", "London");
  const u = (await db.getUser(env.DB, "200"))!;
  assert.deepEqual([u.budget_minutes, u.shorts_ratio, u.delivery_hour, u.delivery_minute, u.timezone, u.step], [120, 0.2, 7, 15, "Europe/London", "done"]);
  // Typed setting answers are not saved as requests.
  assert.equal((await db.userState(env.DB, "200"))!.requests.length, 0);
});

test("/pause stops digests, /resume restarts them", async () => {
  await msg("200", "/pause");
  assert.equal((await db.getUser(env.DB, "200"))!.status, "paused");
  assert.ok(!(await db.dueUsers(env.DB, new Date("2026-10-10T06:15:00Z"))).some((u) => u.chat_id === "200")); // 07:15 London
  await msg("200", "/resume");
  assert.ok((await db.dueUsers(env.DB, new Date("2026-10-10T06:15:00Z"))).some((u) => u.chat_id === "200"));
});

test("/sync asks to sign in again and replaces the channel list without redoing setup", async () => {
  sent = [];
  await msg("200", "/sync");
  assert.match(sent.at(-1)!.body.reply_markup.inline_keyboard[0][0].url, /oauth\/start\?u=200/);
  await importedFromGoogle({ db: env.DB, tg: async (m, b) => void sent.push({ method: m, body: b }), origin: "https://bot.example", secret: "hook", youtubeApiKey: "", botToken: "t" }, "200", [{ id: "UCz", name: "Z" }]);
  assert.match(lastText(), /Updated: 1 channels/);
  const u = (await db.getUser(env.DB, "200"))!;
  assert.deepEqual([u.status, u.step], ["active", "done"]);
});

test("owner-only commands: /invite and /users", async () => {
  sent = [];
  await msg("200", "/invite"); // not the owner
  assert.match(lastText(), /don't know that command/);
  await db.updateUser(env.DB, "1", { status: "active", step: "done" });
  await msg("1", "/invite");
  assert.match(lastText(), /https:\/\/t\.me\/test_bot\?start=[\w-]{12}/);
  await msg("1", "/users");
  assert.match(lastText(), /Ada: active, 1 channels, 07:15 Europe\/London/);
});

test("/delete asks first, then erases everything", async () => {
  await msg("200", "/delete");
  await tap("200", "del|no");
  assert.ok(await db.getUser(env.DB, "200"));
  await tap("200", "del|yes");
  assert.equal(await db.getUser(env.DB, "200"), null);
  assert.match(lastText(), /Everything about you is deleted/);
  sent = [];
  await msg("200", "hello?");
  assert.match(lastText(), /invite-only/);
});
