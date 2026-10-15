// Ferry schedule route. Port of Make scenario 4831289 "BI — Ferry Schedule Wrapper (Isla)".
// Isla's two ferry tools call: GET /ferry?direction=seattle_to_bi|bi_to_seattle&tripdate=YYYY-MM-DD
// Output text matches the Make version so Isla's prompt doesn't need to change.

const TERMINALS = {
  seattle_to_bi: { path: "7/3", label: "Seattle to Bainbridge Island" },
  bi_to_seattle: { path: "3/7", label: "Bainbridge Island to Seattle" },
};

const timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

// WSDOT returns "/Date(1792067400000-0700)/"; the number is epoch milliseconds.
export function parseWsdotDate(s) {
  const m = /\/Date\((\d+)/.exec(String(s || ""));
  return m ? Number(m[1]) : NaN;
}

export function formatPacific(ms) {
  // Intl gives "1:10 PM"; Make's "h:mm A" gives the same.
  return timeFmt.format(new Date(ms)).replace(/ /g, " ");
}

export function buildFerryText({ direction, tripdate, schedule, now }) {
  const route = TERMINALS[direction];
  const times = schedule?.TerminalCombos?.[0]?.Times || [];
  const remaining = times
    .map((t) => parseWsdotDate(t.DepartingTime))
    .filter((ms) => Number.isFinite(ms) && ms > now)
    .map(formatPacific);
  const list = remaining.length ? remaining.join(", ") : "NONE - no sailings remain for this date";
  return (
    `Route: ${route.label}. Date: ${tripdate}. Remaining departures (Pacific time): ${list}. ` +
    `Crossing takes about 35 minutes. These are the only valid departure times - quote them exactly.`
  );
}

const UNAVAILABLE =
  "Ferry schedule is unavailable right now. Do not guess or estimate any sailing times. " +
  "Tell the caller to check the WSF app or wsdot.com/ferries for current times.";

export async function handleFerry(request, env, now = Date.now()) {
  const url = new URL(request.url);
  const direction = url.searchParams.get("direction");
  const tripdate = url.searchParams.get("tripdate") || "";
  if (!TERMINALS[direction] || !/^\d{4}-\d{2}-\d{2}$/.test(tripdate)) {
    return text(
      "Invalid request: direction must be seattle_to_bi or bi_to_seattle and tripdate must be YYYY-MM-DD (Pacific). " +
        "Do not guess any sailing times.",
      400
    );
  }
  const api =
    `https://www.wsdot.wa.gov/Ferries/api/schedule/rest/schedule/${tripdate}/${TERMINALS[direction].path}` +
    `?apiaccesscode=${encodeURIComponent(env.WSDOT_API_KEY)}`;
  let schedule;
  try {
    const res = await fetch(api, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) throw new Error(`WSDOT ${res.status}`);
    schedule = await res.json();
  } catch (err) {
    console.error("ferry fetch failed", err);
    return text(UNAVAILABLE, 200);
  }
  return text(buildFerryText({ direction, tripdate, schedule, now }), 200);
}

function text(body, status) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
