
const TOKEN_URL = "https://www.onemap.gov.sg/api/auth/post/getToken";
const SEARCH_URL = "https://www.onemap.gov.sg/api/common/elastic/search";
const PLANNING_AREA_URL = "https://www.onemap.gov.sg/api/public/popapi/getPlanningarea";
const PLANNING_AREA_YEAR = "2019";

export interface SgAddress {
  postcode: string;
  building: string;
  blockNo: string;
  road: string;
  address: string;
  lat: string;
  lng: string;
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
    planningArea: "",
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
    return null;
  }
  if (!j.access_token) return null;
  const expiresAt = j.expiry_timestamp ? Number(j.expiry_timestamp) * 1000 : Date.now() + 2 * 86_400_000;
  cachedToken = { token: j.access_token, expiresAt };
  return j.access_token;
}

async function getPlanningArea(lat: string, lng: string, token: string, f: typeof fetch): Promise<string> {
  if (!lat || !lng) return "";
  const url = `${PLANNING_AREA_URL}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&year=${PLANNING_AREA_YEAR}`;
  try {
    const res = await f(url, { headers: { authorization: token } });
    if (!res.ok) return "";
    return parsePlanningArea(await res.json());
  } catch {
    return "";
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
  if (results.length > 0) {
    const planningArea = await getPlanningArea(results[0].lat, results[0].lng, token, f);
    if (planningArea) for (const r of results) r.planningArea = planningArea;
  }
  return { configured: true, results };
}
