import { Browser, BrowserContext, Page, APIRequestContext, expect, request } from "@playwright/test";

// ──────────────────────────────────────────────────────────
// Env
// ──────────────────────────────────────────────────────────
export const CFG = {
  BASE_URL:  process.env.ERP_BASE_URL  || "http://localhost:5173",
  API_URL:   process.env.ERP_API_URL   || "https://autocount-sync-api.houzs-erp.workers.dev",
  STAFF_EMAIL:    process.env.STAFF_EMAIL    || "",
  STAFF_PASSWORD: process.env.STAFF_PASSWORD || "",
  SO_NO:    process.env.TEST_SO_NO    || "",
  SO_PHONE: process.env.TEST_SO_PHONE || "",
  SUPPLIER_NAME: process.env.TEST_SUPPLIER_NAME || "[E2E] Test Upholstery",
};

export function requireEnv() {
  const missing: string[] = [];
  if (!CFG.STAFF_EMAIL)    missing.push("STAFF_EMAIL");
  if (!CFG.STAFF_PASSWORD) missing.push("STAFF_PASSWORD");
  if (!CFG.SO_NO)          missing.push("TEST_SO_NO");
  if (!CFG.SO_PHONE)       missing.push("TEST_SO_PHONE");
  if (missing.length) {
    throw new Error(
      `Missing env vars: ${missing.join(", ")}. Copy tests/e2e/.env.example → tests/e2e/.env and fill them in.`
    );
  }
}

// ──────────────────────────────────────────────────────────
// Staff auth — API-first (skips login UI for speed/reliability)
// ──────────────────────────────────────────────────────────
export async function loginStaff(): Promise<string> {
  const ctx = await request.newContext({ baseURL: CFG.API_URL });
  const res = await ctx.post("/api/auth/login", {
    data: { email: CFG.STAFF_EMAIL, password: CFG.STAFF_PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(`Staff login failed: ${res.status()} ${await res.text()}`);
  }
  const { token } = await res.json();
  if (!token) throw new Error("No token in login response");
  await ctx.dispose();
  return token;
}

/**
 * Mount a staff session on a browser context by injecting the bearer
 * token into localStorage before any page is loaded. Matches the
 * frontend's tokenStore key ("auth:token").
 */
export async function attachStaffAuth(context: BrowserContext, token: string) {
  await context.addInitScript((t) => {
    localStorage.setItem("auth:token", t);
  }, token);
}

// ──────────────────────────────────────────────────────────
// Raw API helpers — used by test to read server state quickly
// ──────────────────────────────────────────────────────────
export function apiFor(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: CFG.API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

export async function apiJson<T = any>(
  ctx: APIRequestContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: any
): Promise<T> {
  const opts: any = { data: body };
  const res = await (method === "GET"   ? ctx.get(path)
                   : method === "POST"  ? ctx.post(path, opts)
                   : method === "PATCH" ? ctx.patch(path, opts)
                   :                      ctx.delete(path));
  if (!res.ok()) {
    throw new Error(`${method} ${path} → ${res.status()}: ${await res.text()}`);
  }
  if (res.status() === 204) return undefined as T;
  return (await res.json()) as T;
}

// ──────────────────────────────────────────────────────────
// Tiny JPEG generator — avoid checking binary fixtures into git
// Returns a valid ~1KB JPEG of the requested solid colour.
// ──────────────────────────────────────────────────────────
export function tinyJpeg(hueLabel: "red" | "green" | "blue" = "red"): Buffer {
  // A precomputed minimal JPEG per hue. Each is a 1×1 image, different colour
  // so staff and customer attachments are visually distinguishable in traces.
  // Source: hand-encoded minimal JFIFs, 64 bytes each after base64 decode.
  const JPEGS: Record<string, string> = {
    red:
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////8AAB/9sAQwH/////////////////////////////////////////////////////////////////////////////////////8AAEQgAAQABAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAL/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA//9k=",
    green:
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////8AAB/9sAQwH/////////////////////////////////////////////////////////////////////////////////////8AAEQgAAQABAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAL/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxAB//2Q==",
    blue:
      "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////8AAB/9sAQwH/////////////////////////////////////////////////////////////////////////////////////8AAEQgAAQABAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAL/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxAC//9k=",
  };
  return Buffer.from(JPEGS[hueLabel] ?? JPEGS.red, "base64");
}

// ──────────────────────────────────────────────────────────
// UI waits
// ──────────────────────────────────────────────────────────
export async function waitForText(page: Page, text: string, timeout = 15_000) {
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout });
}

export async function reloadAndSettle(page: Page) {
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForLoadState("networkidle");
}
