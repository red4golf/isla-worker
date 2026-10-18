// Post-call route. Replaces Make scenario 4823209 "BI — Post-Call Report".
// ElevenLabs post-call webhook calls: POST /postcall (signed with ElevenLabs-Signature).
// Saves the call to the D1 call log (env.DB) and, if SLACK_WEBHOOK_URL is set, posts a Slack report.

import { postSlack } from "./sms.js";
import { tagVerificationCall, businessForPhone } from "./initiate.js";

const TOLERANCE_SECS = 30 * 60;

export async function verifyElevenLabsSignature(header, rawBody, secret, nowSecs = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    })
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSecs - t) > TOLERANCE_SECS || !parts.v0) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, parts.v0);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const pacific = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "long",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function buildReport(evt) {
  const d = evt.data || {};
  const md = d.metadata || {};
  const dc = d.analysis?.data_collection_results || {};
  const start = md.start_time_unix_secs ? pacific.format(new Date(md.start_time_unix_secs * 1000)).replace(/ /g, " ") : "unknown";
  const mins = md.call_duration_secs != null ? Math.round((md.call_duration_secs / 60) * 10) / 10 : "?";
  return (
    `📞 *Isla (BI Info) call report*\n\n` +
    `• *Caller:* ${dc.name?.value ?? ""} / ${md.phone_call?.external_number || "unknown"}\n` +
    `• *Time:* ${start} Pacific (${mins} min)\n` +
    `• *Locations of interest:* ${dc.locations_of_interest?.value ?? ""}\n` +
    (clean(dc.unmet_requests?.value) ? `• *Couldn't help with:* ${dc.unmet_requests.value}\n` : "") +
    (callerType(d) !== "general" ? `• *Caller matched as:* ${callerType(d)} (${dv(d).caller_business ?? ""})\n` : "") +
    (clean(dc.listing_update?.value) ? `• :pencil: *Listing update to review (not applied):* ${dc.listing_update.value}\n` : "") +
    `\n` +
    `*Summary:*\n${d.analysis?.transcript_summary ?? ""}\n\n` +
    `Conversation ID: ${d.conversation_id ?? ""}`
  );
}

const dv = (d) => d.conversation_initiation_client_data?.dynamic_variables || {};
const callerType = (d) => dv(d).caller_type || "general";

// "not provided" / "none" / "" -> null
export function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return !s || /^(not provided|none|n\/a|unknown|null)$/i.test(s) ? null : s;
}

// Turn the webhook payload into one call-log row.
export function callRow(evt) {
  const d = evt.data || {};
  const md = d.metadata || {};
  const dc = d.analysis?.data_collection_results || {};
  const places = [];
  let textOk = null;
  for (const turn of d.transcript || []) {
    for (const tc of turn.tool_calls || []) {
      if (tc.tool_name !== "BI_Info_Send_Text") continue;
      try {
        const p = JSON.parse(tc.params_as_json || "{}");
        if (p.locations) places.push(String(p.locations));
      } catch {}
    }
    for (const tr of turn.tool_results || []) {
      if (tr.tool_name !== "BI_Info_Send_Text") continue;
      const sent = !tr.is_error && /"status"\s*:\s*"sent"/.test(String(tr.result_value || ""));
      textOk = textOk === 1 || sent ? 1 : 0;
    }
  }
  return {
    conversation_id: d.conversation_id,
    start_unix: md.start_time_unix_secs || Math.floor(Date.now() / 1000),
    duration_secs: md.call_duration_secs ?? null,
    phone: md.phone_call?.external_number || null,
    source: md.phone_call?.type || d.conversation_initiation_source || null,
    name: clean(dc.name?.value),
    email: clean(dc.email?.value),
    locations: clean(dc.locations_of_interest?.value),
    title: d.analysis?.call_summary_title || null,
    summary: d.analysis?.transcript_summary || null,
    text_places: places.length ? places.join(", ") : null,
    text_ok: textOk,
    unmet_requests: clean(dc.unmet_requests?.value),
    unmet_topics: clean(dc.unmet_request_topics?.value),
    caller_type: callerType(d),
    listing_update: clean(dc.listing_update?.value),
  };
}

export const CALL_COLS = [
  "conversation_id", "start_unix", "duration_secs", "phone", "source", "name", "email",
  "locations", "title", "summary", "text_places", "text_ok", "unmet_requests", "unmet_topics",
  "caller_type", "listing_update",
];

export function upsertCall(db, row) {
  const ph = CALL_COLS.map(() => "?").join(",");
  const upd = CALL_COLS.slice(1).map((c) => `${c}=excluded.${c}`).join(",");
  return db
    .prepare(`INSERT INTO calls (${CALL_COLS.join(",")}) VALUES (${ph}) ON CONFLICT(conversation_id) DO UPDATE SET ${upd}`)
    .bind(...CALL_COLS.map((c) => row[c] ?? null));
}

export async function handlePostCall(request, env, ctx) {
  const raw = await request.text();
  const ok = await verifyElevenLabsSignature(request.headers.get("elevenlabs-signature"), raw, env.ELEVENLABS_WEBHOOK_SECRET);
  if (!ok) return new Response("bad signature", { status: 401 });
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (evt.type !== "post_call_transcription") return new Response("ignored", { status: 200 });
  // Isla's outbound hours-verification calls: remember the number (14 days) so a callback
  // gets the right greeting, report to Slack, and keep them out of the caller log.
  if (evt.data?.metadata?.phone_call?.direction === "outbound") {
    const md = evt.data.metadata;
    const phone = md.phone_call.external_number;
    const name = businessForPhone(phone);
    if (env.DB) {
      try {
        await tagVerificationCall(env.DB, phone, name)?.run();
      } catch (err) {
        console.error("verification tag failed", err);
      }
    }
    const result = md.phone_call.call_result || md.termination_reason || "";
    ctx?.waitUntil?.(postSlack(env,
      `☎️ *Isla verification call* to ${name || "unlisted number"} / ${phone}\n` +
      `• *Result:* ${result}\n\n*Summary:*\n${evt.data.analysis?.transcript_summary ?? ""}\n\nConversation ID: ${evt.data.conversation_id ?? ""}`));
    return new Response("ok", { status: 200 });
  }
  const row = callRow(evt);
  if (env.DB && row.conversation_id) {
    try {
      await upsertCall(env.DB, row).run();
    } catch (err) {
      console.error("call log write failed", err);
    }
  }
  ctx?.waitUntil?.(postSlack(env, buildReport(evt)));
  return new Response("ok", { status: 200 });
}
