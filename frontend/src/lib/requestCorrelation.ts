
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
  }
  return errorRequestIds.get(error) ?? normalizeRequestId(attached);
}

function isErrorLike(value: unknown): value is Error {
  if (value instanceof Error) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; message?: unknown };
  return typeof candidate.name === "string" && typeof candidate.message === "string";
}

export function correlateError(error: unknown, requestId: unknown): Error {
  const correlated = isErrorLike(error) ? error : new Error(String(error));
  const id = normalizeRequestId(requestId) ?? requestIdFromError(correlated);
  if (!id) return correlated;

  errorRequestIds.set(correlated, id);
  try {
    (correlated as Error & { requestId?: string }).requestId = id;
  } catch {
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
