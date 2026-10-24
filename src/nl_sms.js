// Neighbor Line caller text. Mirrors Isla's /sms (src/sms.js) for the Neighbor Line agent.
// Neighbor Line's NL_Send_Text tool calls: POST /nl/sms?caller_id=+1...
// body: { businesses: "Name One, Name Two", caller_name? }
// Business name/phone/hours come from nl_vendors.json (built from the NL vendor directory), never from the LLM.
// Names that don't match a listed business are dropped: Neighbor Line only texts businesses it has verified.
// Kept separate from sms.js on purpose so a change here can never alter Isla's texts.
//
// Settings (Cloudflare):
//   NL_FROM_NUMBER         variable  Neighbor Line's own Twilio number, E.164. Unset = texting off (tool returns failed).
//   NL_SLACK_WEBHOOK_URL   secret    optional; text reports go here, never to Isla's channel.
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN  shared with Isla.

import VENDORS from "./nl_vendors.json" with { type: "json" };
import { normalize, postSlack } from "./sms.js";

const MAX_BUSINESSES = 2;

const byKey = new Map();
for (const v of VENDORS.vendors) {
  byKey.set(normalize(v.id), v);
  byKey.set(normalize(v.n), v);
  // Also match the name without a trailing "(...)" note, e.g. "Hitchman Painting".
  const short = v.n.replace(/\s*\(.*\)\s*$/, "");
  if (short !== v.n) byKey.set(normalize(short), v);
}

export function lookupVendor(rawName) {
  const norm = normalize(rawName);
  if (!norm) return null;
  return byKey.get(norm) || byKey.get(norm.replace(/^the/, "")) || null;
}

export function vendorBlock(v) {
  let out = v.n;
  out += `\nPhone: ${v.p}`;
  if (v.h) out += `\nHours: ${v.h}`;
  if (v.w) out += `\n${v.w}`;
  return out;
}

// Returns { body, matched, unmatched }. body is "" when nothing matched.
export function composeNlSms(input) {
  const names = String(input.businesses || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const matched = [];
  const unmatched = [];
  for (const n of names) {
    const v = lookupVendor(n);
    if (v && !matched.includes(v)) matched.push(v);
    else if (!v) unmatched.push(n);
  }
  const chosen = matched.slice(0, MAX_BUSINESSES);
  if (chosen.length === 0) return { body: "", matched: [], unmatched };
  const blocks = chosen.map(vendorBlock).join("\n\n");
  const body =
    `Neighbor Line - the local business${chosen.length > 1 ? "es" : ""} we talked about:\n\n` +
    `${blocks}\n\n` +
    `Call them directly for a price and a time. Neighbor Line is free. Reply STOP to opt out.`;
  return { body, matched: chosen, unmatched };
}

export async function handleNlSms(request, env, ctx) {
  const url = new URL(request.url);
  let to = (url.searchParams.get("caller_id") || "").trim();
  if (/^1\d{10}$/.test(to)) to = "+" + to;
  else if (/^\d{10}$/.test(to)) to = "+1" + to;
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ status: "failed", error: "body must be JSON" }, 400);
  }
  if (!/^\+?\d{10,15}$/.test(to)) {
    return json({ status: "failed", error: "no valid caller number - read the business name and number aloud instead" }, 400);
  }
  const { body, matched, unmatched } = composeNlSms(input);
  if (!body) {
    return json(
      { status: "failed", error: "none of those businesses are in the directory - read the name and number aloud from the directory instead" },
      400
    );
  }
  const from = String(env.NL_FROM_NUMBER || "").trim();
  if (!/^\+\d{10,15}$/.test(from)) {
    return json({ status: "failed", error: "texting is not set up yet - read the business name and number aloud instead" }, 503);
  }

  const { res, tw } = await nlTwilioSend(env, from, to, body);
  if (!res) {
    return json({ status: "failed", error: "the text could not be sent - tell the caller and read the details aloud instead" }, 500);
  }
  const ids = matched.map((v) => v.id).join(",");
  if (env.DB) {
    ctx?.waitUntil?.(
      env.DB.prepare("INSERT INTO nl_texts (sent_unix, phone, vendors, ok, detail) VALUES (?,?,?,?,?)")
        .bind(Math.floor(Date.now() / 1000), to, ids || null, res.ok ? 1 : 0,
          res.ok ? tw.sid || null : `${tw.code || res.status} ${tw.message || ""}`.trim())
        .run()
        .catch((err) => console.error("nl text log write failed", err))
    );
  }
  if (env.NL_SLACK_WEBHOOK_URL) {
    const slack =
      `📩 *Neighbor Line Text ${res.ok ? "Sent" : "FAILED"}*\n\n` +
      `• *To:* ${input.caller_name || ""} / ${to}\n` +
      `• *Businesses:* ${matched.map((v) => v.n).join(", ")}\n` +
      (unmatched.length ? `• *Not in directory (dropped):* ${unmatched.join(", ")}\n` : "") +
      `• *Time:* ${new Date().toISOString()}\n` +
      (res.ok ? "" : `• *Twilio error:* ${tw.code || res.status} ${tw.message || ""}\n`) +
      `\n*Message body:*\n\`\`\`${body}\`\`\``;
    ctx?.waitUntil?.(postSlack({ SLACK_WEBHOOK_URL: env.NL_SLACK_WEBHOOK_URL }, slack));
  }
  if (!res.ok) {
    console.error("nl twilio failed", res.status, tw);
    return json({ status: "failed", error: "the text could not be sent - tell the caller and read the details aloud instead" }, 502);
  }
  return json({ status: "sent", businesses: matched.map((v) => v.n), sid: tw.sid });
}

async function nlTwilioSend(env, from, to, body) {
  const sid = env.TWILIO_ACCOUNT_SID || "";
  const token = env.TWILIO_AUTH_TOKEN || "";
  if (!/^AC[0-9a-f]{32}$/.test(sid) || !token) {
    console.error("twilio credentials missing");
    return { res: null, tw: {} };
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${sid}:${token}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  const tw = await res.json().catch(() => ({}));
  return { res, tw };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
