// Step 3: short vs long-form, by duration.
import type { Video } from "./types.ts";

export function classify(videos: Video[], shortsMaxSeconds: number): Video[] {
  return videos.map((v) => ({
    ...v,
    kind: (v.durationSeconds ?? 0) <= shortsMaxSeconds ? "short" : "long",
  }));
}
