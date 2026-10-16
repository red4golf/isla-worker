// Isla call log: private page at /calls backed by the D1 database (env.DB).
// Sign-in: the page texts a one-time link to the owner's phone (settings.owner_phone in D1).
// No passwords. The link opens a confirm page; the token is only used on POST, so SMS link
// previews can't burn it. A session cookie then lasts 30 days.
//
//   GET  /calls              dashboard (or sign-in page)
//   POST /calls/login        text a sign-in link to the owner
//   GET  /calls/auth?t=...   confirm page        POST /calls/auth   start session
//   GET  /calls/data         JSON for the dashboard
//   GET  /calls/export.csv   everything as CSV
//   POST /calls/logout

import { twilioSend, lookupPlace } from "./sms.js";

const LINK_TTL = 15 * 60;
const SESSION_TTL = 30 * 24 * 3600;
const COOKIE = "isla_s";
const now = () => Math.floor(Date.now() / 1000);

function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function cookieToken(request) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`));
  return m ? m[1] : null;
}

async function hasSession(request, env) {
  const t = cookieToken(request);
  if (!t) return false;
  const r = await env.DB.prepare("SELECT 1 FROM auth_tokens WHERE token=? AND kind='session' AND expires_unix>?")
    .bind(t, now()).first();
  return !!r;
}

async function ownerPhone(env) {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='owner_phone'").first();
  return r?.v || null;
}

const SEC_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
};

function html(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { ...SEC_HEADERS, ...extra } });
}

export async function handleCalls(request, env, ctx) {
  if (!env.DB) return new Response("call log database not connected", { status: 503 });
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/calls/login" && method === "POST") return sendLink(url, env);
  if (path === "/calls/auth" && method === "GET") {
    const t = url.searchParams.get("t") || "";
    return html(shell("Sign in", `<h1>Isla call log</h1><form method="post" action="/calls/auth">
      <input type="hidden" name="t" value="${/^[0-9a-f]{64}$/.test(t) ? t : ""}">
      <button class="primary" type="submit">Sign in on this device</button></form>`));
  }
  if (path === "/calls/auth" && method === "POST") return startSession(request, env);

  const authed = await hasSession(request, env);
  if (path === "/calls/logout" && method === "POST") {
    const t = cookieToken(request);
    if (t) await env.DB.prepare("DELETE FROM auth_tokens WHERE token=?").bind(t).run();
    return new Response(null, { status: 303, headers: { location: "/calls", "set-cookie": `${COOKIE}=; Path=/calls; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
  }
  if (!authed) {
    if (path === "/calls") return html(loginPage());
    return new Response("sign in first", { status: 401 });
  }
  if (path === "/calls") return html(DASHBOARD);
  if (path === "/calls/data") return dataJson(env);
  if (path === "/calls/export.csv") return exportCsv(env);
  return new Response("not found", { status: 404 });
}

async function sendLink(url, env) {
  const owner = await ownerPhone(env);
  if (!owner) return html(shell("Not set up", `<h1>Not set up yet</h1><p>No owner phone is configured for this call log.</p>`), 503);
  await env.DB.prepare("DELETE FROM auth_tokens WHERE expires_unix<?").bind(now()).run();
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE kind='link'").first();
  if ((pending?.n || 0) >= 3) {
    return html(shell("Check your phone", `<h1>Check your phone</h1><p>Sign-in links were already sent in the last 15 minutes. Use the newest one.</p>`));
  }
  const t = randomToken();
  await env.DB.prepare("INSERT INTO auth_tokens (token, kind, expires_unix) VALUES (?, 'link', ?)").bind(t, now() + LINK_TTL).run();
  const link = `${url.origin}/calls/auth?t=${t}`;
  const { res } = await twilioSend(env, owner, `Isla call log sign-in link (expires in 15 min):\n${link}\n\nIf you didn't ask for this, ignore it.`);
  if (!res?.ok) return html(shell("Couldn't send", `<h1>Couldn't send the text</h1><p>Try again in a minute.</p>`), 502);
  return html(shell("Check your phone", `<h1>Check your phone</h1><p>A sign-in link was texted to the owner's phone. It works once and expires in 15 minutes.</p>`));
}

async function startSession(request, env) {
  const form = await request.formData().catch(() => null);
  const t = String(form?.get("t") || "");
  if (!/^[0-9a-f]{64}$/.test(t)) return html(loginPage("That link isn't valid."), 400);
  const row = await env.DB.prepare("SELECT expires_unix FROM auth_tokens WHERE token=? AND kind='link'").bind(t).first();
  await env.DB.prepare("DELETE FROM auth_tokens WHERE token=?").bind(t).run();
  if (!row || row.expires_unix < now()) return html(loginPage("That link has expired or was already used."), 400);
  const s = randomToken();
  await env.DB.prepare("INSERT INTO auth_tokens (token, kind, expires_unix) VALUES (?, 'session', ?)").bind(s, now() + SESSION_TTL).run();
  return new Response(null, {
    status: 303,
    headers: { location: "/calls", "set-cookie": `${COOKIE}=${s}; Path=/calls; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=Lax` },
  });
}

const SKIP_PLACES = /^(ferry schedule|ferry|none|restaurant|restaurants|places to stay|high school)$/i;

// Canonical place names for a free-text "locations" list.
export function canonicalPlaces(text) {
  if (!text) return [];
  const out = [];
  for (const raw of String(text).split(",")) {
    const s = raw.trim();
    if (!s || SKIP_PLACES.test(s)) continue;
    const name = lookupPlace(s)?.n || s.replace(/\b\w/g, (c) => c.toUpperCase());
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

async function dataJson(env) {
  const owner = await ownerPhone(env);
  const { results } = await env.DB.prepare(
    "SELECT conversation_id, start_unix, duration_secs, phone, source, name, email, locations, title, summary, text_places, text_ok FROM calls ORDER BY start_unix DESC LIMIT 5000"
  ).all();
  const calls = results.map((r) => ({ ...r, places: canonicalPlaces(r.locations), is_owner: !!owner && r.phone === owner }));
  return new Response(JSON.stringify({ calls }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCsv(env) {
  const { results } = await env.DB.prepare("SELECT * FROM calls ORDER BY start_unix DESC").all();
  const cols = ["start_pacific", "duration_secs", "phone", "name", "email", "locations", "text_places", "text_ok", "title", "summary", "conversation_id"];
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", dateStyle: "short", timeStyle: "short" });
  const lines = [cols.join(",")];
  for (const r of results) {
    const row = { ...r, start_pacific: fmt.format(new Date(r.start_unix * 1000)), text_ok: r.text_ok == null ? "" : r.text_ok ? "sent" : "failed" };
    lines.push(cols.map((c) => csvCell(row[c])).join(","));
  }
  return new Response(lines.join("\r\n"), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="isla-calls.csv"', "cache-control": "no-store" },
  });
}

const CSS = `
:root{--bg:#f6f4ef;--card:#fff;--ink:#1d2421;--muted:#66706b;--line:#e3dfd6;--accent:#1f6f5c;--accent-soft:#e3f0ec;--warn:#a5482f;--warn-soft:#f6e6e0;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141816;--card:#1d2320;--ink:#e8ece9;--muted:#9aa49f;--line:#2e3632;--accent:#5fb89f;--accent-soft:#1f3a32;--warn:#e08a70;--warn-soft:#3a2520;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:8px 0 4px}p{color:var(--muted)}
button,.btn{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:8px 14px;cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;padding:12px 18px;font-weight:600}
`;

function shell(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · Isla calls</title><style>${CSS}</style></head><body><div class="wrap">${inner}</div></body></html>`;
}

function loginPage(msg = "") {
  return shell("Sign in", `<h1>Isla call log</h1><p>${msg ? msg + " " : ""}Private. Tap below and a one-time sign-in link will be texted to the owner's phone.</p>
  <form method="post" action="/calls/login"><button class="primary" type="submit">Text me a sign-in link</button></form>`);
}

const DASHBOARD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Isla calls</title><style>${CSS}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}.stat b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.stat span{color:var(--muted);font-size:13px}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.tabs{display:flex;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}.tabs button{border:0;border-radius:0}.tabs button.on{background:var(--accent);color:#fff}
input[type=search]{flex:1;min-width:180px;font:inherit;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}
label.chk{color:var(--muted);font-size:14px;display:flex;gap:6px;align-items:center}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:10px}
.row{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.when{font-weight:600}.muted{color:var(--muted);font-size:13px}
.who a{color:var(--accent);text-decoration:none;font-weight:600}.badge{font-size:12px;background:var(--accent-soft);color:var(--accent);border-radius:99px;padding:2px 8px;margin-left:6px}
.chips{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}.chip{font-size:13px;border:1px solid var(--line);border-radius:99px;padding:2px 10px}
.txt{font-size:13px;margin-top:8px}.ok{color:var(--accent)}.bad{color:var(--warn)}
details{margin-top:8px}summary{cursor:pointer;color:var(--muted);font-size:13px}details p{color:var(--ink);margin:6px 0}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}td,th{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left}th{font-size:13px;color:var(--muted);font-weight:600}td.n{text-align:right;font-variant-numeric:tabular-nums}
.empty{color:var(--muted);text-align:center;padding:30px}
@media (max-width:560px){.stats{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="wrap">
<header><h1>Isla call log</h1><div><a class="btn" href="/calls/export.csv">Export CSV</a> <form method="post" action="/calls/logout" style="display:inline"><button>Sign out</button></form></div></header>
<div class="stats" id="stats"></div>
<div class="bar"><div class="tabs"><button data-v="calls" class="on">Calls</button><button data-v="callers">Callers</button><button data-v="places">Places</button></div>
<input type="search" id="q" placeholder="Search name, number, place, summary"><label class="chk"><input type="checkbox" id="hideMine" checked> Hide my own calls</label></div>
<div id="out"><div class="empty">Loading…</div></div></div>
<script>
const $=s=>document.querySelector(s);let ALL=[],view="calls";
const fmtWhen=new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
const fmtDay=new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",month:"short",day:"numeric",year:"numeric"});
function phoneFmt(p){const m=/^\\+1(\\d{3})(\\d{3})(\\d{4})$/.exec(p||"");return m?"("+m[1]+") "+m[2]+"-"+m[3]:(p||"")}
function dur(s){if(s==null)return"";const m=Math.floor(s/60),r=s%60;return m?m+"m "+String(r).padStart(2,"0")+"s":r+"s"}
function el(tag,attrs,...kids){const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs||{})){if(k==="class")e.className=v;else e.setAttribute(k,v)}for(const k of kids){if(k==null||k===false)continue;e.append(k instanceof Node?k:document.createTextNode(String(k)))}return e}
function rows(){const q=$("#q").value.trim().toLowerCase();const hide=$("#hideMine").checked;return ALL.filter(c=>!(hide&&c.is_owner)).filter(c=>!q||[c.name,c.phone,phoneFmt(c.phone),c.email,c.locations,c.summary,c.title,c.text_places].join(" ").toLowerCase().includes(q))}
function counts(list){const m={};for(const c of list)if(c.phone)m[c.phone]=(m[c.phone]||0)+1;return m}
function stats(list){const t=Date.now()/1000,wk=list.filter(c=>c.start_unix>t-7*86400).length,mo=list.filter(c=>c.start_unix>t-30*86400).length,uniq=new Set(list.map(c=>c.phone).filter(Boolean)).size,tx=list.filter(c=>c.text_ok===1).length;
$("#stats").replaceChildren(...[[wk,"calls · 7 days"],[mo,"calls · 30 days"],[uniq,"unique callers"],[tx,"texts delivered"]].map(([n,l])=>el("div",{class:"stat"},el("b",{},n),el("span",{},l))))}
function renderCalls(list){const cnt=counts(ALL);if(!list.length)return[el("div",{class:"empty"},"No calls match.")];
return list.map(c=>{const who=el("div",{class:"who"},c.phone?el("a",{href:"tel:"+c.phone},c.name?c.name+" · "+phoneFmt(c.phone):phoneFmt(c.phone)):(c.name||"Web caller"),cnt[c.phone]>1?el("span",{class:"badge"},cnt[c.phone]+" calls"):null);
const txt=c.text_ok===1?el("div",{class:"txt ok"},"✓ Texted: "+(c.text_places||"details")):c.text_ok===0?el("div",{class:"txt bad"},"✗ Text failed"+(c.text_places?": "+c.text_places:"")):null;
return el("div",{class:"card"},el("div",{class:"row"},el("div",{},el("div",{class:"when"},fmtWhen.format(new Date(c.start_unix*1000))),el("div",{class:"muted"},[dur(c.duration_secs),c.title].filter(Boolean).join(" · "))),who),
c.places.length?el("div",{class:"chips"},...c.places.map(p=>el("span",{class:"chip"},p))):null,txt,
c.summary?el("details",{},el("summary",{},"Summary"),el("p",{},c.summary),el("a",{class:"muted",href:"https://elevenlabs.io/app/agents/history/"+encodeURIComponent(c.conversation_id),target:"_blank",rel:"noopener"},"Open in ElevenLabs ↗")):null)})}
function renderCallers(list){const m=new Map();for(const c of list){if(!c.phone)continue;const g=m.get(c.phone)||{phone:c.phone,name:null,n:0,last:0,places:new Set()};g.n++;g.name=g.name||c.name;g.last=Math.max(g.last,c.start_unix);c.places.forEach(p=>g.places.add(p));m.set(c.phone,g)}
const gs=[...m.values()].sort((a,b)=>b.n-a.n||b.last-a.last);if(!gs.length)return[el("div",{class:"empty"},"No callers match.")];
return[el("table",{},el("tr",{},el("th",{},"Caller"),el("th",{},"Calls"),el("th",{},"Last call"),el("th",{},"Places")),...gs.map(g=>el("tr",{},el("td",{},el("a",{href:"tel:"+g.phone},phoneFmt(g.phone)),g.name?el("div",{class:"muted"},g.name):null),el("td",{class:"n"},g.n),el("td",{},fmtDay.format(new Date(g.last*1000))),el("td",{class:"muted"},[...g.places].join(", ")))))]}
function renderPlaces(list){const t=Date.now()/1000,m=new Map();for(const c of list)for(const p of c.places){const g=m.get(p)||{p,all:0,wk:0,mo:0};g.all++;if(c.start_unix>t-7*86400)g.wk++;if(c.start_unix>t-30*86400)g.mo++;m.set(p,g)}
const gs=[...m.values()].sort((a,b)=>b.mo-a.mo||b.all-a.all);if(!gs.length)return[el("div",{class:"empty"},"No places yet.")];
return[el("table",{},el("tr",{},el("th",{},"Place"),el("th",{},"7 days"),el("th",{},"30 days"),el("th",{},"All time")),...gs.map(g=>el("tr",{},el("td",{},g.p),el("td",{class:"n"},g.wk),el("td",{class:"n"},g.mo),el("td",{class:"n"},g.all))))]}
function render(){const list=rows();stats(list);$("#out").replaceChildren(...(view==="calls"?renderCalls(list):view==="callers"?renderCallers(list):renderPlaces(list)))}
document.querySelectorAll(".tabs button").forEach(b=>b.onclick=()=>{view=b.dataset.v;document.querySelectorAll(".tabs button").forEach(x=>x.classList.toggle("on",x===b));render()});
$("#q").oninput=render;$("#hideMine").onchange=render;
fetch("/calls/data").then(r=>{if(r.status===401){location.reload();throw 0}return r.json()}).then(d=>{ALL=d.calls;render()}).catch(e=>{if(e)$("#out").replaceChildren(el("div",{class:"empty"},"Couldn't load calls."))});
</script></body></html>`;
