import { test } from "node:test";
import assert from "node:assert/strict";
import { composeNlSms, lookupVendor, handleNlSms } from "../src/nl_sms.js";
import worker from "../src/index.js";
import VENDORS from "../src/nl_vendors.json" with { type: "json" };

test("nl: directory loaded", () => {
  assert.equal(VENDORS.vendors.length, 20);
  for (const v of VENDORS.vendors) assert.match(v.p, /^\(\d{3}\) \d{3}-\d{4}$/, v.n);
});

test("nl: looks up by name, id, and short name", () => {
  assert.equal(lookupVendor("Bainbridge Island Plumbing").p, "(206) 842-3606");
  assert.equal(lookupVendor("silverdale-plumbing-heating").n, "Silverdale Plumbing & Heating");
  assert.equal(lookupVendor("Silverdale Plumbing and Heating"), null); // "and" vs "&" is not guessed
  assert.equal(lookupVendor("Hitchman Painting").n, "Hitchman Painting (handyman and painting)");
  assert.equal(lookupVendor("Made Up Plumbing"), null);
});

test("nl: composes text from the directory only, max two", () => {
  const { body, matched, unmatched } = composeNlSms({
    businesses: "Bainbridge Island Plumbing, Made Up Plumbing, Swift Plumbing & Heating, Silverdale Plumbing & Heating",
  });
  assert.equal(matched.length, 2);
  assert.deepEqual(unmatched, ["Made Up Plumbing"]);
  assert.equal(
    body,
    "Neighbor Line - the local businesses we talked about:\n\n" +
      "Bainbridge Island Plumbing\nPhone: (206) 842-3606\nHours: Hours not published, call to check\n\n" +
      "Swift Plumbing & Heating\nPhone: (360) 297-9592\nHours: Hours not published, call to check\n\n" +
      "Call them directly for a price and a time. Neighbor Line is free. Reply STOP to opt out."
  );
  assert.ok(!body.includes("Made Up"));
});

test("nl: nothing sent when no business matches", () => {
  assert.equal(composeNlSms({ businesses: "Fake Co" }).body, "");
});

const req = (body, q = "?caller_id=%2B12065550100") =>
  new Request("https://w.example/nl/sms" + q, { method: "POST", body: JSON.stringify(body) });

test("nl: texting off until NL_FROM_NUMBER is set", async () => {
  const r = await handleNlSms(req({ businesses: "Kitsap Clean" }), {}, null);
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /read the business name and number aloud/);
});

test("nl: sends from the Neighbor Line number, not Isla's", async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, opts) => {
    sent.push({ u: String(u), body: String(opts.body) });
    return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 });
  };
  try {
    const env = { NL_FROM_NUMBER: "+12065550199", TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32), TWILIO_AUTH_TOKEN: "t" };
    const r = await handleNlSms(req({ businesses: "Kitsap Clean" }), env, null);
    assert.equal(r.status, 200);
    const p = new URLSearchParams(sent[0].body);
    assert.equal(p.get("From"), "+12065550199");
    assert.equal(p.get("To"), "+12065550100");
    assert.match(p.get("Body"), /Kitsap Clean\nPhone: \(206\) 866-9929/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("nl: route requires the tool key", async () => {
  const r = await worker.fetch(req({ businesses: "Kitsap Clean" }), { ISLA_TOOL_KEY: "k" }, {});
  assert.equal(r.status, 401);
});
