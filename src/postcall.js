// Post-call report route. Port of Make scenario 4823209 "BI — Post-Call Report".
// ElevenLabs post-call webhook calls: POST /postcall (signed with ElevenLabs-Signature).
// Posts the call summary to Slack. (The Google Sheet row is not ported yet - see README.)

import { postSlack } from "./sms.js";

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
  const start = md.start_time_unix_secs ? pacific.format(new Date(md.start_time_unix_secs * 1000)).replace(/ /g, " ") : "unknown";
  const mins = md.call_duration_secs != null ? Math.round((md.call_duration_secs / 60) * 10) / 10 : "?";
  return (
    `📞 *Isla (BI Info) call report*\n\n` +
    `• *Caller:* ${dc.name?.value ?? ""} / ${md.phone_call?.external_number || "unknown"}\n` +
    `• *Time:* ${start} Pacific (${mins} min)\n` +
    `• *Locations of interest:* ${dc.locations_of_interest?.value ?? ""}\n\n` +
    `*Summary:*\n${d.analysis?.transcript_summary ?? ""}\n\n` +
    `Conversation ID: ${d.conversation_id ?? ""}`
  );
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
  ctx?.waitUntil?.(postSlack(env, buildReport(evt)));
  return new Response("ok", { status: 200 });
}
