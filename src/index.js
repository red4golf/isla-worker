// Isla (BI Info - V4) tool backend on Cloudflare Workers.
// Replaces three Make scenarios so Isla's call volume no longer counts against the Make plan.
//   GET  /ferry     <- ElevenLabs tools WSDOT_Ferry_Seattle_to_BI / WSDOT_Ferry_BI_to_Seattle
//   POST /sms       <- ElevenLabs tool BI_Info_Send_Text
//   POST /postcall  <- ElevenLabs post-call webhook (signed)
//   GET  /lookup    <- ElevenLabs tool Caller_Lookup, start of every call (x-isla-key)
//   POST /nl/sms    <- Neighbor Line tool NL_Send_Text (x-isla-key); separate module, never touches Isla texts
//   POST /initiate  <- call-start webhook variant; NOT in use (ElevenLabs stalled calls with it on, 2026-10-17)
// /ferry and /sms require the header  x-isla-key: <ISLA_TOOL_KEY>  (set on the ElevenLabs tools).

import { handleFerry } from "./ferry.js";
import { handleSms } from "./sms.js";
import { handlePostCall } from "./postcall.js";
import { handleCalls } from "./calls.js";
import { handleInitiate, handleLookup } from "./initiate.js";
import { handleNlSms } from "./nl_sms.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/health") return new Response("ok");
      if (pathname === "/postcall" && request.method === "POST") return handlePostCall(request, env, ctx);
      if (pathname === "/initiate" && request.method === "POST") return handleInitiate(request, env);
      if (pathname === "/calls" || pathname.startsWith("/calls/")) return handleCalls(request, env, ctx);

      if (pathname === "/ferry" || pathname === "/sms" || pathname === "/lookup" || pathname === "/nl/sms") {
        if (!env.ISLA_TOOL_KEY || request.headers.get("x-isla-key") !== env.ISLA_TOOL_KEY) {
          return new Response("unauthorized", { status: 401 });
        }
        if (pathname === "/ferry" && request.method === "GET") return handleFerry(request, env);
        if (pathname === "/sms" && request.method === "POST") return handleSms(request, env, ctx);
        if (pathname === "/lookup") return handleLookup(request, env);
        if (pathname === "/nl/sms" && request.method === "POST") return handleNlSms(request, env, ctx);
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error("unhandled", err);
      return new Response("Something went wrong. Do not guess - tell the caller you could not complete that step.", {
        status: 500,
      });
    }
  },
};
