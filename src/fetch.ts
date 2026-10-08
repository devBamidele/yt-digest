// Step 2: new uploads via RSS (free), stats via YouTube Data API (batched, ~2 quota units per run).
import { XMLParser } from "fast-xml-parser";
import type { Config, Creator, Video } from "./types.ts";

const RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=";
const API_URL = "https://www.googleapis.com/youtube/v3/";
const xml = new XMLParser({ ignoreAttributes: true });

async function get(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "yt-digest/0.1" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.replace(/key=[^&]+/, "key=***")}`);
  return res.text();
}

export function parseFeed(text: string, creator: Creator, since: Date): Video[] {
  const entries = xml.parse(text).feed?.entry ?? [];
  const list = Array.isArray(entries) ? entries : [entries];
  return list
    .filter((e) => new Date(e.published) >= since)
    .map((e) => ({
      videoId: String(e["yt:videoId"]),
      title: String(e.title),
      description: String(e["media:group"]?.["media:description"] ?? ""),
      publishedAt: new Date(e.published).toISOString(),
      channelId: creator.id,
      creator: creator.name,
      priorityWeight: creator.priorityWeight,
    }));
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function fetchUploads(cfg: Config, since: Date, log = console.log): Promise<Video[]> {
  const results = await mapLimit(cfg.creators, 10, async (c) => {
    try {
      const videos = parseFeed(await get(RSS_URL + c.id), c, since);
      log(`  ${c.name}: ${videos.length} new`);
      return videos;
    } catch (e) {
      // One bad feed shouldn't kill the run.
      log(`  ! ${c.name}: RSS failed (${(e as Error).message})`);
      return [];
    }
  });
  return results.flat();
}

export function isoDurationToSeconds(d: string): number {
  // e.g. PT1H2M3S, PT45S, P1DT2H, P0D
  const m = d.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) throw new Error(`bad ISO duration: ${d}`);
  const [, days, h, min, s] = m.map((x) => Number(x ?? 0));
  return days * 86400 + h * 3600 + min * 60 + s;
}

async function api(endpoint: string, params: Record<string, string>) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY is not set");
  const qs = new URLSearchParams({ ...params, key });
  return JSON.parse(await get(`${API_URL}${endpoint}?${qs}`));
}

function chunks<T>(xs: T[], n = 50): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Fill in views, duration and subscriber count. 1 quota unit per 50 videos + 1 per 50 channels. */
export async function addStats(videos: Video[], log = console.log): Promise<Video[]> {
  if (videos.length === 0) return videos;

  const stats = new Map<string, any>();
  for (const ids of chunks(videos.map((v) => v.videoId))) {
    const data = await api("videos", { part: "statistics,contentDetails", id: ids.join(",") });
    for (const item of data.items ?? []) stats.set(item.id, item);
  }

  const subs = new Map<string, number>();
  for (const ids of chunks([...new Set(videos.map((v) => v.channelId))])) {
    const data = await api("channels", { part: "statistics", id: ids.join(",") });
    for (const item of data.items ?? []) subs.set(item.id, Number(item.statistics.subscriberCount ?? 0));
  }

  const out: Video[] = [];
  for (const v of videos) {
    const s = stats.get(v.videoId);
    const duration = s ? isoDurationToSeconds(s.contentDetails.duration) : 0;
    if (!s || duration === 0) {
      // Private, deleted, or an upcoming/live stream with no duration yet.
      log(`  - skipped ${v.videoId} (${v.title}): no stats or no duration yet`);
      continue;
    }
    out.push({
      ...v,
      views: Number(s.statistics.viewCount ?? 0),
      durationSeconds: duration,
      subscriberCount: subs.get(v.channelId) ?? 0,
    });
  }
  return out;
}
