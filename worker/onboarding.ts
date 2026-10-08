// Guided setup in the bot: connect YouTube → watch time → shorts mix → delivery time → time zone → interests.
// Each step's answer comes from a button (callback "ob|<field>|<value>") or typed text.
import { subsFromCsv, type Sub } from "../src/subs.ts";
import * as db from "./db.ts";
import { connectLink, SubsError, subscriptionsForHandle } from "./google.ts";

export type Tg = (method: string, payload: Record<string, unknown>) => Promise<any>;

export interface OnboardingCtx {
  db: db.D1;
  tg: Tg;
  origin: string; // the worker's public URL
  secret: string; // signs "Connect YouTube" links
  youtubeApiKey: string;
  botToken: string; // to download an uploaded CSV
}

export const STEPS = ["connect", "budget", "mix", "hour", "timezone", "taste"] as const;
const stepNo = (s: string) => `Step ${STEPS.indexOf(s as any) + 1} of ${STEPS.length}`;

const btn = (text: string, data: string) => ({ text, callback_data: `ob|${data}` });
const rows = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export const MIXES: Record<string, { label: string; ratio: number }> = {
  long: { label: "Mostly long videos", ratio: 0.2 },
  balanced: { label: "Balanced", ratio: 0.4 },
  shorts: { label: "Mostly shorts", ratio: 0.7 },
};
const HOURS = [7, 12, 17, 18, 20, 21];
const ZONES: [string, string][] = [
  ["Lagos / Abuja", "Africa/Lagos"],
  ["London", "Europe/London"],
  ["New York", "America/New_York"],
  ["Nairobi", "Africa/Nairobi"],
  ["Johannesburg", "Africa/Johannesburg"],
  ["Dubai", "Asia/Dubai"],
];
const CITY_ZONES: Record<string, string> = {
  lagos: "Africa/Lagos", abuja: "Africa/Lagos", "port harcourt": "Africa/Lagos", ibadan: "Africa/Lagos", nigeria: "Africa/Lagos",
  accra: "Africa/Accra", ghana: "Africa/Accra", nairobi: "Africa/Nairobi", kenya: "Africa/Nairobi", kigali: "Africa/Kigali",
  kampala: "Africa/Kampala", johannesburg: "Africa/Johannesburg", "cape town": "Africa/Johannesburg", cairo: "Africa/Cairo",
  london: "Europe/London", uk: "Europe/London", dublin: "Europe/Dublin", paris: "Europe/Paris", berlin: "Europe/Berlin",
  amsterdam: "Europe/Amsterdam", madrid: "Europe/Madrid", lisbon: "Europe/Lisbon", dubai: "Asia/Dubai",
  "new york": "America/New_York", nyc: "America/New_York", toronto: "America/Toronto", chicago: "America/Chicago",
  "los angeles": "America/Los_Angeles", la: "America/Los_Angeles", "san francisco": "America/Los_Angeles",
};

const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** "Lagos", "Europe/London", "UTC+1", "GMT-5" → an IANA time zone, or null. */
export function parseTimezone(text: string): string | null {
  const t = text.trim();
  const city = CITY_ZONES[t.toLowerCase()];
  if (city) return city;
  if (t.includes("/") && validZone(t)) return t;
  const m = t.match(/^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?00)?$/i);
  if (m) {
    const h = Number(m[2]);
    if (h > 14) return null;
    return h === 0 ? "Etc/UTC" : `Etc/GMT${m[1] === "+" ? "-" : "+"}${h}`; // Etc/ zones have inverted signs
  }
  if (/^(utc|gmt)$/i.test(t)) return "Etc/UTC";
  return null;
}

/** "18", "6pm", "18:00", "7:30am" → hour 0-23 (minutes are dropped), or null. */
export function parseHour(text: string): number | null {
  const m = text.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return h >= 0 && h <= 23 ? h : null;
}

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** Sends the prompt for the user's current step. */
export async function prompt(ctx: OnboardingCtx, user: db.User): Promise<void> {
  const chat_id = user.chat_id;
  const send = (text: string, keyboard?: object[][]) =>
    ctx.tg("sendMessage", { chat_id, text, parse_mode: "HTML", ...(keyboard && { reply_markup: { inline_keyboard: keyboard } }) });
  switch (user.step) {
    case "connect":
      return void (await send(
        `<b>${stepNo("connect")}: connect YouTube</b>\n\nSo I know which channels you follow. I only read your subscription list, once; I never post, like or change anything.\n\n` +
          `<i>If Google says "Access blocked", ask whoever invited you to add your Gmail as a tester, or use one of the other options.</i>`,
        [
          [{ text: "🔗 Connect YouTube", url: await connectLink(ctx.origin, chat_id, ctx.secret) }],
          [btn("📄 Send a Takeout file instead", "alt|csv"), btn("@ Use my @handle", "alt|handle")],
        ],
      ));
    case "budget":
      return void (await send(`<b>${stepNo("budget")}: how much time do you usually have?</b>\n\nYou can change it for any day by messaging me, e.g. "only 30 min tonight".`, [
        [btn("30 min", "budget|30"), btn("1 hour", "budget|60"), btn("1½ hours", "budget|90"), btn("2 hours", "budget|120")],
      ]));
    case "mix":
      return void (await send(`<b>${stepNo("mix")}: shorts or long videos?</b>`, [
        Object.entries(MIXES).map(([k, m]) => btn(m.label, `mix|${k}`)),
      ]));
    case "hour":
      return void (await send(`<b>${stepNo("hour")}: when should your digest arrive?</b>\n\nOr type a time, e.g. "8am" or "19:00".`, rows(HOURS.map((h) => btn(hh(h), `hour|${h}`)), 3)));
    case "timezone":
      return void (await send(`<b>${stepNo("timezone")}: which time zone are you in?</b>\n\nOr type your city or UTC offset, e.g. "Accra" or "UTC+1".`, rows(ZONES.map(([l, z]) => btn(l, `tz|${z}`)), 2)));
    case "taste":
      return void (await send(
        `<b>${stepNo("taste")}: what are you into?</b>\n\nTell me in your own words: topics, moods, things to avoid. E.g. <i>"tech reviews, Nigerian food, true stories; no crypto or football"</i>. I'll keep learning from your 👍/👎 too.`,
        [[btn("Skip for now", "taste|skip")]],
      ));
  }
}

async function advance(ctx: OnboardingCtx, chatId: string, from: string) {
  const next = STEPS[STEPS.indexOf(from as any) + 1];
  if (next) {
    await db.updateUser(ctx.db, chatId, { step: next });
    await prompt(ctx, (await db.getUser(ctx.db, chatId))!);
  } else {
    await finish(ctx, chatId);
  }
}

/** First digest: today if the delivery hour is still ahead in their time zone, else tomorrow. */
export function firstDigestDay(timezone: string, hour: number, now = new Date()): "today" | "tomorrow" {
  const localHour = Number(now.toLocaleString("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }));
  return localHour < hour ? "today" : "tomorrow";
}

async function finish(ctx: OnboardingCtx, chatId: string) {
  await db.updateUser(ctx.db, chatId, { status: "active", step: "done" });
  const u = (await db.getUser(ctx.db, chatId))!;
  const channels = (await db.userState(ctx.db, chatId))!.creators.length;
  const mix = Object.values(MIXES).find((m) => m.ratio === u.shorts_ratio)?.label.toLowerCase() ?? `${Math.round(u.shorts_ratio * 100)}% shorts`;
  await ctx.tg("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      `🎉 <b>You're set!</b>\n\n• ${channels} channels\n• ${u.budget_minutes} min a day, ${mix}\n• Every day at ${hh(u.delivery_hour)} (${u.timezone})\n\n` +
      `Your first digest arrives ${firstDigestDay(u.timezone, u.delivery_hour)} at ${hh(u.delivery_hour)}.\n\n` +
      `Message me any time to change a day ("30 min, only shorts, something funny"), tap 👍/👎 on videos to teach me, and use /settings to change your defaults.`,
  });
}

async function imported(ctx: OnboardingCtx, chatId: string, subs: Sub[], how: string) {
  if (subs.length === 0) {
    await ctx.tg("sendMessage", { chat_id: chatId, text: `I couldn't find any channels ${how}. Try another option.` });
    return;
  }
  const n = await db.replaceCreators(ctx.db, chatId, subs);
  const user = await db.getUser(ctx.db, chatId);
  if (user && user.status !== "onboarding") {
    // /sync from someone already set up: just replace the list.
    await db.updateUser(ctx.db, chatId, { step: "done" });
    await ctx.tg("sendMessage", { chat_id: chatId, text: `✅ Updated: ${n} channels ${how}. Your next digest uses the new list.` });
    return;
  }
  await ctx.tg("sendMessage", { chat_id: chatId, text: `✅ Found ${n} channels ${how}.` });
  await advance(ctx, chatId, "connect");
}

/** A Takeout subscriptions.csv sent as a Telegram document (setup or /sync). */
export async function importCsvDocument(ctx: OnboardingCtx, chatId: string, document: any): Promise<void> {
  if (!/\.csv$/i.test(document?.file_name ?? "")) {
    await ctx.tg("sendMessage", { chat_id: chatId, text: "Please send the <code>subscriptions.csv</code> file from your Takeout export.", parse_mode: "HTML" });
    return;
  }
  const file = await ctx.tg("getFile", { file_id: document.file_id });
  const res = await fetch(`https://api.telegram.org/file/bot${ctx.botToken}/${file?.result?.file_path}`);
  return imported(ctx, chatId, subsFromCsv(await res.text()), "in your Takeout file");
}

/** Called by /oauth/callback once Google sign-in returned the subscriptions. */
export const importedFromGoogle = (ctx: OnboardingCtx, chatId: string, subs: Sub[]) => imported(ctx, chatId, subs, "you follow on YouTube");

/** Handles one Telegram update from a user who is still onboarding. */
export async function handleOnboarding(ctx: OnboardingCtx, user: db.User, update: any): Promise<void> {
  const chatId = user.chat_id;
  const q = update.callback_query;

  if (q) {
    const [tag, field, value] = String(q.data ?? "").split("|");
    await ctx.tg("answerCallbackQuery", { callback_query_id: q.id });
    if (tag !== "ob") return;
    // Remove the buttons from the answered question, so old ones can't be tapped again.
    if (q.message?.message_id) await ctx.tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });

    if (field === "alt" && user.step === "connect") {
      const text =
        value === "csv"
          ? `📄 <b>Takeout file</b>\n1. Go to takeout.google.com, click <b>Deselect all</b>, tick <b>YouTube and YouTube Music</b>.\n2. Under "All YouTube data included", keep only <b>subscriptions</b>.\n3. Create the export, unzip it, and send me <code>subscriptions.csv</code> here.`
          : `@ <b>Your handle</b>\nSend me your YouTube @handle (e.g. <code>@yourname</code>). This only works if your subscriptions are public (YouTube → Settings → Privacy).`;
      await ctx.tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
      return;
    }
    if (field !== user.step && !(field === "tz" && user.step === "timezone")) return; // an old button
    if (field === "budget") await db.updateUser(ctx.db, chatId, { budget_minutes: Number(value) });
    else if (field === "mix" && MIXES[value]) await db.updateUser(ctx.db, chatId, { shorts_ratio: MIXES[value].ratio });
    else if (field === "hour") await db.updateUser(ctx.db, chatId, { delivery_hour: Number(value) });
    else if (field === "tz" && validZone(value)) await db.updateUser(ctx.db, chatId, { timezone: value });
    else if (field !== "taste") return;
    await advance(ctx, chatId, user.step);
    return;
  }

  const m = update.message;
  if (!m) return;
  const text: string = typeof m.text === "string" ? m.text.trim() : "";
  const reply = (t: string) => ctx.tg("sendMessage", { chat_id: chatId, text: t, parse_mode: "HTML" });

  switch (user.step) {
    case "connect": {
      if (m.document) return importCsvDocument(ctx, chatId, m.document);
      if (/^@|youtube\.com\/@/.test(text)) {
        try {
          return await imported(ctx, chatId, await subscriptionsForHandle(text, ctx.youtubeApiKey), `for ${text.replace(/^.*\/(?=@)/, "")}`);
        } catch (e) {
          return void (await reply(e instanceof SubsError ? `${e.message} Try connecting YouTube or sending your Takeout file instead.` : "Something went wrong reading that handle. Try again?"));
        }
      }
      return prompt(ctx, user);
    }
    case "hour": {
      const h = parseHour(text);
      if (h === null) return void (await reply('I didn\'t catch that time. Try e.g. "8am" or "19:00".'));
      await db.updateUser(ctx.db, chatId, { delivery_hour: h });
      return advance(ctx, chatId, "hour");
    }
    case "timezone": {
      const tz = parseTimezone(text);
      if (!tz) return void (await reply('I don\'t know that one. Try a big city near you (e.g. "Accra") or a UTC offset like "UTC+1".'));
      await db.updateUser(ctx.db, chatId, { timezone: tz });
      return advance(ctx, chatId, "timezone");
    }
    case "taste": {
      if (!text) return prompt(ctx, user);
      await db.setTasteNotes(ctx.db, chatId, text);
      return advance(ctx, chatId, "taste");
    }
    default:
      return prompt(ctx, user); // a button step: show the buttons again
  }
}
