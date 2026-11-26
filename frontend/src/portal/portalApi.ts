import { humanHttpMessage } from "../api/client";
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromError,
  requestIdFromResponse,
} from "../lib/requestCorrelation";

const baseUrl =
  (import.meta.env.VITE_API_URL as string) ||
  (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");

function url(path: string): string {
  return path.startsWith("http") ? path : `${baseUrl}${path}`;
}

export class PortalApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const PORTAL_UPLOAD_TIMEOUT_MS = 120_000;
const PORTAL_TIMEOUT_MS = 60_000;

function portalSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

async function portalFetch(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await correlatedFetch(input, { ...init, signal: portalSignal(timeoutMs) });
  } catch (e) {
    const requestId = requestIdFromError(e);
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw correlateError(new PortalApiError(0, "The server took too long to respond. Please check your connection and try again."), requestId);
    }
    throw correlateError(new PortalApiError(0, "We couldn't reach the server. Please check your connection and try again."), requestId);
  }
}

async function req<T>(
  method: string,
  path: string,
  token: string | null,
  body?: any,
  isBinary = false
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (!isBinary && body !== undefined) headers["Content-Type"] = "application/json";
  const res = await portalFetch(url(path), {
    method,
    headers,
    body: isBinary ? (body as ArrayBuffer) : body !== undefined ? JSON.stringify(body) : undefined,
  }, isBinary ? PORTAL_UPLOAD_TIMEOUT_MS : PORTAL_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw correlateError(new PortalApiError(res.status, humanHttpMessage(res.status, text)), requestIdFromResponse(res));
  }
  if (res.status === 204) return undefined as T;
  return consumeCorrelated(res, () => res.json() as Promise<T>);
}

export const portalApi = {
  get:  <T>(path: string, token: string) => req<T>("GET", path, token),
  post: <T>(path: string, token: string | null, body?: any) => req<T>("POST", path, token, body),
  put:  <T>(path: string, token: string | null, body?: any) => req<T>("PUT", path, token, body),

  putBinary: async <T>(path: string, token: string, body: ArrayBuffer, contentType: string): Promise<T> => {
    const res = await portalFetch(url(path), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType,
      },
      body,
    }, PORTAL_UPLOAD_TIMEOUT_MS);
    if (!res.ok) throw correlateError(
      new PortalApiError(res.status, humanHttpMessage(res.status, await res.text().catch(() => ""))),
      requestIdFromResponse(res),
    );
    return consumeCorrelated(res, () => res.json() as Promise<T>);
  },

  async fetchBlobUrl(path: string, token: string): Promise<string> {
    const res = await portalFetch(url(path), { headers: { Authorization: `Bearer ${token}` } }, PORTAL_TIMEOUT_MS);
    if (!res.ok) throw correlateError(
      new PortalApiError(res.status, humanHttpMessage(res.status, "")),
      requestIdFromResponse(res),
    );
    return consumeCorrelated(res, async () => URL.createObjectURL(await res.blob()));
  },
};
