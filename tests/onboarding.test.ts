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
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } })); // like Telegram
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
// The last message the bot sent, ignoring the pinned status line it refreshes after changes.
const isStatus = (t: string) => /^(📺|⏸)/.test(t ?? "");
const lastText = () => sent.filter((s) => s.method === "sendMessage" && !isStatus(s.body.text)).at(-1)?.body.text as string;

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
  // The live "next digest" status is posted and pinned.
  assert.ok(sent.some((x) => x.method === "sendMessage" && /^📺 /.test(x.body.text)));
  assert.ok(sent.some((x) => x.method === "pinChatMessage"));
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
  assert.match(lastText(), /✓ Delivery time: 07:15 [\s\S]*Next digest/);
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
  assert.match(lastText(), /Ada: active, 1 channels, daily 07:15 Europe\/London, next (today|tomorrow|tonight) at 7:15am/);
  // A one-off time from a message shows as the next digest, while the daily time stays.
  const daily = nextDigest((await db.getUser(env.DB, "1"))!);
  await db.updateUser(env.DB, "1", { next_digest_at: new Date(Date.now() + 2 * 3600_000).toISOString() });
  const oneOff = nextDigest((await db.getUser(env.DB, "1"))!);
  assert.notEqual(oneOff, daily);
  await msg("1", "/users");
  assert.ok(lastText().includes(`next ${oneOff},`), lastText());
  await db.updateUser(env.DB, "1", { next_digest_at: null });
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

test("ambiguous times ask morning or evening; leading zero and 24h times don't", async () => {
  const amb = (s: string) => parseTime(s)?.ambiguous;
  assert.equal(amb("11:00"), true);
  assert.equal(amb("7"), true);
  assert.equal(amb("07:00"), false);
  assert.equal(amb("23:00"), false);
  assert.equal(amb("11pm"), false);

  const code = await db.createInvite(env.DB, "1");
  await msg("600", `/start ${code}`);
  await importedFromGoogle({ db: env.DB, tg: async (m, b) => void sent.push({ method: m, body: b }), origin: "https://bot.example", secret: "hook", youtubeApiKey: "", botToken: "t" }, "600", [{ id: "UCa", name: "A" }]);
  await tap("600", "ob|budget|30");
  await tap("600", "ob|mix|balanced");
  sent = [];
  await msg("600", "11:00");
  const q = sent.at(-1)!.body;
  assert.equal(q.text, "Morning or evening?");
  assert.deepEqual(q.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data), ["ob|hour|11:0", "ob|hour|23:0"]);
  assert.equal((await db.getUser(env.DB, "600"))!.step, "hour"); // still waiting for the answer
  await tap("600", "ob|hour|23:0");
  const u = (await db.getUser(env.DB, "600"))!;
  assert.deepEqual([u.delivery_hour, u.delivery_minute, u.step], [23, 0, "timezone"]);
});

test("one-off delivery times: due at that moment, once, replacing the usual time until then", async () => {
  const { nextOccurrence } = await import("../worker/time.ts");
  const lagos = (s: string) => new Date(`2026-10-09T${s}:00+01:00`);
  const at = nextOccurrence({ hour: 23, minute: 10 }, "Africa/Lagos", lagos("23:04"));
  assert.equal(at.toISOString(), "2026-10-09T22:10:00.000Z");
  assert.equal(nextOccurrence({ hour: 7, minute: 0 }, "Africa/Lagos", lagos("21:00")).toISOString(), "2026-10-10T06:00:00.000Z"); // tomorrow
  const u = { timezone: "Africa/Lagos", delivery_hour: 11, delivery_minute: 0, last_digest_at: null as string | null, next_digest_at: at.toISOString() };
  assert.equal(isDue(u, lagos("23:05")), false);
  assert.equal(isDue(u, lagos("23:10")), true);
  assert.equal(nextDigest(u, lagos("23:04")), "today at 11:10pm");
  assert.equal(isDue({ ...u, last_digest_at: lagos("23:11").toISOString() }, lagos("23:15")), false); // delivered once
});

test("the one-time sign-in state can be claimed only once, even by simultaneous loads", async () => {
  await db.putOAuthState(env.DB, "race", "600", "ver");
  const [a, b] = await Promise.all([db.takeOAuthState(env.DB, "race"), db.takeOAuthState(env.DB, "race")]);
  assert.equal([a, b].filter(Boolean).length, 1);
});

test("sign-in callback answers the browser at once and imports in the background", async () => {
  await db.putOAuthState(env.DB, "st2", "600", "ver");
  const pending: Promise<unknown>[] = [];
  const res = await worker.fetch(new Request("https://bot.example/oauth/callback?state=st2&error=access_denied"), env, { waitUntil: (p) => void pending.push(p) });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Sign-in cancelled/);
  sent = [];
  await Promise.all(pending);
  assert.match(lastText(), /Google sign-in was cancelled/);
  // A second (duplicate) load does nothing in the background.
  const pending2: Promise<unknown>[] = [];
  await worker.fetch(new Request("https://bot.example/oauth/callback?state=st2&error=access_denied"), env, { waitUntil: (p) => void pending2.push(p) });
  sent = [];
  await Promise.all(pending2);
  assert.equal(sent.length, 0);
});

// Stand-in for Claude reading a request. The SDK client keeps the fetch it first saw, so install one
// stand-in and switch what it returns.
let claudeParse: object = {};
let claudeInstalled = false;
function fakeClaude(parse: object) {
  claudeParse = parse;
  if (!claudeInstalled) {
    claudeInstalled = true;
    const prev = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).includes("api.anthropic.com")) {
        return new Response(JSON.stringify({
          id: "msg", type: "message", role: "assistant", model: "m", stop_reason: "end_turn", stop_sequence: null,
          content: [{ type: "text", text: JSON.stringify({ budget_minutes: 0, shorts_share: -1, avoid: [], prefer: [], skip_today: false, deliver_at: "", daily_time: "", summary: "", ...claudeParse }) }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { headers: { "Content-Type": "application/json" } });
      }
      return prev(url, init);
    }) as any;
  }
  return () => {};
}

test("messages: refused 'send it now' is plain, questions get the time, only content changes are stored", async () => {
  const code = await db.createInvite(env.DB, "1");
  await msg("700", `/start ${code}`);
  await db.updateUser(env.DB, "700", { status: "active", step: "done", delivery_hour: 0, delivery_minute: 30 });
  await env.DB.prepare("UPDATE users SET last_digest_at = ? WHERE chat_id = '700'").bind(new Date(Date.now() - 3600_000).toISOString()).run();

  let restore = fakeClaude({ deliver_at: "now", summary: "Send digest now" });
  sent = [];
  await msg("700", "Send it now");
  restore();
  let reply = lastText();
  assert.match(reply, /^⏳ You get one digest a day, so I can't send one now\.\n📺 Next digest: .+ \(in .+\)\.$/);
  assert.doesNotMatch(reply, /Got it/);

  restore = fakeClaude({});
  await msg("700", "When is the next digest exactly?");
  restore();
  assert.match(lastText(), /📺 Next digest: /);

  restore = fakeClaude({ budget_minutes: 30, summary: "30 min" });
  await msg("700", "only 30 min tonight");
  restore();
  assert.match(lastText(), /✅ For your next digest: <b>30 min<\/b>\./);

  const stored = (await db.userState(env.DB, "700"))!.requests.map((r: any) => r.text);
  assert.deepEqual(stored, ["only 30 min tonight"]); // not "Send it now", not the question
});
