import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { callRow, clean } from "../src/postcall.js";
import { canonicalPlaces, splitGaps } from "../src/calls.js";

// Minimal D1 stand-in over node:sqlite.
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql), raw: db };
}

const OWNER = "+12065550123";
const ctx = { waitUntil: (p) => p };

function setup() {
  const DB = fakeD1();
  DB.raw.prepare("INSERT INTO settings (k, v) VALUES ('owner_phone', ?)").run(OWNER);
  const env = { DB, TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32), TWILIO_AUTH_TOKEN: "x" };
  return env;
}

test("clean() drops placeholder values", () => {
  assert.equal(clean("not provided"), null);
  assert.equal(clean(" None "), null);
  assert.equal(clean("Sam"), "Sam");
});

test("canonicalPlaces maps aliases and skips generic entries", () => {
  assert.deepEqual(canonicalPlaces("the troll, ferry schedule, Frog Rock, frog rock, Burger Cabin"), [
    "Pia the Peacekeeper",
    "Frog Rock",
    "Burger Cabin",
  ]);
});

test("splitGaps pairs requests with topic labels", () => {
  assert.deepEqual(splitGaps("snack near ferry at 6am - nothing open | laundromat", "Coffee near ferry - early morning | laundromat"), [
    { topic: "coffee near ferry - early morning", detail: "snack near ferry at 6am - nothing open" },
    { topic: "laundromat", detail: "laundromat" },
  ]);
  assert.deepEqual(splitGaps(null, null), []);
});

test("callRow pulls caller, places and text result from the webhook", () => {
  const row = callRow({
    data: {
      conversation_id: "conv_x",
      metadata: { start_time_unix_secs: 100, call_duration_secs: 90, phone_call: { external_number: "+12065550100", type: "twilio" } },
      analysis: { transcript_summary: "s", call_summary_title: "t", data_collection_results: { name: { value: "not provided" }, locations_of_interest: { value: "Frog Rock" }, unmet_requests: { value: "late coffee" }, unmet_request_topics: { value: "late-night coffee" } } },
      transcript: [
        { tool_calls: [{ tool_name: "BI_Info_Send_Text", params_as_json: '{"locations":"Frog Rock"}' }] },
        { tool_results: [{ tool_name: "BI_Info_Send_Text", is_error: false, result_value: '{"status":"sent","type":"mms"}' }] },
      ],
    },
  });
  assert.equal(row.phone, "+12065550100");
  assert.equal(row.name, null);
  assert.equal(row.text_places, "Frog Rock");
  assert.equal(row.text_ok, 1);
  assert.equal(row.unmet_requests, "late coffee");
  assert.equal(row.unmet_topics, "late-night coffee");
});

test("call log: locked until sign-in, link texted to owner, one-time use", async () => {
  const env = setup();
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: new URLSearchParams(init.body) });
    return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 });
  };
  try {
    const base = "https://w.example";
    let r = await worker.fetch(new Request(base + "/calls/data"), env, ctx);
    assert.equal(r.status, 401);
    r = await worker.fetch(new Request(base + "/calls"), env, ctx);
    assert.match(await r.text(), /Text me a sign-in link/);

    r = await worker.fetch(new Request(base + "/calls/login", { method: "POST" }), env, ctx);
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.get("To"), OWNER);
    const token = sent[0].body.get("Body").match(/t=([0-9a-f]{64})/)[1];

    // GET (e.g. a link preview) does not consume the token
    r = await worker.fetch(new Request(base + "/calls/auth?t=" + token), env, ctx);
    assert.match(await r.text(), /Sign in on this device/);

    const form = new FormData();
    form.set("t", token);
    r = await worker.fetch(new Request(base + "/calls/auth", { method: "POST", body: form }), env, ctx);
    assert.equal(r.status, 303);
    const cookie = r.headers.get("set-cookie").split(";")[0];
    assert.match(r.headers.get("set-cookie"), /HttpOnly; Secure/);

    // token is single-use
    const again = new FormData();
    again.set("t", token);
    r = await worker.fetch(new Request(base + "/calls/auth", { method: "POST", body: again }), env, ctx);
    assert.equal(r.status, 400);

    env.DB.raw.prepare("INSERT INTO calls (conversation_id, start_unix, phone, locations, text_ok, unmet_requests, unmet_topics) VALUES ('c1', 1, '+12065550100', 'the troll', 1, 'coffee at 6am near ferry', 'coffee near ferry - early morning'), ('c2', 2, ?, 'Frog Rock', NULL, NULL, NULL)").run(OWNER);
    r = await worker.fetch(new Request(base + "/calls/data", { headers: { cookie } }), env, ctx);
    const d = await r.json();
    assert.equal(d.calls.length, 2);
    assert.deepEqual(d.calls[1].places, ["Pia the Peacekeeper"]);
    assert.equal(d.calls[0].is_owner, true);
    assert.equal(d.calls[1].gaps[0].topic, "coffee near ferry - early morning");

    r = await worker.fetch(new Request(base + "/calls/export.csv", { headers: { cookie } }), env, ctx);
    assert.match(await r.text(), /^start_pacific,duration_secs,phone/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("call log: at most 3 pending links", async () => {
  const env = setup();
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => (n++, new Response("{}", { status: 201 }));
  try {
    for (let i = 0; i < 5; i++) await worker.fetch(new Request("https://w/calls/login", { method: "POST" }), env, ctx);
    assert.equal(n, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("sms route logs the text to the call log", async () => {
  const env = { ...setup(), ISLA_TOOL_KEY: "k" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ sid: "MM9", num_media: "1" }), { status: 201 });
  const waits = [];
  try {
    const r = await worker.fetch(
      new Request("https://w/sms?caller_id=+12065550100", { method: "POST", headers: { "x-isla-key": "k" }, body: JSON.stringify({ locations: "Frog Rock" }) }),
      env,
      { waitUntil: (p) => waits.push(p) }
    );
    assert.equal(r.status, 200);
    await Promise.all(waits);
    const row = env.DB.raw.prepare("SELECT phone, places, ok, detail FROM texts").get();
    assert.deepEqual({ ...row }, { phone: "+12065550100", places: "Frog Rock", ok: 1, detail: "MM9" });
  } finally {
    globalThis.fetch = realFetch;
  }
});
