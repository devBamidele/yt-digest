// Delivery times: parsing what people type, showing them, and deciding when a digest is due.
// Times are kept to 5-minute steps because the cron checks every 5 minutes.

export const STEP_MINUTES = 5;
// If a check is missed (outage, deploy), a digest still goes out within this many minutes.
export const CATCH_UP_MINUTES = 30;

export interface ClockTime {
  hour: number;
  minute: number;
}

/**
 * "18", "6pm", "22:30", "7:15am", "22.30" → a time on the 5-minute grid; `rounded` if we moved it.
 * `ambiguous` when it could be morning or evening ("11:00", "7"): 1-12 with no am/pm and no leading zero.
 */
export function parseTime(text: string): (ClockTime & { rounded: boolean; ambiguous: boolean }) | null {
  const m = text.trim().toLowerCase().replace(/\s+/g, "").match(/^(\d{1,2})(?:[:.h](\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const typedMinute = m[2] ? Number(m[2]) : 0;
  if (typedMinute > 59) return null;
  if (m[3] === "pm" && hour < 12) hour += 12;
  if (m[3] === "am" && hour === 12) hour = 0;
  if (hour > 23 || (m[3] && Number(m[1]) > 12)) return null;
  let total = Math.round((hour * 60 + typedMinute) / STEP_MINUTES) * STEP_MINUTES;
  total %= 24 * 60; // 23:58 rounds to 00:00
  const ambiguous = !m[3] && hour >= 1 && hour <= 12 && !m[1].startsWith("0");
  return { hour: Math.floor(total / 60), minute: total % 60, rounded: total !== (hour * 60 + typedMinute) % (24 * 60), ambiguous };
}

export const fmtTime = (hour: number, minute = 0) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** "6pm", "10:30pm": for friendly sentences. */
export function friendlyTime(hour: number, minute = 0): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${hour < 12 ? "am" : "pm"}`;
}

/** Minutes since local midnight, and the local date, in a time zone. */
export function localClock(at: Date, timezone: string): { minutes: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { minutes: Number(get("hour")) * 60 + Number(get("minute")), date: `${get("year")}-${get("month")}-${get("day")}` };
}

interface Schedule {
  timezone: string;
  delivery_hour: number;
  delivery_minute: number;
  last_digest_at: string | null;
  next_digest_at?: string | null; // one-off time from a message ("send it at 11:10pm", "now")
}

/** A one-off time is pending if it hasn't been delivered yet. */
const oneOffPending = (u: Schedule) => !!u.next_digest_at && (!u.last_digest_at || u.last_digest_at < u.next_digest_at);

const sentToday = (u: Schedule, at: Date) => u.last_digest_at !== null && localClock(new Date(u.last_digest_at), u.timezone).date === localClock(at, u.timezone).date;

/**
 * Due if a one-off time from a message has come, or it's at or just after their daily time
 * (within the catch-up window) and they haven't had today's digest.
 */
export function isDue(u: Schedule, at = new Date()): boolean {
  if (oneOffPending(u)) {
    const t = Date.parse(u.next_digest_at!);
    if (at.getTime() >= t && at.getTime() < t + CATCH_UP_MINUTES * 60_000) return true;
    if (at.getTime() < t) return false; // waiting for the one-off: it replaces today's usual time
  }
  const now = localClock(at, u.timezone).minutes;
  const target = u.delivery_hour * 60 + u.delivery_minute;
  return now >= target && now < target + CATCH_UP_MINUTES && !sentToday(u, at);
}

/** "today at 10:30pm", "tomorrow at 6pm" or "in the next few minutes". */
export function nextDigest(u: Schedule, at = new Date()): string {
  if (oneOffPending(u)) {
    const t = Date.parse(u.next_digest_at!);
    if (at.getTime() >= t - 60_000) return "in the next few minutes";
    const local = localClock(new Date(t), u.timezone);
    const day = local.date === localClock(at, u.timezone).date ? "today" : "tomorrow";
    return `${day} at ${friendlyTime(Math.floor(local.minutes / 60), local.minutes % 60)}`;
  }
  const now = localClock(at, u.timezone).minutes;
  const target = u.delivery_hour * 60 + u.delivery_minute;
  const when = friendlyTime(u.delivery_hour, u.delivery_minute);
  if (isDue(u, at)) return "in the next few minutes";
  if (now < target && !sentToday(u, at)) return `today at ${when}`;
  return `tomorrow at ${when}`;
}

/**
 * The UTC moment for a local time in a time zone, on the same local day as `at`, or the next day
 * if that time has already passed by more than the catch-up window.
 */
export function nextOccurrence(t: ClockTime, timezone: string, at = new Date()): Date {
  const target = t.hour * 60 + t.minute;
  const now = localClock(at, timezone).minutes;
  let deltaMin = target - now;
  if (deltaMin < -CATCH_UP_MINUTES) deltaMin += 24 * 60; // e.g. "7am" said at 9pm → tomorrow
  const d = new Date(at.getTime() + deltaMin * 60_000);
  d.setUTCSeconds(0, 0);
  return d;
}

/** For an ambiguous "11:00": the morning and evening readings, as button labels and "H:M" values. */
export function amPmChoices(t: ClockTime): { label: string; value: string }[] {
  const am = t.hour % 12;
  const pm = am + 12;
  return [
    { label: `🌅 ${fmtTime(am, t.minute)} (${friendlyTime(am, t.minute)})`, value: `${am}:${t.minute}` },
    { label: `🌙 ${fmtTime(pm, t.minute)} (${friendlyTime(pm, t.minute)})`, value: `${pm}:${t.minute}` },
  ];
}

/** "18" or "18:30" from a button → a time. */
export function parseChoice(value: string): ClockTime | null {
  const [h, m = 0] = value.split(":").map(Number);
  return Number.isInteger(h) && h >= 0 && h <= 23 && Number.isInteger(m) && m >= 0 && m <= 59 ? { hour: h, minute: m } : null;
}
