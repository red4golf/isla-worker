import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { phoneKey, phoneIndexSize, GREETINGS } from "../src/initiate.js";
import { callRow } from "../src/postcall.js";

function fakeD1(slowMs = 0) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const delay = (v) => (slowMs ? new Promise((r) => setTimeout(() => r(v), slowMs)) : Promise.resolve(v));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => delay(db.prepare(sql).get(...args) ?? null),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql), raw: db };
}

const ctx = { waitUntil: (p) => p };
const KEY = "k";
const call = (env, caller_id, key = KEY) =>
  worker.fetch(
    new Request("https://w/initiate", {
      method: "POST",
      headers: { "x-isla-key": key, "content-type": "application/json" },
      body: JSON.stringify({ caller_id, agent_id: "a", called_number: "+12534667401", call_sid: "CA1" }),
    }),
    env,
    ctx
  );

test("phoneKey normalizes US numbers", () => {
  assert.equal(phoneKey("+1 (206) 842-8008"), "2068428008");
  assert.equal(phoneKey("2068428008"), "2068428008");
  assert.equal(phoneKey("anonymous"), null);
  assert.ok(phoneIndexSize() > 50);
});

test("unknown caller gets the general answer with no greeting override", async () => {
  const r = await call({ ISLA_TOOL_KEY: KEY, DB: fakeD1() }, "+12065550199");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.type, "conversation_initiation_client_data");
  assert.deepEqual(j.dynamic_variables, { caller_type: "general", caller_business: "none" });
  assert.equal(j.conversation_config_override, undefined);
});

test("a number from the guide gets the business greeting", async () => {
  const j = await (await call({ ISLA_TOOL_KEY: KEY, DB: fakeD1() }, "+12068428008")).json();
  assert.equal(j.dynamic_variables.caller_type, "business");
  assert.equal(j.dynamic_variables.caller_business, "Commuter Comforts");
  assert.equal(j.conversation_config_override.agent.first_message, GREETINGS.business);
  assert.match(GREETINGS.business, /may be recorded/);
});

test("a recent verification call wins over the guide match; expired tags are ignored", async () => {
  const DB = fakeD1();
  const now = Math.floor(Date.now() / 1000);
  DB.raw.prepare("INSERT INTO caller_tags VALUES ('2068428008','Commuter Comforts','verify',?,?)").run(now, now + 100);
  let j = await (await call({ ISLA_TOOL_KEY: KEY, DB }, "+12068428008")).json();
  assert.equal(j.dynamic_variables.caller_type, "verify_callback");
  assert.match(j.conversation_config_override.agent.first_message, /may be recorded/);
  DB.raw.prepare("UPDATE caller_tags SET expires_unix=?").run(now - 1);
  j = await (await call({ ISLA_TOOL_KEY: KEY, DB }, "+12068428008")).json();
  assert.equal(j.dynamic_variables.caller_type, "business");
});

test("never blocks: wrong key, bad body, no DB, slow DB all answer 200", async () => {
  let r = await call({ ISLA_TOOL_KEY: KEY, DB: fakeD1() }, "+12068428008", "wrong");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).dynamic_variables.caller_type, "general");

  r = await worker.fetch(new Request("https://w/initiate", { method: "POST", headers: { "x-isla-key": KEY }, body: "not json" }), { ISLA_TOOL_KEY: KEY }, ctx);
  assert.equal(r.status, 200);

  r = await call({ ISLA_TOOL_KEY: KEY }, "+12068428008");
  assert.equal((await r.json()).dynamic_variables.caller_type, "business");

  const t0 = Date.now();
  r = await call({ ISLA_TOOL_KEY: KEY, DB: fakeD1(2000) }, "+12065550199");
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 < 1000, "slow database is skipped within budget");
});

test("fail_test tag fails on purpose (only for that number)", async () => {
  const DB = fakeD1();
  const now = Math.floor(Date.now() / 1000);
  DB.raw.prepare("INSERT INTO caller_tags VALUES ('2065550111','test','fail_test',?,?)").run(now, now + 100);
  assert.equal((await call({ ISLA_TOOL_KEY: KEY, DB }, "+12065550111")).status, 500);
  assert.equal((await call({ ISLA_TOOL_KEY: KEY, DB }, "+12065550199")).status, 200);
});

test("callRow keeps caller type and listing update", () => {
  const row = callRow({
    data: {
      conversation_id: "c",
      metadata: { start_time_unix_secs: 1, phone_call: { external_number: "+12068428008" } },
      conversation_initiation_client_data: { dynamic_variables: { caller_type: "business", caller_business: "Commuter Comforts" } },
      analysis: { data_collection_results: { listing_update: { value: "Commuter Comforts: opens 4:30 weekdays" } } },
    },
  });
  assert.equal(row.caller_type, "business");
  assert.equal(row.listing_update, "Commuter Comforts: opens 4:30 weekdays");
});

test("outbound verification call is tagged for 14 days and kept out of the caller log", async () => {
  const { handlePostCall } = await import("../src/postcall.js");
  const DB = fakeD1();
  const body = JSON.stringify({
    type: "post_call_transcription",
    data: {
      conversation_id: "conv_out",
      metadata: { start_time_unix_secs: 1, phone_call: { direction: "outbound", external_number: "+12068428008", call_result: "voicemail" } },
      analysis: { transcript_summary: "voicemail" },
    },
  });
  const secret = "s";
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const r = await handlePostCall(new Request("https://w/postcall", { method: "POST", headers: { "elevenlabs-signature": `t=${t},v0=${sig}` }, body }), { DB, ELEVENLABS_WEBHOOK_SECRET: secret }, ctx);
  assert.equal(r.status, 200);
  const tag = DB.raw.prepare("SELECT * FROM caller_tags").get();
  assert.equal(tag.phone_key, "2068428008");
  assert.equal(tag.name, "Commuter Comforts");
  assert.equal(tag.kind, "verify");
  assert.ok(tag.expires_unix - tag.created_unix === 14 * 24 * 3600);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) n FROM calls").get().n, 0);
});

test("GET /lookup classifies callers and needs the key", async () => {
  const DB = fakeD1();
  const get = (caller, key = KEY) => worker.fetch(new Request("https://w/lookup?caller=" + encodeURIComponent(caller), { headers: { "x-isla-key": key } }), { ISLA_TOOL_KEY: KEY, DB }, ctx);
  let j = await (await get("+12068428008")).json();
  assert.equal(j.caller_type, "business");
  assert.equal(j.caller_business, "Commuter Comforts");
  j = await (await get("+12065550199")).json();
  assert.equal(j.caller_type, "general");
  assert.equal((await get("+12068428008", "bad")).status, 401);
  const now = Math.floor(Date.now() / 1000);
  DB.raw.prepare("INSERT INTO caller_tags VALUES ('2068428008','Commuter Comforts','verify',?,?)").run(now, now + 100);
  j = await (await get("+12068428008")).json();
  assert.equal(j.caller_type, "verify_callback");
});
