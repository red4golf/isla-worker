import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFerryText, parseWsdotDate, formatPacific } from "../src/ferry.js";
import { composeSms, lookupPlace, normalize } from "../src/sms.js";
import { verifyElevenLabsSignature, buildReport } from "../src/postcall.js";
import PLACES from "../src/places.json" with { type: "json" };

const sample = JSON.parse(readFileSync(new URL("./sample_7_3.json", import.meta.url)));

test("places table copied intact", () => {
  assert.equal(PLACES.v, "2026-10-17");
  assert.equal(PLACES.places.length, 92);
  assert.equal(PLACES.aliases.length, 149);
  const keys = new Set(PLACES.places.map((p) => p.k));
  for (const a of PLACES.aliases) assert.ok(keys.has(a.k), `alias ${a.a} -> missing ${a.k}`);
});

test("ferry: parses WSDOT dates and formats Pacific like Make", () => {
  assert.equal(parseWsdotDate("/Date(1792067400000-0700)/"), 1792067400000);
  assert.equal(formatPacific(1792067400000), "5:30 AM");
});

test("ferry: filters past sailings and matches Make text", () => {
  const all = buildFerryText({ direction: "seattle_to_bi", tripdate: "2026-10-15", schedule: sample, now: 0 });
  assert.match(all, /^Route: Seattle to Bainbridge Island\. Date: 2026-10-15\. Remaining departures \(Pacific time\): 5:30 AM, /);
  assert.match(all, /Crossing takes about 35 minutes\. These are the only valid departure times - quote them exactly\.$/);
  const noon = Date.parse("2026-10-15T12:00:00-07:00");
  const later = buildFerryText({ direction: "seattle_to_bi", tripdate: "2026-10-15", schedule: sample, now: noon });
  assert.ok(!later.includes("5:30 AM"));
  const none = buildFerryText({ direction: "bi_to_seattle", tripdate: "2026-10-15", schedule: sample, now: 9e15 });
  assert.match(none, /Route: Bainbridge Island to Seattle\..*NONE - no sailings remain for this date/);
});

test("sms: aliases and normalization resolve like Make", () => {
  assert.equal(normalize(" The Plate & Pint "), "theplatepint");
  assert.equal(lookupPlace("the troll").n, "Pia the Peacekeeper");
  assert.equal(lookupPlace("Town and Country").n, "T&C Market");
  assert.equal(lookupPlace("Nowhere Cafe"), null);
});

test("sms: composes the same message as Make", () => {
  const { body, image } = composeSms({
    locations: "Pia the Peacekeeper, Nowhere Cafe",
    ferry_info: "Seattle to Bainbridge 1:10 PM",
    walking: "true",
  });
  assert.equal(
    body,
    "Here's your Bainbridge Island info:\n\n" +
      "Pia the Peacekeeper\nSakai Park, 7686 NE High School Rd\n" +
      "Parking is very limited (about 4 spaces); overflow at the Aquatic Center across Madison Ave.\n" +
      "Directions: https://www.google.com/maps/dir/?api=1&destination=Pia%20the%20Peacekeeper%20Bainbridge%20Island&travelmode=walking\n\n" +
      "Nowhere Cafe\nDirections: https://www.google.com/maps/dir/?api=1&destination=Nowhere%20Cafe%20Bainbridge%20Island&travelmode=walking\n\n" +
      "Ferries: Seattle to Bainbridge 1:10 PM\n\n" +
      "Enjoy your visit! - Isla\n\nMore local history & places: https://bit.ly/4phtzMF"
  );
  assert.match(image, /pia-the-peacekeeper-hero\.jpg/);
});

test("sms: no ferry line collapses blank lines; phone shown", () => {
  const { body, image } = composeSms({ locations: "Blackbird" });
  assert.ok(!/\n{3,}/.test(body));
  assert.ok(body.includes("Blackbird Bakery\n210 Winslow Way E\nPhone: (206) 780-1322\nDirections:"));
  assert.ok(!body.includes("Ferries:"));
  assert.equal(image, "");
});

test("sms: falls back to send_message when no locations", () => {
  assert.equal(composeSms({ locations: "", send_message: "Hi there" }).body, "Hi there");
});

test("postcall: signature verification", async () => {
  const secret = "wsec_test";
  const body = '{"type":"post_call_transcription"}';
  const t = 1791000000;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(await verifyElevenLabsSignature(`t=${t},v0=${hex}`, body, secret, t + 5), true);
  assert.equal(await verifyElevenLabsSignature(`t=${t},v0=${hex}`, body + " ", secret, t + 5), false);
  assert.equal(await verifyElevenLabsSignature(`t=${t},v0=${hex}`, body, secret, t + 4000), false);
});

test("postcall: report text", () => {
  const r = buildReport({
    data: {
      conversation_id: "conv_1",
      metadata: { start_time_unix_secs: 1791155800, call_duration_secs: 95, phone_call: { external_number: "+12065550100" } },
      analysis: { transcript_summary: "Asked about the troll.", data_collection_results: { name: { value: "Sam" }, locations_of_interest: { value: "Pia" } } },
    },
  });
  assert.match(r, /• \*Caller:\* Sam \/ \+12065550100/);
  assert.match(r, /\(1\.6 min\)/);
  assert.match(r, /Conversation ID: conv_1$/);
});
