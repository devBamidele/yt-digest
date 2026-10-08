// Step 4: score = (views per hour since upload) / subscribers × priority weight.
// Dividing by subscribers keeps small creators from being buried by big ones;
// per-hour views keep a video posted this afternoon from losing to one posted yesterday.
import type { Video } from "./types.ts";

export const MIN_SUBSCRIBERS = 1000; // floor so tiny channels don't score off the chart
const MIN_HOURS = 1;

export function scoreVideo(v: Video, now: Date): number {
  const hours = Math.max((now.getTime() - new Date(v.publishedAt).getTime()) / 3600_000, MIN_HOURS);
  const subs = Math.max(v.subscriberCount ?? 0, MIN_SUBSCRIBERS);
  return ((v.views ?? 0) / hours / subs) * v.priorityWeight;
}

export function score(videos: Video[], now = new Date()): Video[] {
  return videos.map((v) => ({ ...v, score: scoreVideo(v, now) }));
}
