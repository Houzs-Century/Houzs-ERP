
import { readAuthToken } from '../../../lib/authToken';
import {
  consumeCorrelated,
  correlatedFetch,
  requestIdFromError,
  requestIdFromResponse,
} from '../../../lib/requestCorrelation';
import { companyHeader } from '../../../lib/activeCompany';

const API_URL =
  (import.meta.env.VITE_API_URL ||
    (import.meta.env.PROD ? '' : 'https://autocount-sync-api.houzs-erp.workers.dev')) +
  '/api/scm';

export type SaveDiff = { field: string; expected: unknown; actual: unknown };

export type SaveResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'http'; status: number; body: string; requestId?: string }
  | { ok: false; reason: 'network'; details: string; requestId?: string }
  | { ok: false; reason: 'unverified'; details: string; requestId?: string }
  | { ok: false; reason: 'mismatch'; diffs: SaveDiff[]; data: T };

/** Mutation transport — injectable so tests don't touch the network/auth. */
export type Fetcher = (path: string, init: RequestInit) => Promise<Response>;

export type VerifiedSaveArgs<T> = {
  endpoint: string;
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  readback: () => Promise<T | null>;
  expect: Record<string, unknown>;
  accessor?: (data: T, field: string) => unknown;
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
    try { return stableStringify(a) === stableStringify(b); } catch { return false; }
  }
  return false;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.keys(val as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = (val as Record<string, unknown>)[k];
            return acc;
          }, {})
      : val,
  );
}

const authedFetcher: Fetcher = async (path, init) => {
  const token = readAuthToken();
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
  if (result.reason === 'unverified') {
    return `${Noun} saved, but the check that it stuck was interrupted. Refresh the page to see it before keying it again.`;
  }
  if (result.reason === 'network') {
    return `Couldn't confirm the ${opts.noun} saved — the connection may have dropped. Please check and press Save again.`;
  }
  const reason = extractPlainReason(result.body);
  return reason
    ? `${Noun} not saved — ${reason}`
    : `The ${opts.noun} couldn't be saved. Please try again — if it keeps happening, let IT know.`;
}

function extractPlainReason(body: string): string | null {
  try {
    const j = JSON.parse(body) as { reason?: unknown; message?: unknown };
    const r = (typeof j.reason === 'string' ? j.reason : typeof j.message === 'string' ? j.message : '') as string;
    const isErrorCode = /^[a-z][a-z0-9_]*$/.test(r.trim());
    if (r && !isErrorCode && r.length < 200 && !/violates|constraint|null value|column|relation|syntax|PGRST|\b\d{5}\b/i.test(r)) {
      return r;
    }
  } catch { }
  return null;
}

const READBACK_ATTEMPTS = 3;
const READBACK_BACKOFF_MS = [300, 900];

export async function verifiedSave<T>(args: VerifiedSaveArgs<T>): Promise<SaveResult<T>> {
  const fetcher = args.fetcher ?? authedFetcher;

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
    try { body = await res.text(); } catch { }
    return { ok: false, reason: 'http', status: res.status, body, requestId: requestIdFromResponse(res) };
  }

  let data: T | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, READBACK_BACKOFF_MS[attempt - 1]));
    try {
      data = await args.readback();
      lastError = null;
    } catch (e) {
      lastError = e;
      data = null;
    }
    if (data != null) break;
  }
  if (lastError != null) {
    return {
      ok: false,
      reason: 'unverified',
      details: `readback failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      requestId: requestIdFromError(lastError),
    };
  }
  if (data == null) {
    return { ok: false, reason: 'unverified', details: 'readback returned no data — save state unknown' };
  }

  const diffs = computeSaveDiffs(data, args.expect, args.accessor);
  if (diffs.length > 0) return { ok: false, reason: 'mismatch', diffs, data };

  return { ok: true, data };
}
