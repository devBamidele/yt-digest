// Google sign-in for the bot (web OAuth with PKCE) and the subscription import.
// The access token is used once to read subscriptions and never stored.
import { subsErrorMessage, type Sub } from "../src/subs.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_URL = "https://www.googleapis.com/youtube/v3/";
export const YOUTUBE_READONLY = "https://www.googleapis.com/auth/youtube.readonly";

const enc = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** The "Connect YouTube" link for one chat, signed so nobody can start a sign-in for someone else. */
export async function connectLink(origin: string, chatId: string, secret: string): Promise<string> {
  return `${origin}/oauth/start?u=${encodeURIComponent(chatId)}&sig=${await hmac(secret, `connect:${chatId}`)}`;
}

export async function verifyConnect(chatId: string, sig: string, secret: string): Promise<boolean> {
  return sig.length > 0 && sig === (await hmac(secret, `connect:${chatId}`));
}

export async function authUrl(clientId: string, redirectUri: string, state: string, verifier: string): Promise<string> {
  const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YOUTUBE_READONLY,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "online", // no refresh token: we only need this one read
    prompt: "select_account",
  })}`;
}

export async function exchangeCode(opts: { code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string }) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
      code_verifier: opts.verifier,
    }),
  });
  const body = (await res.json()) as any;
  if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  return body.access_token as string;
}

export class SubsError extends Error {}

async function listSubs(params: Record<string, string>, auth: { token?: string; apiKey?: string }): Promise<Sub[]> {
  const subs: Sub[] = [];
  let pageToken = "";
  do {
    const qs = new URLSearchParams({
      part: "snippet",
      maxResults: "50",
      // Only the two fields we use: keeps responses tiny (the Worker has a small CPU budget).
      fields: "nextPageToken,items(snippet(title,resourceId(channelId)))",
      ...params,
      ...(pageToken && { pageToken }),
      ...(auth.apiKey && { key: auth.apiKey }),
    });
    const res = await fetch(`${API_URL}subscriptions?${qs}`, auth.token ? { headers: { Authorization: `Bearer ${auth.token}` } } : {});
    const body = (await res.json()) as any;
    if (!res.ok) throw new SubsError(subsErrorMessage(body?.error?.errors?.[0]?.reason ?? String(res.status)));
    for (const item of body.items ?? []) subs.push({ id: item.snippet.resourceId.channelId, name: String(item.snippet.title).trim() });
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return subs;
}

/** The signed-in person's own subscriptions (private ones included). */
export const mySubscriptions = (token: string) => listSubs({ mine: "true" }, { token });

/** Someone's public subscriptions by @handle (no sign-in; fails if they're private). */
export async function subscriptionsForHandle(handle: string, apiKey: string): Promise<Sub[]> {
  const h = handle.trim().replace(/^https?:\/\/(www\.)?youtube\.com\//, "").replace(/^@?/, "@");
  const res = await fetch(`${API_URL}channels?${new URLSearchParams({ part: "id", forHandle: h, key: apiKey })}`);
  const channelId = ((await res.json()) as any)?.items?.[0]?.id;
  if (!channelId) throw new SubsError(`I couldn't find a YouTube channel called ${h}.`);
  const subs = await listSubs({ channelId }, { apiKey });
  if (!subs.length) throw new SubsError(`${h} doesn't show any subscriptions publicly.`);
  return subs;
}
