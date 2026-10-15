// Isla (BI Info - V4) tool backend on Cloudflare Workers.
// Replaces three Make scenarios so Isla's call volume no longer counts against the Make plan.
//   GET  /ferry     <- ElevenLabs tools WSDOT_Ferry_Seattle_to_BI / WSDOT_Ferry_BI_to_Seattle
//   POST /sms       <- ElevenLabs tool BI_Info_Send_Text
//   POST /postcall  <- ElevenLabs post-call webhook (signed)
// /ferry and /sms require the header  x-isla-key: <ISLA_TOOL_KEY>  (set on the ElevenLabs tools).

import { handleFerry } from "./ferry.js";
import { handleSms } from "./sms.js";
import { handlePostCall } from "./postcall.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/health") return new Response("ok");
      if (pathname === "/postcall" && request.method === "POST") return handlePostCall(request, env, ctx);

      if (pathname === "/ferry" || pathname === "/sms") {
        if (!env.ISLA_TOOL_KEY || request.headers.get("x-isla-key") !== env.ISLA_TOOL_KEY) {
          return new Response("unauthorized", { status: 401 });
        }
        if (pathname === "/ferry" && request.method === "GET") return handleFerry(request, env);
        if (pathname === "/sms" && request.method === "POST") return handleSms(request, env, ctx);
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
