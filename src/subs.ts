// Subscription-list helpers shared by the terminal importer and the bot (no Node-only imports).

export interface Sub {
  id: string;
  name: string;
}

/** Google Takeout subscriptions.csv: "Channel Id,Channel Url,Channel Title". */
export function subsFromCsv(text: string): Sub[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.match(/^(UC[\w-]{22}),[^,]*,(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ id: m[1], name: m[2].trim().replace(/^"|"$/g, "").replace(/""/g, '"').trim() }));
}

/** Friendly explanations for the YouTube API errors a subscription import can hit. */
export function subsErrorMessage(reason: string): string {
  switch (reason) {
    case "subscriptionForbidden":
      return "YouTube didn't share that account's subscriptions.";
    case "accountClosed":
      return "That YouTube account is closed.";
    case "accountSuspended":
      return "That YouTube account is suspended.";
    case "subscriberNotFound":
      return "That Google account doesn't have a YouTube channel.";
    default:
      return `YouTube returned an error (${reason}).`;
  }
}
