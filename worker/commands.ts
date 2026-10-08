// Commands for people who have finished setup: /settings, /sync, /pause, /resume, /delete, /help,
// and for the owner /invite and /users. Settings that need typed input (time, time zone, interests)
// park the user in a "set_*" step until they reply.
import * as db from "./db.ts";
import { connectLink } from "./google.ts";
import { MIXES, parseTimezone, type OnboardingCtx } from "./onboarding.ts";
import { fmtTime, nextDigest, parseTime } from "./time.ts";

export const COMMANDS: [string, string][] = [
  ["settings", "Change watch time, mix, delivery time, time zone or interests"],
  ["sync", "Re-import your YouTube subscriptions"],
  ["pause", "Stop daily digests"],
  ["resume", "Start daily digests again"],
  ["delete", "Erase everything I know about you"],
  ["help", "What I can do"],
];

const at = (u: db.User) => fmtTime(u.delivery_hour, u.delivery_minute);
const btn = (text: string, data: string) => ({ text, callback_data: data });
const mixLabel = (r: number) => Object.values(MIXES).find((m) => m.ratio === r)?.label ?? `${Math.round(r * 100)}% shorts`;

async function send(ctx: OnboardingCtx, chat_id: string, text: string, keyboard?: object[][]) {
  await ctx.tg("sendMessage", { chat_id, text, parse_mode: "HTML", ...(keyboard && { reply_markup: { inline_keyboard: keyboard } }) });
}

async function showSettings(ctx: OnboardingCtx, u: db.User) {
  const taste = String((await db.userState(ctx.db, u.chat_id))!.taste.notes ?? "");
  await send(
    ctx,
    u.chat_id,
    `⚙️ <b>Your settings</b>\n\n• Watch time: ${u.budget_minutes} min\n• Mix: ${mixLabel(u.shorts_ratio)}\n• Delivery: ${at(u)} (${u.timezone})\n• Interests: ${taste ? `<i>${taste.replace(/</g, "&lt;").slice(0, 200)}</i>` : "(none yet)"}\n• Status: ${u.status === "paused" ? "⏸ paused" : "▶️ active"}\n\nWhat would you like to change?`,
    [
      [btn("⏱ Watch time", "set|budget"), btn("⚡ Mix", "set|mix")],
      [btn("🕕 Delivery time", "set|hour"), btn("🌍 Time zone", "set|timezone")],
      [btn("💬 Interests", "set|taste")],
    ],
  );
}

/** Returns true if it handled the message as a command. */
export async function handleCommand(ctx: OnboardingCtx, u: db.User, text: string, botUsername: string): Promise<boolean> {
  const [cmd] = text.trim().slice(1).split(/[\s@]/);
  const chat = u.chat_id;
  switch (cmd) {
    case "help":
      await send(ctx, chat, `Here's what I can do:\n\n${COMMANDS.map(([c, d]) => `/${c}: ${d}`).join("\n")}\n\nOr just message me to change a single day, e.g. <i>"30 min tonight, only shorts, something funny"</i>. Tap 👍/👎 on videos to teach me what you like.${u.is_owner ? "\n\nOwner: /invite makes an invite link, /users lists everyone." : ""}`);
      return true;
    case "settings":
      await showSettings(ctx, u);
      return true;
    case "sync":
      await db.updateUser(ctx.db, chat, { step: "sync" });
      await send(ctx, chat, "🔄 <b>Re-import your subscriptions</b>\n\nSign in again, or send me a fresh Takeout <code>subscriptions.csv</code>. Your 👍/👎 history and settings stay as they are.", [
        [{ text: "🔗 Connect YouTube", url: await connectLink(ctx.origin, chat, ctx.secret) }],
      ]);
      return true;
    case "pause":
      await db.updateUser(ctx.db, chat, { status: "paused" });
      await send(ctx, chat, "⏸ Paused. No digests until you send /resume.");
      return true;
    case "resume":
      await db.updateUser(ctx.db, chat, { status: "active" });
      await send(ctx, chat, `▶️ Back on. Next digest ${nextDigest(u)}.`);
      return true;
    case "delete":
      await send(ctx, chat, "🗑 This erases your channels, settings, 👍/👎 history and everything else I have about you. It can't be undone.", [
        [btn("Yes, delete everything", "del|yes"), btn("Cancel", "del|no")],
      ]);
      return true;
    case "invite":
      if (!u.is_owner) return false;
      await send(ctx, chat, `🎟 One-time invite link (works for one person):\nhttps://t.me/${botUsername}?start=${await db.createInvite(ctx.db, chat)}\n\nRemember to add their Gmail as a test user in Google Cloud so "Connect YouTube" works for them.`);
      return true;
    case "users": {
      if (!u.is_owner) return false;
      const lines = await Promise.all(
        (await db.listUsers(ctx.db)).map(async (x) => {
          const st = await db.userState(ctx.db, x.chat_id);
          const cost = await db.costToday(ctx.db, x.chat_id);
          return `• ${x.name || x.chat_id}: ${x.status}${x.status === "onboarding" ? ` (${x.step})` : ""}, ${st?.creators.length ?? 0} channels, ${at(x)} ${x.timezone}, $${cost.toFixed(2)} today`;
        }),
      );
      await send(ctx, chat, `👥 <b>Users</b>\n\n${lines.join("\n") || "(none)"}`);
      return true;
    }
  }
  return false;
}

/** Buttons from /settings ("set|…") and /delete ("del|…"). Returns true if handled. */
export async function handleSettingsCallback(ctx: OnboardingCtx, u: db.User, data: string): Promise<boolean> {
  const [tag, field, value] = data.split("|");
  const chat = u.chat_id;
  if (tag === "del") {
    if (field === "yes") {
      await db.deleteUser(ctx.db, chat);
      await send(ctx, chat, "✅ Done. Everything about you is deleted. If you want to come back, ask for a new invite link.");
    } else {
      await send(ctx, chat, "Okay, nothing was deleted.");
    }
    return true;
  }
  if (tag !== "set") return false;

  if (value === undefined) {
    // Show the choices for one setting.
    switch (field) {
      case "budget":
        await send(ctx, chat, "⏱ How much time do you usually have?", [[30, 60, 90, 120].map((m) => btn(`${m} min`, `set|budget|${m}`))]);
        return true;
      case "mix":
        await send(ctx, chat, "⚡ Shorts or long videos?", [Object.entries(MIXES).map(([k, m]) => btn(m.label, `set|mix|${k}`))]);
        return true;
      case "hour":
      case "timezone":
      case "taste":
        await db.updateUser(ctx.db, chat, { step: `set_${field}` });
        await send(
          ctx,
          chat,
          field === "hour"
            ? '🕕 What time should your digest arrive? Type it, e.g. "8am", "7:30pm" or "22:30".'
            : field === "timezone"
              ? '🌍 Which time zone? Type your city or a UTC offset, e.g. "Accra" or "UTC+1".'
              : "💬 Tell me what you're into, in your own words. This replaces your current interests.",
        );
        return true;
    }
    return false;
  }
  if (field === "budget" && Number(value) > 0) {
    await db.updateUser(ctx.db, chat, { budget_minutes: Number(value) });
    await send(ctx, chat, `✓ Watch time: ${value} min`);
    return true;
  }
  if (field === "mix" && MIXES[value]) {
    await db.updateUser(ctx.db, chat, { shorts_ratio: MIXES[value].ratio });
    await send(ctx, chat, `✓ Mix: ${MIXES[value].label}`);
    return true;
  }
  return false;
}

/** Typed replies to /settings questions (time, time zone, interests). Returns true if handled. */
export async function handleSettingInput(ctx: OnboardingCtx, u: db.User, text: string): Promise<boolean> {
  const chat = u.chat_id;
  switch (u.step) {
    case "set_hour": {
      const t = parseTime(text);
      if (!t) {
        await send(ctx, chat, 'I didn\'t catch that time. Try e.g. "8am", "7:30pm" or "22:30".');
        return true;
      }
      await db.updateUser(ctx.db, chat, { delivery_hour: t.hour, delivery_minute: t.minute, step: "done" });
      const updated = { ...u, delivery_hour: t.hour, delivery_minute: t.minute };
      await send(
        ctx,
        chat,
        `✓ Delivery time: ${fmtTime(t.hour, t.minute)} (${u.timezone})${t.rounded ? " (I deliver in 5-minute steps)" : ""}. Next digest ${nextDigest(updated)}.`,
      );
      return true;
    }
    case "set_timezone": {
      const tz = parseTimezone(text);
      if (!tz) {
        await send(ctx, chat, 'I don\'t know that one. Try a big city near you or "UTC+1".');
        return true;
      }
      await db.updateUser(ctx.db, chat, { timezone: tz, step: "done" });
      await send(ctx, chat, `✓ Time zone: ${tz}`);
      return true;
    }
    case "set_taste":
      await db.setTasteNotes(ctx.db, chat, text);
      await db.updateUser(ctx.db, chat, { step: "done" });
      await send(ctx, chat, "✓ Interests updated. I'll use them from your next digest.");
      return true;
  }
  return false;
}
