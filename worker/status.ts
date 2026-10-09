// The pinned status message: one per user, pinned once, then edited in place whenever its text
// changes ("📺 Next digest: tomorrow at 10am · in 9h 40m"). Telegram has no live countdown widget,
// so the 5-minute check refreshes it.
import * as db from "./db.ts";
import { statusLine } from "./time.ts";

type Tg = (method: string, payload: Record<string, unknown>) => Promise<any>;

/** Creates, re-creates or edits the user's pinned status. Skips the edit if nothing changed. */
export async function refreshStatus(d: db.D1, tg: Tg, u: db.User, at = new Date()): Promise<void> {
  if (u.status === "onboarding") return;
  const text = statusLine(u, at);
  if (u.status_message_id && text === u.status_text) return;

  if (u.status_message_id) {
    const r = await tg("editMessageText", { chat_id: u.chat_id, message_id: u.status_message_id, text });
    // "message is not modified" is fine; anything else (deleted, too old to edit) → post a fresh one.
    if (r?.ok || String(r?.description ?? "").includes("not modified")) {
      await db.setStatusMessage(d, u.chat_id, u.status_message_id, text);
      return;
    }
  }
  const sent = await tg("sendMessage", { chat_id: u.chat_id, text, disable_notification: true });
  const id = sent?.result?.message_id;
  if (!id) return;
  await tg("pinChatMessage", { chat_id: u.chat_id, message_id: id, disable_notification: true });
  await db.setStatusMessage(d, u.chat_id, id, text);
}

/** Refreshes everyone's status (called by the 5-minute check). One user's failure doesn't stop the rest. */
export async function refreshAll(d: db.D1, tg: Tg, at = new Date()): Promise<number> {
  let changed = 0;
  for (const u of await db.listUsers(d)) {
    if (u.status === "onboarding") continue;
    const before = u.status_text;
    try {
      await refreshStatus(d, tg, u, at);
      if (statusLine(u, at) !== before) changed++;
    } catch (e) {
      console.log(`status refresh failed for ${u.chat_id}: ${(e as Error).message}`);
    }
  }
  return changed;
}
