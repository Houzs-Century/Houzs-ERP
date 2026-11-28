import {
  cacheable,
  getCached,
  setCached,
  getInflight,
  setInflight,
  invalidateForMutation,
  currentEpoch,
  invalidatedSince,
} from "./cache";
import { companyHeader, getActiveCompanyId } from "../lib/activeCompany";
import { clearAuthToken, readAuthToken, writeAuthToken, readAuthPass, writeAuthPass } from "../lib/authToken";
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromError,
  requestIdFromResponse,
} from "../lib/requestCorrelation";
import { abortableDelay, abortReason, combineAbortSignals } from "../lib/abort";
import { openLoadedTab } from "../lib/openLoadedTab";

export { requestIdFromError } from "../lib/requestCorrelation";

const baseUrl =
  (import.meta.env.VITE_API_URL as string) ||
  (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");

export const tokenStore = {
  get: readAuthToken,
  set(token: string, persistent = true) {
    writeAuthToken(token, persistent);
  },
  clear() {
    clearAuthToken();
  },
};

/** The signed staff pass (stage 2). Written beside the token on login; cleared
 *  by `tokenStore.clear()` because `clearAuthToken` clears both. It has no
 *  `clear()` of its own so the pass and the token can never drift out of the
 *  same lifecycle. Nothing sends or verifies it yet — stage 3 does. */
export const passStore = {
  get: readAuthPass,
  set(pass: string, persistent = true) {
    writeAuthPass(pass, persistent);
  },
};

function passHeader(): Record<string, string> {
  const p = readAuthPass();
  return p ? { "X-Session-Pass": p } : {};
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

type ForbiddenListener = (message: string) => void;
const forbiddenListeners = new Set<ForbiddenListener>();
export function onForbidden(fn: ForbiddenListener): () => void {
  forbiddenListeners.add(fn);
  return () => forbiddenListeners.delete(fn);
}

/**
 * Request telemetry, delivered as a listener for the SAME reason onForbidden is
 * one: errorReporter already imports `api` from this module (it needs baseUrl
 * for its POST target), so importing the reporter back would close a cycle that
 * bites at module-init time. The subscriber registers itself at boot instead.
 *
 * This exists because the window-level crash capture is blind to the two things
 * staff actually report. A slow request still RESOLVES, and a failed one is
 * turned into a toast — neither reaches `window.onerror`, so System Health
 * could only ever show crashes, never "it's slow" or "it failed to load".
 */
export type RequestTelemetry =
  | { kind: "slow"; method: string; path: string; ms: number }
  | { kind: "server-error"; method: string; path: string; status: number }
  | { kind: "forbidden"; method: string; path: string };
type TelemetryListener = (event: RequestTelemetry) => void;
const telemetryListeners = new Set<TelemetryListener>();
export function onRequestTelemetry(fn: TelemetryListener): () => void {
  telemetryListeners.add(fn);
  return () => telemetryListeners.delete(fn);
}
function emitTelemetry(event: RequestTelemetry): void {
  for (const fn of telemetryListeners) {
    try {
      fn(event);
    } catch {
    }
  }
}

function extractErrorMessage(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {}
  return "";
}

const isErrorCode = (s: string) => /^[a-z][a-z0-9_]*$/.test(s);

const ERROR_CODE_MESSAGES: Record<string, string> = {
  idempotency_in_flight:
    "This is already going through — give it a moment, then refresh to check. Please don't send it again.",
  idempotency_key_reused:
    "An earlier submission with different details already finished under this request key. Refresh and check what was recorded before sending it again.",
  idempotency_key_conflict:
    "This request key is already owned by another operation. Refresh and try again.",
  idempotency_unavailable:
    "We couldn't safely record this yet. Nothing was sent — wait a moment and try again.",
  idempotency_outcome_unknown:
    "We couldn't confirm whether this was recorded. Don't submit it again — refresh and check first.",
  invalid_idempotency_key:
    "This action couldn't be submitted safely. Refresh the page and try again.",
  idempotency_payload_too_large:
    "This upload is too large for safe retry. Upload the file separately.",
};

const looksLikeInternals = (s: string) =>
  /violates|constraint|null value|no such column|no such table|syntax error|PGRST|D1_ERROR|SQLITE|duplicate key|error_code/i.test(
    s,
  );

const HTTP_REASON_PHRASES = new Set([
  "bad request", "unauthorized", "payment required", "forbidden", "not found",
  "method not allowed", "not acceptable", "request timeout", "conflict", "gone",
  "length required", "precondition failed", "payload too large", "uri too long",
  "unsupported media type", "unprocessable entity", "too many requests",
  "internal server error", "not implemented", "bad gateway",
  "service unavailable", "gateway timeout",
]);

function presentable(s: string): string {
  const v = s.trim();
  if (!v) return "";
  if (HTTP_REASON_PHRASES.has(v.toLowerCase())) return "";
  if (looksLikeInternals(v)) return "";
  return v;
}

export function humanHttpMessage(status: number, body: string): string {
  const t = (body ?? "").trim();
  if (t && (t.startsWith("{") || t.startsWith("["))) {
    try {
      const j = JSON.parse(t) as { error?: unknown; message?: unknown; detail?: unknown; reason?: unknown };
      if (typeof j?.error === "string" && isErrorCode(j.error.trim())) {
        const mapped = ERROR_CODE_MESSAGES[j.error.trim()];
        if (mapped) return mapped;
        const fallback = j?.message ?? j?.detail ?? j?.reason;
        if (typeof fallback === "string") {
          const safe = presentable(fallback);
          if (safe) return safe;
        }
      } else {
        const m = j?.error ?? j?.message ?? j?.detail ?? j?.reason;
        if (typeof m === "string") {
          const safe = presentable(m);
          if (safe) return safe;
        }
      }
    } catch { }
  } else if (t && t.length <= 200 && !t.startsWith("<") && !/^\d+\s*:/.test(t)) {
    const safe = presentable(t);
    if (safe) return safe;
  }
  switch (status) {
    case 400: return "Something in that request wasn't right. Please check and try again.";
    case 401: return "Your session has expired. Please sign in again.";
    case 403: return "You don't have permission to do that.";
    case 404: return "We couldn't find what you were looking for.";
    case 409: return "That conflicts with existing data. Please refresh and try again.";
    case 413: return "That file is too large.";
    case 422: return "Some details couldn't be saved. Please check them and try again.";
    case 429: return "Too many attempts. Please wait a moment and try again.";
    case 503: return "The service is briefly unavailable. Please try again in a moment.";
    default:
      return status >= 500
        ? "Something went wrong on our end. Please try again."
        : "Something went wrong. Please try again.";
  }
}

class HttpError extends Error {
  readonly isHttp = true;
  readonly rawBody: string;
  constructor(
    public readonly status: number,
    body: string,
    public readonly requestId?: string,
  ) {
    super(humanHttpMessage(status, body));
    this.rawBody = body;
  }
}

const UPLOAD_TIMEOUT_MS = 120_000;
const BINARY_GET_TIMEOUT_MS = 60_000;

function binarySignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

async function binaryFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const caller = init.signal;
  try {
    return await correlatedFetch(url, {
      ...init,
      signal: caller ?? binarySignal(timeoutMs),
    });
  } catch (e) {
    const requestId = requestIdFromError(e);
    if (!caller && e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw correlateError(
        new Error("The server took too long to respond. Please check your connection and try again."),
        requestId,
      );
    }
    throw correlateError(e, requestId);
  }
}

const GET_TIMEOUT_MS = 27_000;
/* Mutations used to be left UNCAPPED — a hung save spun forever and the
   operator walked away believing it had gone through ("人家以为做成功了，然后
   才发现没有" — owner, 2026-07-19). A save must fail LOUDLY, never quietly, so
   a mutation now gets its own deadline and a plain-language failure.
   Deliberately higher than the GET cap: a save legitimately does more work
   (document-number mint, line writes, stock moves) and must not be aborted
   while it is still making progress. This is safe to add ONLY because the
   idempotency middleware landed first — see the message split in request(),
   which is where the abort-a-committed-write hazard is actually handled. */
const MUTATION_TIMEOUT_MS = 45_000;
const GET_RETRIES = 4;
const COLD_POOL_RETRIES = 4;
const isColdPool503 = (e: HttpError) =>
  e.status === 503 &&
  /briefly unavailable|warming up|try again in a moment/i.test(String(e.message || ""));

async function handleResponse<T>(
  res: Response,
  path: string,
  method = "GET",
  sentToken = "",
): Promise<T> {
  if (res.status === 401) {
    const isAuthProbe =
      path.startsWith("/api/auth/me") ||
      path.startsWith("/api/auth/login") ||
      path.startsWith("/api/auth/bootstrap") ||
      path.startsWith("/api/auth/accept-invite") ||
      path.startsWith("/api/auth/status");
    // A 401 may end the session ONLY when the failing request actually carried
    // the CURRENT token. Two other shapes reached here and both nuked live
    // logins (owner lockout, 2026-07-22):
    //   1. Tokenless pre-auth queries — the login screen legitimately fires
    //      /api/branding (useBranding falls back to host defaults on 401); its
    //      rejection says nothing about any session.
    //   2. Stale in-flight requests — a 401 minted against the PREVIOUS token
    //      landing just after a fresh login must not clear the NEW token. With
    //      a pre-auth 401 loop in flight, that race killed every sign-in
    //      within milliseconds, which presented as "login succeeds, app never
    //      enters" while sessions piled up server-side.
    const invalidatesCurrentSession =
      sentToken !== "" && sentToken === tokenStore.get();
    if (!isAuthProbe && invalidatesCurrentSession) {
      for (const fn of unauthorizedListeners) fn();
    }
  }
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {}
    if (res.status === 403) {
      const msg = extractErrorMessage(body) || "You don't have permission to do that";
      if (method !== "GET") {
        for (const fn of forbiddenListeners) fn(msg);
      } else if (import.meta.env?.DEV) {
        console.warn(`[403 suppressed] GET ${path} — gate this query's enabled: ${msg}`);
      }
      emitTelemetry({ kind: "forbidden", method, path });
    }
    if (res.status >= 500) {
      emitTelemetry({ kind: "server-error", method, path, status: res.status });
    }
    throw new HttpError(
      res.status,
      body || res.statusText,
      requestIdFromResponse(res),
    );
  }
  if (res.status === 204) return undefined as T;
  return consumeCorrelated(res, () => res.json() as Promise<T>);
}

const SLOW_FETCH_MS = 800;

const IN_FLIGHT_POLL_MS = 1000;
const IN_FLIGHT_MAX_WAIT_MS = 60_000;

let lastHiddenAt = Number.NEGATIVE_INFINITY;
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") lastHiddenAt = performance.now();
  });
}

/** True when the tab has been visible the whole time since `startedAt` (performance.now()). */
export function visibleThroughout(startedAt: number): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  return lastHiddenAt < startedAt;
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = tokenStore.get();
  const method = (opts?.method || "GET").toUpperCase();
  const retries = method === "GET" ? GET_RETRIES : 0;
  const isGet = method === "GET";
  const hasIdemKey = new Headers(opts?.headers).has("Idempotency-Key");
  let inFlightWaited = 0;

  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(),
      isGet ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS,
    );
    const startedAt = performance.now();
    try {
      const headers = new Headers({
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...passHeader(),
        "Content-Type": "application/json",
        ...companyHeader(),
      });
      new Headers(opts?.headers).forEach((value, key) => headers.set(key, value));
      const res = await correlatedFetch(`${baseUrl}${path}`, {
        ...opts,
        signal: combineAbortSignals(opts?.signal, ctrl.signal),
        headers,
      });
      const ms = Math.round(performance.now() - startedAt);
      const responseId = requestIdFromResponse(res);
      if (ms >= SLOW_FETCH_MS && visibleThroughout(startedAt)) {
        console.warn(`[perf] slow ${method} ${path} - ${ms}ms id=${responseId}`);
        emitTelemetry({ kind: "slow", method, path, ms });
      }
      return await handleResponse<T>(res, path, method, token);
    } catch (e) {
      const requestId = requestIdFromError(e);
      if (opts?.signal?.aborted) throw abortReason(opts.signal);
      if (e instanceof HttpError) {
        if (e.status === 409 && hasIdemKey && inFlightWaited < IN_FLIGHT_MAX_WAIT_MS && e.rawBody.includes('"idempotency_in_flight"')) {
          await abortableDelay(IN_FLIGHT_POLL_MS, opts?.signal);
          inFlightWaited += IN_FLIGHT_POLL_MS;
          attempt--;
          continue;
        }
        if (e.status === 503 && method === "GET" && attempt < retries) {
          await abortableDelay(600 + attempt * 1200, opts?.signal);
          continue;
        }
        if (isColdPool503(e) && method !== "GET" && attempt < COLD_POOL_RETRIES) {
          await abortableDelay(600 + attempt * 1200, opts?.signal);
          continue;
        }
        throw e;
      }
      if (attempt < retries) {
        await abortableDelay(600 + attempt * 1200, opts?.signal);
        continue;
      }
      if (!isGet) {
        throw correlateError(
          new Error(
            hasIdemKey
              ? "That took too long, so we couldn't confirm whether it saved. Please retry this same action once; its safety key will check the original request instead of creating a duplicate."
              : "That took too long and we couldn't confirm whether it saved. Please refresh and check before trying again — saving twice may create a duplicate.",
          ),
          requestId,
        );
      }
      throw correlateError(
        new Error("Network error — the server took too long to respond. Please try again."),
        requestId,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function cachedGet<T>(path: string): Promise<T> {
  if (!cacheable(path)) return request<T>(path);
  const key = `${path}#co=${getActiveCompanyId() ?? ""}`;
  const hit = getCached<T>(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const joined = getInflight<T>(key);
  if (joined) return joined;
  const startedEpoch = currentEpoch();
  const p = request<T>(path).then((data) => {
    if (data !== undefined && !invalidatedSince(path, startedEpoch)) setCached(key, data);
    return data;
  });
  setInflight(key, p);
  return p;
}

function mutate<T>(path: string, opts: RequestInit): Promise<T> {
  return request<T>(path, opts).then((r) => {
    invalidateForMutation(path);
    return r;
  });
}

/** Per-call mutation options. `idempotencyKey` opts this write into the backend
 *  idempotency middleware, so a retry replays the first response instead of
 *  creating a second document. Mint it with newIdempotencyKey/useIdempotencyKey
 *  from lib/idempotency — read that module's rules first: a key minted per
 *  CLICK is a fix that does nothing, and a key derived from the PAYLOAD is a fix
 *  that loses money. */
export type MutateOpts = { idempotencyKey?: string };

const idemHeader = (o?: MutateOpts) =>
  o?.idempotencyKey ? { "Idempotency-Key": o.idempotencyKey } : undefined;

export const api = {
  baseUrl,
  get: <T>(p: string, init?: { signal?: AbortSignal }) =>
    init?.signal ? request<T>(p, init) : cachedGet<T>(p),
  post: <T>(p: string, b?: any, o?: MutateOpts) =>
    mutate<T>(p, {
      method: "POST",
      body: b ? JSON.stringify(b) : undefined,
      headers: idemHeader(o),
    }),
  patch: <T>(p: string, b: any, o?: MutateOpts) =>
    mutate<T>(p, { method: "PATCH", body: JSON.stringify(b), headers: idemHeader(o) }),
  put: <T>(p: string, b: any, o?: MutateOpts) =>
    mutate<T>(p, { method: "PUT", body: JSON.stringify(b), headers: idemHeader(o) }),
  del: <T>(p: string, o?: MutateOpts) =>
    mutate<T>(p, { method: "DELETE", headers: idemHeader(o) }),

  async putBinary<T>(path: string, body: Blob | ArrayBuffer, contentType: string): Promise<T> {
    const token = tokenStore.get();
    const res = await binaryFetch(`${baseUrl}${path}`, {
      method: "PUT",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...passHeader(),
        "Content-Type": contentType,
        ...companyHeader(),
      },
      body,
    }, UPLOAD_TIMEOUT_MS);
    if (!res.ok) {
      let txt = "";
      try {
        txt = await res.text();
      } catch {}
      throw new HttpError(res.status, txt || res.statusText, requestIdFromResponse(res));
    }
    invalidateForMutation(path);
    return consumeCorrelated(res, () => res.json() as Promise<T>);
  },

  async postBinary<T>(path: string, body: Blob | ArrayBuffer, contentType: string): Promise<T> {
    const token = tokenStore.get();
    const res = await binaryFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...passHeader(),
        "Content-Type": contentType,
        ...companyHeader(),
      },
      body,
    }, UPLOAD_TIMEOUT_MS);
    if (!res.ok) {
      let txt = "";
      try {
        txt = await res.text();
      } catch {}
      throw new HttpError(res.status, txt || res.statusText, requestIdFromResponse(res));
    }
    invalidateForMutation(path);
    return consumeCorrelated(res, () => res.json() as Promise<T>);
  },

  async uploadFiles<T>(path: string, files: File[], fieldName = "files"): Promise<T> {
    const token = tokenStore.get();
    const form = new FormData();
    for (const f of files) form.append(fieldName, f);
    const res = await binaryFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...passHeader(), ...companyHeader() },
      body: form,
    }, UPLOAD_TIMEOUT_MS);
    if (!res.ok) {
      let txt = "";
      try {
        txt = await res.text();
      } catch {}
      throw new HttpError(res.status, txt || res.statusText, requestIdFromResponse(res));
    }
    invalidateForMutation(path);
    if (res.status === 204) return undefined as T;
    return consumeCorrelated(res, () => res.json() as Promise<T>);
  },

  uploadFile<T>(path: string, file: File, fieldName = "file"): Promise<T> {
    return this.uploadFiles<T>(path, [file], fieldName);
  },

  async postForm<T>(path: string, form: FormData): Promise<T> {
    const token = tokenStore.get();
    const res = await binaryFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...passHeader(), ...companyHeader() },
      body: form,
    }, UPLOAD_TIMEOUT_MS);
    if (!res.ok) {
      let txt = "";
      try {
        txt = await res.text();
      } catch {}
      throw new HttpError(res.status, txt || res.statusText, requestIdFromResponse(res));
    }
    invalidateForMutation(path);
    if (res.status === 204) return undefined as T;
    return consumeCorrelated(res, () => res.json() as Promise<T>);
  },

  /**
   * Fetches a protected asset (e.g. R2-backed POD photo) as a Blob — the bytes
   * themselves, for a caller that sends them on (a PMS row's bill becoming a
   * payment request's, owner 2026-10-08).
   */
  async fetchBlob(path: string, typeHint?: string | null): Promise<Blob> {
    const token = tokenStore.get();
    const res = await binaryFetch(`${baseUrl}${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...passHeader(), ...companyHeader() },
    }, BINARY_GET_TIMEOUT_MS);
    if (!res.ok) throw new HttpError(res.status, res.statusText, requestIdFromResponse(res));
    return consumeCorrelated(res, async () => {
      const blob = await res.blob();
      return typeHint && (!blob.type || blob.type === "application/octet-stream")
        ? blob.slice(0, blob.size, typeHint)
        : blob;
    });
  },

  async fetchBlobWithTime(path: string): Promise<{ blob: Blob; storedAt: string | null }> {
    const token = tokenStore.get();
    const res = await binaryFetch(`${baseUrl}${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...passHeader(), ...companyHeader() },
    }, BINARY_GET_TIMEOUT_MS);
    if (!res.ok) throw new HttpError(res.status, res.statusText, requestIdFromResponse(res));
    return consumeCorrelated(res, async () => ({ blob: await res.blob(), storedAt: res.headers.get("Last-Modified") }));
  },

  async fetchBlobUrl(path: string, typeHint?: string | null): Promise<string> {
    return URL.createObjectURL(await api.fetchBlob(path, typeHint));
  },

  async downloadFile(path: string, fallbackName = "download"): Promise<void> {
    const token = tokenStore.get();
    const res = await binaryFetch(`${baseUrl}${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...passHeader(), ...companyHeader() },
    }, BINARY_GET_TIMEOUT_MS);
    if (!res.ok) throw new HttpError(res.status, res.statusText, requestIdFromResponse(res));
    await consumeCorrelated(res, async () => {
      const cd = res.headers.get("Content-Disposition") || "";
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      const name = m ? decodeURIComponent(m[1]) : fallbackName;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });
  },

  async getHtml(path: string): Promise<string> {
    const token = tokenStore.get();
    const res = await binaryFetch(`${baseUrl}${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...passHeader(), ...companyHeader() },
    }, BINARY_GET_TIMEOUT_MS);
    if (!res.ok) throw new HttpError(res.status, res.statusText, requestIdFromResponse(res));
    let html = "";
    await consumeCorrelated(res, async () => {
      html = await res.text();
    });
    return html;
  },

  async openHtml(path: string): Promise<void> {
    await openLoadedTab(async () => {
      const html = await api.getHtml(path);
      return URL.createObjectURL(new Blob([html], { type: "text/html" }));
    }, 60_000);
  },
};

export function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}
