// ----------------------------------------------------------------------------
// onemap-sg — resolve a real Singapore 6-digit postcode to its address via
// Singapore's official OneMap API (https://www.onemap.gov.sg/apidocs/).
//
// WHY. scm.my_localities holds only 55 representative SG codes (one per URA
// planning area, mig 0181); Singapore really has ~150k per-building postcodes,
// so a real SG postcode shows "No match". Rather than import 150k rows into the
// shared master, we look the code up live and autofill the address.
//
// CITY + STATE. On top of the address, we call getPlanningarea with the search
// result's coordinates to get the URA planning area (pln_area_n). That name is
// exactly one of the 55 seeded SG cities, so the front end maps it back to the
// seeded { city, state } and fills those too — a real SG postcode then behaves
// like a Malaysian one (postcode -> address + City + State). Best-effort: if
// getPlanningarea fails for any reason, planningArea is "" and the address
// still returns, so the field degrades to address-only.
//
// SHAPE. Pure transforms + one orchestration function that takes an INJECTED
// fetch, so the whole thing is unit-testable without the network or the auth
// harness. The route (routes/sg-postcode.ts) is a thin wrapper over
// lookupSgPostcode with globalThis.fetch.
//
// INERT until configured. With no ONEMAP_EMAIL / ONEMAP_PASSWORD it returns
// { configured: false } and the frontend keeps the seeded 55-area picker —
// the same no-op contract RESEND_API_KEY uses (types.ts).
// ----------------------------------------------------------------------------

const TOKEN_URL = "https://www.onemap.gov.sg/api/auth/post/getToken";
const SEARCH_URL = "https://www.onemap.gov.sg/api/common/elastic/search";
const PLANNING_AREA_URL = "https://www.onemap.gov.sg/api/public/popapi/getPlanningarea";
// URA Master Plan year. 2019 matches mig 0181's SG seed (its 55 planning areas
// are the MP2019 set), so the returned pln_area_n lines up with a seeded city.
const PLANNING_AREA_YEAR = "2019";

export interface SgAddress {
  postcode: string;
  building: string;
  blockNo: string;
  road: string;
  address: string;
  lat: string;
  lng: string;
  // URA planning area for this coordinate (pln_area_n from getPlanningarea),
  // uppercased as OneMap returns it. "" when unresolved — the address is still
  // returned; the front end matches this against the seeded SG cities to fill
  // City + State, and simply skips that fill when it is "".
  planningArea: string;
}

export interface SgLookupResult {
  configured: boolean;
  results: SgAddress[];
  error?: "invalid_postcode" | "auth_failed" | "lookup_failed";
}

export function isValidSgPostcode(code: string): boolean {
  return /^\d{6}$/.test((code ?? "").trim());
}

/** OneMap writes the literal "NIL" where a field is absent — treat it as empty. */
function field(v: unknown): string {
  const s = String(v ?? "").trim();
  return s === "NIL" ? "" : s;
}

export function normalizeSearchResult(r: Record<string, unknown>): SgAddress {
  return {
    postcode: field(r.POSTAL),
    building: field(r.BUILDING),
    blockNo: field(r.BLK_NO),
    road: field(r.ROAD_NAME),
    address: field(r.ADDRESS),
    lat: field(r.LATITUDE),
    lng: field(r.LONGITUDE),
    planningArea: "", // filled in by lookupSgPostcode after getPlanningarea
  };
}

/** Pull the planning-area NAME (pln_area_n) out of a getPlanningarea response.
 *  OneMap returns an array whose first element carries it; an empty array, an
 *  error object, or a coordinate outside every planning area all yield "".
 *  Uppercased and trimmed so it matches the seeded SG cities case-insensitively. */
export function parsePlanningArea(json: unknown): string {
  if (!Array.isArray(json) || json.length === 0) return "";
  const first = json[0] as Record<string, unknown>;
  const name = typeof first.pln_area_n === "string" ? first.pln_area_n.trim() : "";
  return name === "NIL" ? "" : name.toUpperCase();
}

/** Address line 1 an operator would write: block + road, falling back to the
 *  building name, then the whole formatted address. */
export function addressLine1(a: SgAddress): string {
  const blkRoad = [a.blockNo, a.road].filter(Boolean).join(" ").trim();
  return blkRoad || a.building || a.address;
}

// Token cache lives per-isolate. OneMap tokens are valid ~3 days; a cold isolate
// simply re-fetches. Reset hook is for tests only.
let cachedToken: { token: string; expiresAt: number } | null = null;
export function __resetOneMapTokenCacheForTest(): void {
  cachedToken = null;
}

async function getToken(email: string, password: string, f: typeof fetch): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const res = await f(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  let j: { access_token?: string; expiry_timestamp?: string };
  try {
    j = (await res.json()) as { access_token?: string; expiry_timestamp?: string };
  } catch {
    return null; // malformed token response -> caller reports auth_failed
  }
  if (!j.access_token) return null;
  // expiry_timestamp is a unix time in SECONDS; fall back to +2 days if absent.
  const expiresAt = j.expiry_timestamp ? Number(j.expiry_timestamp) * 1000 : Date.now() + 2 * 86_400_000;
  cachedToken = { token: j.access_token, expiresAt };
  return j.access_token;
}

/** Best-effort planning-area lookup for a coordinate. Never throws and never
 *  fails the address lookup: returns "" on missing coords, a network error, a
 *  non-OK status, a parse error or a missing field, so lookupSgPostcode still
 *  returns the resolved address. Reuses the search token. */
async function getPlanningArea(lat: string, lng: string, token: string, f: typeof fetch): Promise<string> {
  if (!lat || !lng) return "";
  const url = `${PLANNING_AREA_URL}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&year=${PLANNING_AREA_YEAR}`;
  try {
    const res = await f(url, { headers: { authorization: token } });
    if (!res.ok) return "";
    return parsePlanningArea(await res.json());
  } catch {
    return ""; // enrichment is optional — degrade to address-only
  }
}

/** Resolve a 6-digit SG postcode to its OneMap address rows. Returns
 *  { configured:false } when credentials are absent (the inert contract). */
export async function lookupSgPostcode(
  opts: { email?: string; password?: string; fetchImpl?: typeof fetch },
  code: string,
): Promise<SgLookupResult> {
  const { email, password } = opts;
  const f = opts.fetchImpl ?? fetch;
  if (!email || !password) return { configured: false, results: [] };
  const want = (code ?? "").trim();
  if (!isValidSgPostcode(want)) return { configured: true, results: [], error: "invalid_postcode" };

  const token = await getToken(email, password, f);
  if (!token) return { configured: true, results: [], error: "auth_failed" };

  const url = `${SEARCH_URL}?searchVal=${want}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const res = await f(url, { headers: { authorization: token } });
  if (!res.ok) return { configured: true, results: [], error: "lookup_failed" };
  let j: { results?: Array<Record<string, unknown>> };
  try {
    j = (await res.json()) as { results?: Array<Record<string, unknown>> };
  } catch {
    return { configured: true, results: [], error: "lookup_failed" };
  }
  const results = (j.results ?? [])
    .filter((r) => String(r.POSTAL ?? "").trim() === want)
    .map(normalizeSearchResult);
  // Best-effort: enrich with the URA planning area so the form can also fill
  // City + State. All rows for one postcode share a location, so a single
  // lookup off the first row's coords applies to every row. Never fails the
  // address path — planningArea just stays "" and the form fills address only.
  if (results.length > 0) {
    const planningArea = await getPlanningArea(results[0].lat, results[0].lng, token, f);
    if (planningArea) for (const r of results) r.planningArea = planningArea;
  }
  return { configured: true, results };
}
