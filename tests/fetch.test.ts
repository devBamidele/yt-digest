import { test } from "node:test";
import assert from "node:assert/strict";
import { isoDurationToSeconds, parseFeed } from "../src/fetch.ts";

test("ISO durations", () => {
  assert.equal(isoDurationToSeconds("PT45S"), 45);
  assert.equal(isoDurationToSeconds("PT3M"), 180);
  assert.equal(isoDurationToSeconds("PT1H2M3S"), 3723);
  assert.equal(isoDurationToSeconds("P1DT1H"), 90000);
  assert.equal(isoDurationToSeconds("P0D"), 0);
  assert.throws(() => isoDurationToSeconds("1:02"));
});

const feed = (entries: string) => `<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
${entries}</feed>`;
const entry = (id: string, published: string) => `<entry>
  <yt:videoId>${id}</yt:videoId><title>Title ${id}</title><published>${published}</published>
  <media:group><media:description>Desc ${id}</media:description></media:group>
</entry>`;
const creator = { id: "UCsBjURrPoezykLs9EqgamOA", name: "Fireship", priorityWeight: 1.5 };

test("feed keeps only videos since the cutoff", () => {
  const text = feed(entry("new", "2026-10-08T10:00:00+00:00") + entry("old", "2026-10-01T10:00:00+00:00"));
  const vids = parseFeed(text, creator, new Date("2026-10-07T17:00:00Z"));
  assert.equal(vids.length, 1);
  assert.equal(vids[0].videoId, "new");
  assert.equal(vids[0].description, "Desc new");
  assert.equal(vids[0].priorityWeight, 1.5);
});

test("feed with a single entry or none", () => {
  const since = new Date("2026-01-01T00:00:00Z");
  assert.equal(parseFeed(feed(entry("one", "2026-10-08T10:00:00+00:00")), creator, since).length, 1);
  assert.equal(parseFeed(feed(""), creator, since).length, 0);
});
