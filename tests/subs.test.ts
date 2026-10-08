import { test } from "node:test";
import assert from "node:assert/strict";
import { subsErrorMessage, subsFromCsv } from "../src/subs.ts";

test("Takeout CSV parses, including quoted names and stray spaces", () => {
  const csv = `Channel Id,Channel Url,Channel Title
UCsBjURrPoezykLs9EqgamOA,http://www.youtube.com/channel/UCsBjURrPoezykLs9EqgamOA,Fireship
UCHnyfMqiRRG1u-2MsSQLbXA,http://www.youtube.com/channel/UCHnyfMqiRRG1u-2MsSQLbXA,"Veritasium, Derek"
UCAwHOqGiNpIU7XGkOgtiX1w,http://www.youtube.com/channel/UCAwHOqGiNpIU7XGkOgtiX1w,Flourish with Laurin 
`;
  assert.deepEqual(subsFromCsv(csv), [
    { id: "UCsBjURrPoezykLs9EqgamOA", name: "Fireship" },
    { id: "UCHnyfMqiRRG1u-2MsSQLbXA", name: "Veritasium, Derek" },
    { id: "UCAwHOqGiNpIU7XGkOgtiX1w", name: "Flourish with Laurin" },
  ]);
});

test("YouTube subscription errors get plain-English messages", () => {
  assert.match(subsErrorMessage("subscriberNotFound"), /doesn't have a YouTube channel/);
  assert.match(subsErrorMessage("accountClosed"), /closed/);
  assert.match(subsErrorMessage("weird"), /\(weird\)/);
});
