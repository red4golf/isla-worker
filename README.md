# isla-worker

Backend for Isla (ElevenLabs agent "BI Info - V4"). Replaces three Make scenarios so Isla's calls no longer count against the Make plan's 10,000 operations a month.

| Route | Replaces Make scenario | Called by |
|---|---|---|
| `GET /ferry?direction=seattle_to_bi\|bi_to_seattle&tripdate=YYYY-MM-DD` | 4831289 BI — Ferry Schedule Wrapper | ElevenLabs tools `WSDOT_Ferry_Seattle_to_BI`, `WSDOT_Ferry_BI_to_Seattle` |
| `POST /sms?caller_id=+1...` | 4403753 BI Info Send Text Twilio | ElevenLabs tool `BI_Info_Send_Text` |
| `POST /postcall` | 4823209 BI — Post-Call Report | ElevenLabs post-call webhook |

`/ferry` and `/sms` require the header `x-isla-key`. `/postcall` checks the ElevenLabs signature.

Output text and SMS wording match the Make versions exactly (see `test/worker.test.js`).

## One-time setup (Charles)

1. **Cloudflare → Workers & Pages → Create → Import a repository** → pick `red4golf/isla-worker`. Keep the defaults (build command empty, deploy command `npx wrangler deploy`).
2. **Worker → Settings → Variables and Secrets** → add each as type *Secret*:
   - `ISLA_TOOL_KEY` — any long random string (Claude will put the same value on Isla's tools)
   - `WSDOT_API_KEY` — the WSDOT access code (same one the Make ferry scenario uses)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — Twilio console → Account info
   - `SLACK_WEBHOOK_URL` — Slack → create an Incoming Webhook for the BI Info channel
   - `ELEVENLABS_WEBHOOK_SECRET` — ElevenLabs → Settings → Webhooks (post-call webhook)
3. Send Claude the Worker URL (`https://isla-worker.<your-subdomain>.workers.dev`).

## Switch-over (Claude, one tool at a time)

1. Ferry tools → Worker URL + `x-isla-key` header. Test call.
2. Send-text tool → Worker URL. Test call to Charles's phone.
3. Post-call webhook → `/postcall`. Check the Slack report.
4. Leave the Make scenarios off but in place for a week as a fallback, then delete.

## Call log (`/calls`)

Every call is saved to the D1 database `isla-calls` (binding `DB`): `/postcall` writes the call (caller number, name, email, places, summary, text result) and `/sms` logs each text sent. Tables are in `schema.sql`.

`https://isla-worker.soccer-carpool-worker.workers.dev/calls` is a private page: recent calls, repeat callers, top places, search, and CSV export. Sign-in texts a one-time link to the owner phone stored in D1 (`settings.owner_phone`); sessions last 30 days. No passwords.

This replaces the Google Sheet row the Make scenario used to write.

## Updating places

`src/places.json` is the address/phone/notes table for texts (built from Isla's KB, 2026-10-02). Edit it here; Cloudflare redeploys on push. Run `npm test` first.

## Local dev

```
npm install
npm test
npx wrangler dev   # needs .dev.vars with the secrets above
```
