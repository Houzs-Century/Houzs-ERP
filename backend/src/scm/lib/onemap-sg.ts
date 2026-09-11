// ----------------------------------------------------------------------------
// onemap-sg — resolve a real Singapore 6-digit postcode to its address via
// Singapore's official OneMap API (https://www.onemap.gov.sg/apidocs/).
//
// WHY. scm.my_localities holds only 55 representative SG codes (one per URA
// planning area, mig 0181); Singapore really has ~150k per-building postcodes,
// so a real SG postcode shows "No match". Rather than import 150k rows into the
// shared master, we look the code up live and autofill the address.
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

export interface SgAddress {
  postcode: string;
  building: string;
  blockNo: string;
  road: string;
  address: string;
  lat: string;
  lng: string;
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
  };
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
  const j = (await res.json().catch(() => null)) as { access_token?: string; expiry_timestamp?: string } | null;
  if (!j?.access_token) return null;
  // expiry_timestamp is a unix time in SECONDS; fall back to +2 days if absent.
  const expiresAt = j.expiry_timestamp ? Number(j.expiry_timestamp) * 1000 : Date.now() + 2 * 86_400_000;
  cachedToken = { token: j.access_token, expiresAt };
  return j.access_token;
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
  const j = (await res.json().catch(() => null)) as { results?: Array<Record<string, unknown>> } | null;
  const results = (j?.results ?? [])
    .filter((r) => String(r.POSTAL ?? "").trim() === want)
    .map(normalizeSearchResult);
  return { configured: true, results };
}
