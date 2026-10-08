// Shared helper: one Claude call that returns schema-valid JSON.
import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | undefined;
export const claude = () => (client ??= new Anthropic());

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
  const response = await claude().beta.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8000,
    ...modelOptions(opts.model, opts.effort ?? "low", { type: "json_schema", schema: opts.schema as Record<string, unknown> }),
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  if (response.stop_reason !== "end_turn") throw new Error(`Claude stopped early: ${response.stop_reason}`);
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return { data: JSON.parse(text) as T, usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } };
}
