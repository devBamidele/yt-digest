// Client for the receiver's private API (v3): per-user data lives in Cloudflare D1, not in files.
import type { Cache } from "./summarize.ts";

export interface UserRow {
  chat_id: string;
  name: string;
  status: string;
  timezone: string;
  delivery_hour: number;
  delivery_minute: number;
  budget_minutes: number;
  shorts_ratio: number;
  is_owner: number;
  last_digest_at: string | null;
}

export interface UserState {
  user: UserRow;
  creators: { id: string; name: string }[];
  votes: { video_id: string; channel_id: string; vote: "up" | "down"; at: string }[];
  sent: { video_id: string; at: string }[];
  requests: { id: number; text: string; at: string }[];
  taste: { notes: string; learned: string; votes_used: number };
  agentNotes: { note: string; at: string }[];
  ratings: { video_id: string; cache_key: string; fit: number; reason: string }[];
}

export class Store {
  constructor(
    private url = process.env.EVENTS_URL ?? "",
    private token = process.env.EVENTS_TOKEN ?? "",
  ) {
    if (!url || !token) throw new Error("EVENTS_URL and EVENTS_TOKEN must be set");
  }

  private async call(path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.url.replace(/\/$/, "")}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!json.ok) throw new Error(`API ${path} failed: ${json.error ?? res.status}`);
    return json;
  }

  async due(at = new Date()): Promise<string[]> {
    return (await this.call(`due?at=${encodeURIComponent(at.toISOString())}`)).users;
  }
  async state(chatId: string): Promise<{ state: UserState; costToday: number }> {
    const r = await this.call(`users/${chatId}/state`);
    return { state: r.state, costToday: r.costToday };
  }
  recordDigest(chatId: string, sentVideoIds: string[], lastRequestId: number | null, costUsd: number) {
    return this.call(`users/${chatId}/digest`, { sentVideoIds, lastRequestId, costUsd });
  }
  saveTaste(chatId: string, learned: string, votesUsed: number) {
    return this.call(`users/${chatId}/taste`, { learned, votesUsed });
  }
  saveRatings(chatId: string, cacheKey: string, items: { video_id: string; fit: number; reason: string }[]) {
    return this.call(`users/${chatId}/ratings`, { cacheKey, items });
  }
  addAgentNotes(chatId: string, notes: string[]) {
    return this.call(`users/${chatId}/agent-notes`, { notes });
  }
  addCost(chatId: string, costUsd: number) {
    return this.call(`users/${chatId}/cost`, { costUsd });
  }

  /** Shared summary cache in the shape summarize() expects. */
  summaryStore() {
    return {
      get: async (videoIds: string[]): Promise<Cache> => {
        const rows: any[] = videoIds.length ? (await this.call("summaries/lookup", { videoIds })).summaries : [];
        return Object.fromEntries(rows.map((r) => [r.video_id, { summary: r.summary, model: r.model, promptVersion: r.prompt_version, createdAt: "" }]));
      },
      put: async (entries: Cache): Promise<void> => {
        const items = Object.entries(entries).map(([video_id, e]) => ({ video_id, summary: e.summary, model: e.model, prompt_version: e.promptVersion }));
        if (items.length) await this.call("summaries", { items });
      },
    };
  }
}
