import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { isCreditError } from "../src/claude.ts";

const apiError = (status: number, type: string, message: string) =>
  new Anthropic.APIError(status, { type: "error", error: { type, message } }, message, new Headers(), type as any);

test("credit errors: 402 billing_error, or a 400 saying the credit balance is too low", () => {
  assert.equal(isCreditError(apiError(402, "billing_error", "There's an issue with your billing")), true);
  assert.equal(isCreditError(apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.")), true);
  assert.equal(isCreditError(apiError(400, "invalid_request_error", "max_tokens: too large")), false);
  assert.equal(isCreditError(apiError(429, "rate_limit_error", "Too many requests")), false);
  assert.equal(isCreditError(apiError(529, "overloaded_error", "Overloaded")), false);
  assert.equal(isCreditError(new Error("credit balance is too low")), false); // not from the API
});
