// Wrap-up text route. Port of Make scenario 4403753 "BI Info Send Text Twilio".
// Isla's BI_Info_Send_Text tool calls: POST /sms?caller_id=+1...
// body: { locations, details?, ferry_info?, walking?, caller_name?, send_message? }
// Address/phone/notes come from places.json (built from Isla's KB), never from the LLM.
// Unknown places get name + map link only. `details` is accepted but not used, same as Make.

import PLACES from "./places.json" with { type: "json" };

const FROM_NUMBER = "+12534667401";
const SITE_LINK = "https://bit.ly/4phtzMF";
const IMG = (file) =>
  `https://images.weserv.nl/?url=red4golf.github.io/PNWHistoricalExplorer/images/locations/${file}&w=1200&output=jpg&q=80`;

const byKey = new Map(PLACES.places.map((p) => [p.k, p]));
const aliasToKey = new Map(PLACES.aliases.map((x) => [x.a, x.k]));

export function normalize(name) {
  return String(name).trim().replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

export function lookupPlace(rawName) {
  const norm = normalize(rawName);
  const key = aliasToKey.get(norm) || norm;
  return byKey.get(key) || null;
}

export function placeBlock(rawName, walking) {
  const name = String(rawName).trim();
  const p = lookupPlace(name);
  let out = p?.n || name;
  if (p?.a) out += `\n${p.a}`;
  if (p?.p) out += `\nPhone: ${p.p}`;
  if (p?.t) out += `\n${p.t}`;
  out +=
    `\nDirections: https://www.google.com/maps/dir/?api=1&destination=` +
    encodeURIComponent(`${name} Bainbridge Island`) +
    (walking ? "&travelmode=walking" : "");
  return out;
}

export function composeSms(input) {
  const locations = String(input.locations || "");
  const walking = String(input.walking || "").trim().toLowerCase() === "true";
  const ferry = String(input.ferry_info || "").trim();
  let body;
  if (locations.trim().length > 0) {
    const blocks = locations
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((n) => placeBlock(n, walking))
      .join("\n\n");
    body =
      `Here's your Bainbridge Island info:\n\n${blocks}\n\n` +
      `${ferry ? "Ferries: " + ferry : ""}\n\n` +
      `Enjoy your visit! - Isla\n\nMore local history & places: ${SITE_LINK}`;
  } else {
    body = String(input.send_message || "");
  }
  body = body.replace(/\n{3,}/g, "\n\n").trim();

  const lower = locations.toLowerCase();
  const image = lower.includes("frog rock")
    ? IMG("frog-rock-hero.jpg")
    : lower.includes("peacekeeper")
      ? IMG("pia-the-peacekeeper-hero.jpg")
      : "";
  return { body, image };
}

export async function handleSms(request, env, ctx) {
  const url = new URL(request.url);
  const to = (url.searchParams.get("caller_id") || "").trim();
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ status: "failed", error: "body must be JSON" }, 400);
  }
  if (!/^\+?\d{10,15}$/.test(to)) {
    return json({ status: "failed", error: "no valid caller number - tell the caller the text could not be sent" }, 400);
  }
  const { body, image } = composeSms(input);
  if (!body) return json({ status: "failed", error: "nothing to send" }, 400);

  // Twilio credentials: Cloudflare secrets if set, otherwise sent by ElevenLabs from its
  // workspace secret (x-twilio-token) with the account SID (x-twilio-sid). /sms is behind x-isla-key.
  const sid = env.TWILIO_ACCOUNT_SID || request.headers.get("x-twilio-sid") || "";
  const token = env.TWILIO_AUTH_TOKEN || request.headers.get("x-twilio-token") || "";
  if (!/^AC[0-9a-f]{32}$/.test(sid) || !token) {
    console.error("twilio credentials missing");
    return json({ status: "failed", error: "the text could not be sent - tell the caller and offer to read the details instead" }, 500);
  }

  const form = new URLSearchParams({ To: to, From: FROM_NUMBER, Body: body });
  if (image) form.append("MediaUrl", image);
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: "Basic " + btoa(`${sid}:${token}`),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    }
  );
  const tw = await res.json().catch(() => ({}));

  const slack =
    `📩 *BI Concierge Text ${res.ok ? "Sent" : "FAILED"}*\n\n` +
    `• *To:* ${input.caller_name || ""} / ${to}\n` +
    `• *Type:* ${image ? "MMS with sight photo" : "SMS (no photo)"}\n` +
    `• *Image:* ${image || "none"}\n` +
    `• *Time:* ${new Date().toISOString()}\n` +
    (res.ok ? "" : `• *Twilio error:* ${tw.code || res.status} ${tw.message || ""}\n`) +
    `\n*Message body:*\n\`\`\`${body}\`\`\``;
  ctx?.waitUntil?.(postSlack(env, slack));

  if (!res.ok) {
    console.error("twilio failed", res.status, tw);
    return json({ status: "failed", error: "the text could not be sent - tell the caller and offer to read the details instead" }, 502);
  }
  return image
    ? json({ status: "sent", type: "mms", sid: tw.sid, num_media: tw.num_media })
    : json({ status: "sent", type: "sms", sid: tw.sid });
}

export async function postSlack(env, text) {
  if (!env.SLACK_WEBHOOK_URL) return;
  try {
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("slack failed", err);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
