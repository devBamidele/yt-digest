// One-time "Sign in with Google" for a local script (OAuth loopback flow with PKCE).
// Opens the browser, catches the redirect on 127.0.0.1, and returns a short-lived access token.
// Nothing is stored: run it again whenever you need a fresh token.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 5 * 60_000;

const b64url = (buf: Buffer) => buf.toString("base64url");

export function buildAuthUrl(clientId: string, redirectUri: string, scope: string, state: string, verifier: string) {
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  })}`;
}

export async function googleLogin(scope: string): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env (see .env.example)");
  }

  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));

  // Wait for Google to redirect the browser back to us with ?code=...
  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") return void res.writeHead(404).end();
      const err = url.searchParams.get("error");
      const ok = !err && url.searchParams.get("state") === state && url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(ok ? "<h3>Signed in. You can close this tab and go back to the terminal.</h3>" : `<h3>Sign-in failed: ${err ?? "bad state"}</h3>`);
      clearTimeout(timer);
      server.close();
      if (ok) resolve({ code: url.searchParams.get("code")!, redirectUri });
      else reject(new Error(`Google sign-in failed: ${err ?? "state mismatch"}`));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for Google sign-in (5 min)"));
    }, TIMEOUT_MS);
    let redirectUri = "";
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const authUrl = buildAuthUrl(clientId, redirectUri, scope, state, verifier);
      console.log(`Opening your browser to sign in with Google…\nIf it doesn't open, visit:\n${authUrl}\n`);
      spawn("open", [authUrl], { stdio: "ignore", detached: true }).on("error", () => {});
    });
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Token exchange failed: ${body.error_description ?? body.error ?? res.status}`);
  return body.access_token;
}
