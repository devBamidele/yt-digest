import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.ts";

test("webhook rejects posts without Telegram's secret", async () => {
  const req = new Request("https://w/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" }, body: "{}" });
  const res = await worker.fetch(req, { WEBHOOK_SECRET: "hook" } as any, { waitUntil() {} });
  assert.equal(res.status, 403);
});
