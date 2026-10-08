// Imports my YouTube subscriptions into creators.yaml, keeping existing entries and weights.
//   npm run import-subs -- --login                 (sign in with Google; works when private)
//   npm run import-subs -- @handle                 (subscriptions must be public)
//   npm run import-subs -- --csv subscriptions.csv (Google Takeout export)
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { googleLogin } from "./google-login.ts";

try {
  process.loadEnvFile();
} catch {}

interface Sub {
  id: string;
  name: string;
}

const API_URL = "https://www.googleapis.com/youtube/v3/";

const YOUTUBE_READONLY = "https://www.googleapis.com/auth/youtube.readonly";

/** Calls the YouTube API with the API key, or with a signed-in user's access token. */
async function api(endpoint: string, params: Record<string, string>, accessToken?: string) {
  let res: Response;
  if (accessToken) {
    res = await fetch(`${API_URL}${endpoint}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } else {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) throw new Error("YOUTUBE_API_KEY is not set");
    res = await fetch(`${API_URL}${endpoint}?${new URLSearchParams({ ...params, key })}`);
  }
  const body = await res.json();
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? res.status;
    if (reason === "subscriptionForbidden") {
      throw new Error(
        "Your subscriptions are private. Use --login to sign in with Google instead, or turn off " +
          "'Keep all my subscriptions private' at https://www.youtube.com/account_privacy.",
      );
    }
    throw new Error(`YouTube API ${endpoint} failed: ${reason}`);
  }
  return body;
}

export async function subsFromHandle(handle: string): Promise<Sub[]> {
  const h = handle.startsWith("@") ? handle : `@${handle}`;
  const ch = await api("channels", { part: "id", forHandle: h });
  const channelId = ch.items?.[0]?.id;
  if (!channelId) throw new Error(`No YouTube channel found for ${h}`);

  return listSubs({ channelId });
}

/** Signs in with Google and lists the signed-in account's subscriptions, private or not. */
export async function subsFromLogin(): Promise<Sub[]> {
  const token = await googleLogin(YOUTUBE_READONLY);
  return listSubs({ mine: "true" }, token);
}

async function listSubs(filter: Record<string, string>, accessToken?: string): Promise<Sub[]> {
  const subs: Sub[] = [];
  let pageToken = "";
  do {
    const page = await api(
      "subscriptions",
      { part: "snippet", maxResults: "50", ...filter, ...(pageToken && { pageToken }) },
      accessToken,
    );
    for (const item of page.items ?? []) {
      subs.push({ id: item.snippet.resourceId.channelId, name: item.snippet.title.trim() });
    }
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return subs;
}

/** Google Takeout subscriptions.csv: "Channel Id,Channel Url,Channel Title". */
export function subsFromCsv(text: string): Sub[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.match(/^(UC[\w-]{22}),[^,]*,(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ id: m[1], name: m[2].trim().replace(/^"|"$/g, "").replace(/""/g, '"').trim() }));
}

/** Adds subs that aren't already in the config. Returns the updated YAML and how many were added. */
export function mergeIntoConfig(yamlText: string, subs: Sub[]): { text: string; added: Sub[] } {
  const doc = parseDocument(yamlText);
  const existing = new Set((doc.toJS().creators ?? []).map((c: { id: string }) => c.id));
  const added = subs.filter((s) => !existing.has(s.id));
  for (const s of added) doc.addIn(["creators"], doc.createNode({ id: s.id, name: s.name }));
  return { text: doc.toString(), added };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      login: { type: "boolean", default: false },
      csv: { type: "string" },
      config: { type: "string", default: "creators.yaml" },
    },
  });
  if (!values.login && !values.csv && positionals.length === 0) {
    console.log("Usage: npm run import-subs -- --login | @handle | --csv subscriptions.csv");
    process.exit(1);
  }

  try {
    const subs = values.login
      ? await subsFromLogin()
      : values.csv
        ? subsFromCsv(readFileSync(values.csv, "utf8"))
        : await subsFromHandle(positionals[0]);
    const { text, added } = mergeIntoConfig(readFileSync(values.config, "utf8"), subs);
    if (added.length) writeFileSync(values.config, text);
    console.log(`Found ${subs.length} subscriptions, added ${added.length} new to ${values.config}:`);
    for (const s of added) console.log(`  + ${s.name}`);
    if (subs.length === 0 && positionals.length) {
      console.log(
        "YouTube returned no subscriptions for this channel. They may be on a different channel of your " +
          "Google account, or the API isn't exposing them. Use --login to sign in with Google instead.",
      );
    }
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
}
