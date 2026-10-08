// Rough cost of Claude calls, for per-user daily caps. $ per million tokens (input, output).
// Cache writes cost 1.25× input; cache reads 0.1× input.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

export function costUsd(model: string, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): number {
  const [pin, pout] = PRICES[model] ?? [4, 20]; // unknown model: assume the expensive end
  return ((u.input ?? 0) * pin + (u.output ?? 0) * pout + (u.cacheRead ?? 0) * pin * 0.1 + (u.cacheWrite ?? 0) * pin * 1.25) / 1e6;
}
