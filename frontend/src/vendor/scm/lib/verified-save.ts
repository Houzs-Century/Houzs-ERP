// ---------------------------------------------------------------------------
// verifiedSave — write + readback + compare + honest result.
//
// Borrowed from Hookka ERP via 2990's apps/backend/src/lib/verified-save.ts.
// The discipline: when we tell the operator "saved", it must have ACTUALLY
// persisted — not merely that the backend returned 200. A 200 can lie: the
// write half-applied, the response dropped, or a stale cache served the
// pre-write payload and silently overwrote an optimistic update.
//
// verifiedSave:
//   1. Sends the mutating request (POST / PUT / PATCH / DELETE).
//   2. On 2xx, READS BACK the affected resource via the caller's `readback`
//      (which MUST bypass the FE cache — use readbackGet() or a no-store fetch).
//   3. Compares the readback against `expect` (the fields we asked to write).
//   4. Returns an honest result:
//        { ok: true,  data }                               ← truly persisted
//        { ok: false, reason: 'http',     status, body }   ← server rejected
//        { ok: false, reason: 'network',  details }        ← unreachable / read failed
//        { ok: false, reason: 'mismatch', diffs, data }    ← 200 but didn't stick
//
// ── HOUZS VENDOR ADAPTATION (only the auth + base URL changed) ─────────────
//   • API_URL now points at the Houzs Worker + the /api/scm mount (same base
//     authed-fetch uses), with a build-time VITE_API_URL override.
//   • The bearer token comes from Houzs's JWT store via readAuthToken()
//     instead of supabase.auth.getSession(); the lazy supabase imports in
//     authedFetcher + readbackGet are removed. Everything else (write →
//     readback → compare → honest result, friendly messages) is verbatim.
// ---------------------------------------------------------------------------

// See authed-fetch.ts's import note: the token may be in sessionStorage, so the
// read must come from the shared accessor, never an inlined localStorage hit.
import { readAuthToken } from '../../../lib/authToken';
import {
  consumeCorrelated,
  correlatedFetch,
  requestIdFromError,
  requestIdFromResponse,
} from '../../../lib/requestCorrelation';
import { companyHeader } from '../../../lib/activeCompany';

// PROD fallback is same-origin (Pages Function proxies /api/*); see
// authed-fetch.ts for the rationale.
const API_URL =
  (import.meta.env.VITE_API_URL ||
    (import.meta.env.PROD ? '' : 'https://autocount-sync-api.houzs-erp.workers.dev')) +
  '/api/scm';

// Multi-company (Phase 0c): stamp the active company on every SCM request so
// the backend's companyContext resolves it. The id comes from the SHARED
// accessor (src/lib/activeCompany.ts); the local localStorage re-read this file
// used to carry is gone, so there is exactly one implementation of the rule.
// Absent → NO header → backend falls back to its hostname default, so
// single-company Houzs is unchanged. Read FRESH per request so switching
// company mid-session is picked up immediately.
export type SaveDiff = { field: string; expected: unknown; actual: unknown };

export type SaveResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'http'; status: number; body: string; requestId?: string }
  | { ok: false; reason: 'network'; details: string; requestId?: string }
  | { ok: false; reason: 'mismatch'; diffs: SaveDiff[]; data: T };

/** Mutation transport — injectable so tests don't touch the network/auth. */
export type Fetcher = (path: string, init: RequestInit) => Promise<Response>;

export type VerifiedSaveArgs<T> = {
  endpoint: string;
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Re-reads the resource AFTER the write, bypassing any FE cache. */
  readback: () => Promise<T | null>;
  /** field → expected value. Each field is compared against the readback. */
  expect: Record<string, unknown>;
  /** How to pull a field's value from the readback (default: data[field]). */
  accessor?: (data: T, field: string) => unknown;
  /** Injectable transport for the mutation (default: authed fetch). */
  fetcher?: Fetcher;
};

/** Pure comparison — exported for tests. Returns the fields whose persisted
 *  value differs from what we asked to write. Uses SameValueZero-ish equality
 *  (===) after JSON-normalising objects/arrays so {a:1} === {a:1}. */
export function computeSaveDiffs<T>(
  data: T,
  expect: Record<string, unknown>,
  accessor?: (data: T, field: string) => unknown,
): SaveDiff[] {
  const diffs: SaveDiff[] = [];
  for (const [field, expected] of Object.entries(expect)) {
    const actual = accessor ? accessor(data, field) : (data as Record<string, unknown>)?.[field];
    if (!valuesEqual(expected, actual)) diffs.push({ field, expected, actual });
  }
  return diffs;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a === 'object' || typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

/** Authenticated fetch to the API (same auth as authed-fetch). */
const authedFetcher: Fetcher = async (path, init) => {
  const token = readAuthToken();
  /* Lands in the 'network' result's `details` (not user-facing today), but keep
     it a sentence so any future surfacing of details is already plain. */
  if (!token) throw new Error('Your session has expired — please sign in again.');
  return correlatedFetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      ...companyHeader(),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
};

/** Cache-busting authed GET — the canonical `readback` for verifiedSave. */
export async function readbackGet<T>(path: string): Promise<T | null> {
  const token = readAuthToken();
  if (!token) return null;
  const sep = path.includes('?') ? '&' : '?';
  const res = await correlatedFetch(`${API_URL}${path}${sep}_t=${Date.now()}`, {
    cache: 'no-store',
    headers: { authorization: `Bearer ${token}`, ...companyHeader() },
  });
  if (!res.ok) return null;
  return consumeCorrelated(res, () => res.json() as Promise<T>);
}

/** Turn a FAILED save into an operator-friendly, plain-language sentence — no
 *  HTTP status codes, no raw response bodies, no database column names. */
export function friendlySaveMessage(
  result: Exclude<SaveResult<unknown>, { ok: true }>,
  opts: { noun: string; fieldNames?: Record<string, string>; fmt?: (v: unknown) => string },
): string {
  const Noun = opts.noun.charAt(0).toUpperCase() + opts.noun.slice(1);
  const label = (f: string) => opts.fieldNames?.[f] ?? f.replace(/_sen$/, '').replace(/_/g, ' ');
  const fmt = opts.fmt ?? ((v: unknown) => (v == null || v === '' ? '(blank)' : `"${String(v)}"`));

  if (result.reason === 'mismatch') {
    const parts = result.diffs.map((d) => `${label(d.field)} still shows ${fmt(d.actual)} instead of ${fmt(d.expected)}`);
    return `${Noun} not saved — ${parts.join('; ')}. Please key it in again and press Save.`;
  }
  if (result.reason === 'network') {
    return `Couldn't confirm the ${opts.noun} saved — the connection may have dropped. Please check and press Save again.`;
  }
  // http — only surface the server's reason if it's already a plain sentence
  // (hide raw JSON / SQL / error codes from the operator).
  const reason = extractPlainReason(result.body);
  return reason
    ? `${Noun} not saved — ${reason}`
    : `The ${opts.noun} couldn't be saved. Please try again — if it keeps happening, let IT know.`;
}

/** Pull a human-readable reason out of an API error body, or null if the body
 *  is raw/technical (JSON, SQL, error codes) that an operator shouldn't see. */
function extractPlainReason(body: string): string | null {
  try {
    const j = JSON.parse(body) as { reason?: unknown; message?: unknown };
    const r = (typeof j.reason === 'string' ? j.reason : typeof j.message === 'string' ? j.message : '') as string;
    /* Third copy of the hygiene gate (api/client.ts + authed-fetch.ts carry the
       other two, both hardened this branch): a snake_case CODE echoed into
       `message` is short and passes every keyword test, and would be printed
       verbatim inside "<Noun> not saved — <code>". Never user-facing text. */
    const isErrorCode = /^[a-z][a-z0-9_]*$/.test(r.trim());
    if (r && !isErrorCode && r.length < 200 && !/violates|constraint|null value|column|relation|syntax|PGRST|\b\d{5}\b/i.test(r)) {
      return r;
    }
  } catch { /* not JSON — fall through */ }
  return null;
}

export async function verifiedSave<T>(args: VerifiedSaveArgs<T>): Promise<SaveResult<T>> {
  const fetcher = args.fetcher ?? authedFetcher;

  // 1. Send the mutation.
  let res: Response;
  try {
    res = await fetcher(args.endpoint, {
      method: args.method ?? 'PATCH',
      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
    });
  } catch (e) {
    return {
      ok: false,
      reason: 'network',
      details: e instanceof Error ? e.message : String(e),
      requestId: requestIdFromError(e),
    };
  }
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    return { ok: false, reason: 'http', status: res.status, body, requestId: requestIdFromResponse(res) };
  }

  // 2. Read back (cache-bypassing) and 3. compare.
  let data: T | null;
  try {
    data = await args.readback();
  } catch (e) {
    return {
      ok: false,
      reason: 'network',
      details: `readback failed: ${e instanceof Error ? e.message : String(e)}`,
      requestId: requestIdFromError(e),
    };
  }
  if (data == null) {
    return { ok: false, reason: 'network', details: 'readback returned no data — save state unknown' };
  }

  const diffs = computeSaveDiffs(data, args.expect, args.accessor);
  if (diffs.length > 0) return { ok: false, reason: 'mismatch', diffs, data };

  // 4. Honest success.
  return { ok: true, data };
}
