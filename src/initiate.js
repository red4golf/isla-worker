// Call-start lookup. ElevenLabs calls POST /initiate as an inbound Twilio call connects
// ("conversation initiation client data" webhook). We look up the caller's number:
//   1. caller_tags in D1 - numbers Isla recently called to verify hours (kind 'verify', expire
//      after 14 days) plus manual test entries ('business', 'fail_test').
//   2. the published phone numbers in places.json (the businesses in Isla's guide).
// A match changes only the greeting and two dynamic variables. Everyone else gets exactly
// today's behaviour.
//
// SAFETY: this endpoint must never block a call. Every path - bad key, bad JSON, slow or
// broken database, unexpected error - returns 200 with the general (unmatched) answer.
// The only exception is a deliberate 'fail_test' tag, used once to see how ElevenLabs
// behaves when the lookup fails.

import PLACES from "./places.json" with { type: "json" };

const DB_BUDGET_MS = 400;
export const VERIFY_TTL_SECS = 14 * 24 * 3600;
const RECORDING = "Just so you know, this call may be recorded.";

export const GREETINGS = {
  business:
    `Hi, this is Isla, the Bainbridge Island visitor line. ${RECORDING} ` +
    `If you're calling about your business's listing, I can take an update. Otherwise, what can I help you with?`,
  verify_callback:
    `Hi, this is Isla, the Bainbridge Island visitor line. ${RECORDING} ` +
    `Are you calling back about our hours check, or is there something else I can help with?`,
};

// Last 10 digits of a US number; null if it doesn't look like one.
export function phoneKey(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") return d.slice(1);
  return d.length === 10 ? d : null;
}

// Published numbers -> business name. Numbers shared by more than one entry (e.g. a
// parks district) map to a neutral label rather than a guessed business.
const PHONE_INDEX = (() => {
  const m = new Map();
  for (const p of PLACES.places) {
    const k = phoneKey(p.p);
    if (!k) continue;
    m.set(k, m.has(k) && m.get(k) !== p.n ? "a business in Isla's guide" : p.n);
  }
  return m;
})();
export const phoneIndexSize = () => PHONE_INDEX.size;

export function generalAnswer() {
  return {
    type: "conversation_initiation_client_data",
    dynamic_variables: { caller_type: "general", caller_business: "none" },
  };
}

function matchedAnswer(kind, name) {
  return {
    type: "conversation_initiation_client_data",
    dynamic_variables: { caller_type: kind, caller_business: name || "unknown" },
    conversation_config_override: { agent: { first_message: GREETINGS[kind] } },
  };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

async function tagFor(env, key) {
  if (!env.DB) return null;
  const q = env.DB.prepare(
    "SELECT name, kind FROM caller_tags WHERE phone_key=? AND expires_unix>? ORDER BY CASE kind WHEN 'fail_test' THEN 0 WHEN 'verify' THEN 1 ELSE 2 END LIMIT 1"
  )
    .bind(key, Math.floor(Date.now() / 1000))
    .first();
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), DB_BUDGET_MS));
  const r = await Promise.race([q.catch(() => null), timeout]);
  if (r === "timeout") {
    console.warn("initiate: caller_tags lookup over budget, skipped");
    return null;
  }
  return r || null;
}

export async function handleInitiate(request, env) {
  const started = Date.now();
  try {
    if (!env.ISLA_TOOL_KEY || request.headers.get("x-isla-key") !== env.ISLA_TOOL_KEY) {
      console.warn("initiate: missing or wrong key, answering general");
      return json(generalAnswer());
    }
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const key = phoneKey(body.caller_id);
    if (!key) return json(generalAnswer());

    const tag = await tagFor(env, key);
    if (tag?.kind === "fail_test") return new Response("deliberate failure test", { status: 500 });
    let answer;
    if (tag?.kind === "verify") answer = matchedAnswer("verify_callback", tag.name);
    else if (tag?.kind === "business") answer = matchedAnswer("business", tag.name);
    else if (PHONE_INDEX.has(key)) answer = matchedAnswer("business", PHONE_INDEX.get(key));
    else answer = generalAnswer();
    console.log(`initiate: ${answer.dynamic_variables.caller_type} in ${Date.now() - started}ms`);
    return json(answer);
  } catch (err) {
    console.error("initiate: error, answering general", err);
    return json(generalAnswer());
  }
}

// Called from /postcall for Isla's outbound hours-verification calls: remember the number
// for 14 days so a callback gets the right greeting.
export function tagVerificationCall(db, phone, name) {
  const key = phoneKey(phone);
  if (!key) return null;
  const nowS = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      "INSERT INTO caller_tags (phone_key, name, kind, created_unix, expires_unix) VALUES (?,?,'verify',?,?) " +
        "ON CONFLICT(phone_key, kind) DO UPDATE SET name=excluded.name, created_unix=excluded.created_unix, expires_unix=excluded.expires_unix"
    )
    .bind(key, name || PHONE_INDEX.get(key) || null, nowS, nowS + VERIFY_TTL_SECS);
}

export const businessForPhone = (phone) => PHONE_INDEX.get(phoneKey(phone)) || null;
