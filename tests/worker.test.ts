import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { whenNext } from "../worker/index.ts";

test("reply timing follows Lagos time", () => {
  assert.equal(whenNext(new Date("2026-10-09T09:00:00Z")), "tonight around 6pm"); // 10:00 Lagos
  assert.equal(whenNext(new Date("2026-10-09T16:45:00Z")), "in your next digest"); // 17:45
  assert.equal(whenNext(new Date("2026-10-09T18:00:00Z")), "tomorrow around 6pm"); // 19:00
});

test("webhook rejects posts without Telegram's secret", async () => {
  const req = new Request("https://w/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" }, body: "{}" });
  const res = await worker.fetch(req, { WEBHOOK_SECRET: "hook" } as any, { waitUntil() {} });
  assert.equal(res.status, 403);
});
