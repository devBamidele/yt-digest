export interface Creator {
  id: string;
  name: string;
  priorityWeight: number;
}

export interface Config {
  budgetMinutes: number;
  shortsRatio: number;
  shortsMaxSeconds: number;
  backlogDays: number;
  maxPerCreator: number;
  maxVideoMinutes: number;
  maxVideoShare: number;
  summaryModel: string;
  creators: Creator[];
}

// One record flows through the pipeline; each step fills in more fields.
export interface Video {
  // fetch (RSS)
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  channelId: string;
  creator: string;
  priorityWeight: number;
  // fetch (YouTube API)
  views?: number;
  durationSeconds?: number;
  subscriberCount?: number;
  // classify / score / select / summarize
  kind?: "short" | "long";
  score?: number;
  selected?: boolean;
  reason?: string;
  summary?: string;
}
