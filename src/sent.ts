// Backlog: remembers which videos were already sent, so each is sent at most once
// and unsent videos from earlier days stay eligible.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Video } from "./types.ts";

export const SENT_PATH = "state/sent.json";
const KEEP_DAYS = 30;

export type SentLog = Record<string, string>; // videoId -> ISO date sent

export function loadSent(path = SENT_PATH): SentLog {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

export function unsent(videos: Video[], sent: SentLog): Video[] {
  return videos.filter((v) => !(v.videoId in sent));
}

export function markSent(videos: Video[], sent: SentLog, now = new Date()): SentLog {
  const cutoff = now.getTime() - KEEP_DAYS * 86400_000;
  const kept = Object.fromEntries(Object.entries(sent).filter(([, d]) => new Date(d).getTime() >= cutoff));
  for (const v of videos) kept[v.videoId] = now.toISOString();
  return kept;
}

export function saveSent(sent: SentLog, path = SENT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(sent, null, 2));
}
