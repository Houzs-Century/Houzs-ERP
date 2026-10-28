// One request-correlation contract for every browser transport. Each physical
// attempt gets a fresh 128-bit id (so retries remain individually traceable),
// while errors prefer the server's safe echoed id and fall back to the exact id
// sent for that attempt.

import { absorbSessionPass } from "./authToken";

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;

const responseClientIds = new WeakMap<Response, string>();
const errorRequestIds = new WeakMap<object, string>();

export function normalizeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return SAFE_REQUEST_ID.test(normalized) ? normalized : undefined;
}

export function createRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function requestIdFromError(error: unknown): string | undefined {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return undefined;
  let attached: unknown;
  try {
    attached = (error as { requestId?: unknown }).requestId;
  } catch {
    // A hostile/frozen browser error may expose a throwing getter. The WeakMap
    // fallback below still preserves its identity and instanceof semantics.
  }
  // A WeakMap entry is written by correlateError for the physical attempt we
  // are currently handling. It must outrank an older public property: frozen
  // and non-writable Error objects can carry a valid stale requestId that the
  // assignment below cannot replace.
  return errorRequestIds.get(error) ?? normalizeRequestId(attached);
}

/**
 * Anything shaped like an error, which is NOT the same question as
 * `instanceof Error`.
 *
 * A DOMException inherits from Error in every current browser, but NOT in
 * jsdom 25 (webidl2js builds it as a standalone class). An `instanceof Error`
 * guard therefore flattens `DOMException("Aborted", "AbortError")` into
 * `new Error("AbortError: Aborted")` under test — the name is destroyed, and
 * every caller that distinguishes a caller-initiated abort from a network
 * failure by `e.name === "AbortError"` reads a superseded typeahead request as
 * a real failure to retry and report. The behaviour differs between the test
 * environment and the browser, which is the worst of both: the browser is fine
 * and the suite cannot say so. Preserve identity for anything carrying a
 * string name + message, which is exactly what the WeakMap path below exists
 * for ("unlike wrapping, it preserves object identity, name, cause and
 * instanceof").
 */
function isErrorLike(value: unknown): value is Error {
  if (value instanceof Error) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; message?: unknown };
  return typeof candidate.name === "string" && typeof candidate.message === "string";
}

export function correlateError(error: unknown, requestId: unknown): Error {
  const correlated = isErrorLike(error) ? error : new Error(String(error));
  // The caller supplies the id of the physical attempt/response it is handling;
  // that is more authoritative than a stale but syntactically-valid property a
  // third-party error object may already carry.
  const id = normalizeRequestId(requestId) ?? requestIdFromError(correlated);
  if (!id) return correlated;

  // WeakMap is the compatibility path for frozen DOMException/Error objects:
  // unlike wrapping, it preserves object identity, name, cause and instanceof.
  errorRequestIds.set(correlated, id);
  try {
    (correlated as Error & { requestId?: string }).requestId = id;
  } catch {
    // Frozen/non-extensible error. requestIdFromError still resolves WeakMap.
  }
  return correlated;
}

/** Fetch one physical attempt. Call it again for a retry to mint a fresh id. */
export async function correlatedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const clientRequestId = createRequestId();
  const headers = new Headers(init.headers);
  headers.set("X-Request-Id", clientRequestId);
  try {
    const response = await fetch(input, { ...init, headers });
    responseClientIds.set(response, clientRequestId);
    /* Every authenticated call in the app funnels through here, which is why the
       renewal is absorbed at this level rather than per call site — one missed
       site is a user who silently never renews. */
    absorbSessionPass(response);
    return response;
  } catch (error) {
    throw correlateError(error, clientRequestId);
  }
}

export function requestIdFromResponse(response: Response): string | undefined {
  return normalizeRequestId(response.headers.get("X-Request-Id"))
    ?? responseClientIds.get(response);
}

export function correlateResponseError(error: unknown, response: Response): Error {
  return correlateError(error, requestIdFromResponse(response));
}

/** Preserve response correlation for JSON/blob/text/decode failures after 2xx. */
export async function consumeCorrelated<T>(response: Response, consume: () => T | Promise<T>): Promise<T> {
  try {
    return await consume();
  } catch (error) {
    throw correlateResponseError(error, response);
  }
}
