/* The POS's two ways of talking to the ERP:
 *  - as an ADMIN during Device setup (ERP email + password → a staff session
 *    carried as a Bearer token, used only for /api/pos-admin/* and dropped
 *    when setup closes), and
 *  - as the DEVICE itself afterwards (X-POS-Device token minted at Prepare),
 *    for /api/pos-device/*.
 * Every call has a timeout so a captive-portal hotspot cannot hang the app. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public body: unknown) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;

async function call<T>(path: string, init: RequestInit & { headers?: Record<string, string> }, timeoutMs = TIMEOUT_MS): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(path, { ...init, signal: ctl.signal, headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const msg = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? `${(body as { error: string }).error}${typeof (body as { reason?: unknown }).reason === "string" ? `: ${(body as { reason: string }).reason}` : ""}`
        : `HTTP ${res.status}`;
      throw new ApiError(res.status, msg, body);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

export const adminApi = {
  login: (email: string, password: string) =>
    call<{ token: string; user_id: number }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  get: <T>(token: string, path: string) => call<T>(path, { method: "GET", headers: { Authorization: `Bearer ${token}` } }),
  post: <T>(token: string, path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body), headers: { Authorization: `Bearer ${token}` } }),
  logout: (token: string) => call<unknown>("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
};

export const deviceApi = {
  ping: () => call<{ ok: boolean; at: string }>("/api/pos-device/ping", { method: "GET" }, 5000),
  prepare: <T>(token: string) => call<{ bundle: T }>("/api/pos-device/prepare", { method: "GET", headers: { "X-POS-Device": token } }, 60_000),
  heartbeat: (token: string, body: unknown) => call<{ ok: boolean; at: string; catalog_version: number | null }>("/api/pos-device/heartbeat", { method: "POST", body: JSON.stringify(body), headers: { "X-POS-Device": token } }, 10_000),
};

/** Online for real: `navigator.onLine` says the radio is up, the ping says
 *  the ERP answers (a hotel WiFi login page answers HTML, not our JSON). */
export async function erpReachable(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    const r = await deviceApi.ping();
    return r.ok === true;
  } catch {
    return false;
  }
}
