// Shared helper: one Claude call that returns schema-valid JSON.
import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | undefined;
export const claude = () => (client ??= new Anthropic());

/** Out of credit or a billing problem: a 402 billing_error, or the 400 that says the credit balance is too low. */
export function isCreditError(e: unknown): boolean {
  if (!(e instanceof Anthropic.APIError)) return false;
  return e.status === 402 || e.type === "billing_error" || /credit balance/i.test(e.message);
}

/** What the owner is told when Claude calls fail for lack of credit. The raw error stays in the logs. */
export const CREDIT_ALERT = [
  "⚠️ The Claude API is out of credit (or has a billing problem).",
  "Digests still go out, just without AI: videos are picked by the formula and show their descriptions instead of summaries. Messages to the bot can't be read until it's topped up.",
  "Top up in the Anthropic Console under Plans & Billing.",
].join("\n\n");

let firstCreditError: string | undefined;
/** The first out-of-credit error this process hit, if any; the digest run alerts the owner about it. */
export const creditError = () => firstCreditError;

/** Every Claude call goes through here, so an out-of-credit error is noticed wherever it's caught. */
export async function watched<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (e) {
    if (isCreditError(e)) firstCreditError ??= (e as Error).message;
    throw e;
  }
}

export type Effort = "low" | "medium" | "high";

/** Request options per model: Haiku 4.5 takes neither `effort` nor server-side fallbacks. */
export function modelOptions(model: string, effort: Effort, format?: Anthropic.Beta.BetaJSONOutputFormat) {
  const output_config = { ...(format && { format }), ...(!model.startsWith("claude-haiku") && { effort }) };
  if (model.startsWith("claude-haiku")) return { output_config };
  return {
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default" as const, // if a safety classifier declines, Anthropic re-runs it on a fallback model
    output_config,
  };
}

export interface JsonResult<T> {
  data: T;
  usage: { input: number; output: number };
}

export async function jsonCall<T>(opts: {
  model: string;
  system: string;
  user: string;
  schema: object;
  effort?: Effort;
  maxTokens?: number;
}): Promise<JsonResult<T>> {
  const response = await watched(
    claude().beta.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 8000,
      ...modelOptions(opts.model, opts.effort ?? "low", { type: "json_schema", schema: opts.schema as Record<string, unknown> }),
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
  );
  if (response.stop_reason !== "end_turn") throw new Error(`Claude stopped early: ${response.stop_reason}`);
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return { data: JSON.parse(text) as T, usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } };
}
