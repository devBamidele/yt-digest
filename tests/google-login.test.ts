import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildAuthUrl } from "../src/google-login.ts";

test("auth URL asks for read-only YouTube access with PKCE", () => {
  const url = new URL(buildAuthUrl("cid", "http://127.0.0.1:5555", "scope-x", "st", "verifier123"));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:5555");
  assert.equal(url.searchParams.get("scope"), "scope-x");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update("verifier123").digest("base64url"));
});
