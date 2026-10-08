// Delivery times: parsing what people type, showing them, and deciding when a digest is due.
// Times are kept to 5-minute steps because the cron checks every 5 minutes.

export const STEP_MINUTES = 5;
// If a check is missed (outage, deploy), a digest still goes out within this many minutes.
export const CATCH_UP_MINUTES = 30;

export interface ClockTime {
  hour: number;
  minute: number;
}

/** "18", "6pm", "22:30", "7:15am", "22.30" → a time on the 5-minute grid; `rounded` if we moved it. */
export function parseTime(text: string): (ClockTime & { rounded: boolean }) | null {
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
  return { hour: Math.floor(total / 60), minute: total % 60, rounded: total !== (hour * 60 + typedMinute) % (24 * 60) };
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
}

const sentToday = (u: Schedule, at: Date) => u.last_digest_at !== null && localClock(new Date(u.last_digest_at), u.timezone).date === localClock(at, u.timezone).date;

/** Due if it's at or just after their delivery time (within the catch-up window) and they haven't had today's. */
export function isDue(u: Schedule, at = new Date()): boolean {
  const now = localClock(at, u.timezone).minutes;
  const target = u.delivery_hour * 60 + u.delivery_minute;
  return now >= target && now < target + CATCH_UP_MINUTES && !sentToday(u, at);
}

/** "today at 10:30pm", "tomorrow at 6pm" or "in the next few minutes". */
export function nextDigest(u: Schedule, at = new Date()): string {
  const now = localClock(at, u.timezone).minutes;
  const target = u.delivery_hour * 60 + u.delivery_minute;
  const when = friendlyTime(u.delivery_hour, u.delivery_minute);
  if (isDue(u, at)) return "in the next few minutes";
  if (now < target && !sentToday(u, at)) return `today at ${when}`;
  return `tomorrow at ${when}`;
}
