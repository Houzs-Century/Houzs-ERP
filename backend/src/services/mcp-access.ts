
/** Never readable through the connector, whatever the person's role. */
export const MCP_BLOCKED_PREFIXES = [
  "/api/auth",
  "/api/totp",
  "/api/field-pin",
  "/api/push",
  "/api/mcp",
  "/api/mcp-admin",
  "/api/mail-center",
  "/api/mail-personal",
  "/api/mail-access-log",
  "/api/mail-acks",
  "/api/mail-claim",
  "/api/inbox",
  "/api/sync",
  "/api/client-errors",
  "/api/chat-callback",
  "/api/agent-console",
  "/api/assistant",
  "/api/pos-device",
  "/api/survey",
  "/api/track",
  "/api/portal",
  "/api/supplier-portal",
  "/api/public",
  "/api/assr-form-intake",
  "/api/delivery-sheet",
];

export type PathDecision = { ok: true; path: string } | { ok: false; reason: string };

/** Normalise and gate one endpoint path (no query string). */
export function classifyPath(raw: string): PathDecision {
  const p = raw.trim().split("?")[0].split("#")[0];
  if (!p.startsWith("/api/")) return { ok: false, reason: "Paths start with /api/ — use list_modules / list_endpoints to find one." };
  if (p.length > 300 || /\.\.|\/\/|%2e|%2f|\\/i.test(p)) return { ok: false, reason: "Invalid path." };
  if (MCP_BLOCKED_PREFIXES.some((b) => p === b || p.startsWith(b + "/"))) {
    return { ok: false, reason: "That part of the ERP is not available through the AI connector (sign-in, private mail and system sync are never shared)." };
  }
  return { ok: true, path: p.replace(/\/+$/, "") || p };
}

/** Field names removed from every reply: credentials and secrets, never needed to answer a question. */
export const SECRET_KEY = /(password|passwd|secret|token|api_?key|pin_hash|pin_code|totp|otp_|session_pass|private_key|signing_key|r2_key|webhook)/i;

/** Strip credential-shaped fields (any depth). Returns the cleaned value and the names removed. */
export function redactSecrets(v: unknown): { value: unknown; removed: Set<string> } {
  const removed = new Set<string>();
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > 40) return null;
    if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1));
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
        if (SECRET_KEY.test(k)) {
          removed.add(k);
          continue;
        }
        out[k] = walk(val, depth + 1);
      }
      return out;
    }
    return x;
  };
  return { value: walk(v, 0), removed };
}

export const PROFIT_KEY = /(margin|profit|gross_?pct|gp_?pct|markup)/i;
export const PRODUCT_COST_KEY = /(unit_?cost|cost_?price|landed_?cost|avg_?cost|average_?cost|cost_?per_?unit)/i;
export const ANY_COST_KEY = /cost/i;

export type MoneySight = { finance: boolean; productCost: boolean };

/** Which money keys this person may NOT see: profit / cost families by cohort. */
export function moneyKeyHidden(key: string, sight: MoneySight): boolean {
  if (PROFIT_KEY.test(key)) return !sight.finance;
  if (PRODUCT_COST_KEY.test(key)) return !(sight.productCost || sight.finance);
  if (ANY_COST_KEY.test(key)) return !sight.finance;
  return false;
}

/** Strip the money keys this person may not see (any depth). */
export function redactMoney(v: unknown, sight: MoneySight): { value: unknown; removed: Set<string> } {
  const removed = new Set<string>();
  if (sight.finance && sight.productCost) return { value: v, removed };
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > 40) return null;
    if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1));
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
        if (moneyKeyHidden(k, sight)) {
          removed.add(k);
          continue;
        }
        out[k] = walk(val, depth + 1);
      }
      return out;
    }
    return x;
  };
  return { value: walk(v, 0), removed };
}

/** Money / people field names — the leak check reports where these reach a staff account. */
export const SENSITIVE_KEY = /(cost|salary|wage|payroll|margin|profit|commission|ic_?no|nric|bank_?acc|basic_pay|allowance|epf|socso)/i;

export type RouteInfo = { method: string; path: string };

/** Readable GET endpoints (no wildcards, not blocked), sorted. */
export function readablePaths(routes: RouteInfo[], prefix: string | null): string[] {
  const set = new Set<string>();
  for (const r of routes) {
    if (r.method !== "GET") continue;
    if (!r.path.startsWith("/api/") || r.path.includes("*")) continue;
    if (prefix && !(r.path === prefix || r.path.startsWith(prefix + "/"))) continue;
    if (!classifyPath(r.path.replace(/:[^/]+/g, "x")).ok) continue;
    set.add(r.path);
  }
  return [...set].sort();
}

/** One module per first path segment (/api/scm/* split one level deeper, it is most of the ERP). */
export function moduleCatalog(routes: RouteInfo[]): { prefix: string; endpoints: number }[] {
  const counts = new Map<string, number>();
  for (const p of readablePaths(routes, null)) {
    const seg = p.split("/").filter(Boolean);
    const prefix = seg[1] === "scm" && seg[2] && !seg[2].startsWith(":") ? `/api/scm/${seg[2]}` : `/api/${seg[1]}`;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()].map(([prefix, endpoints]) => ({ prefix, endpoints })).sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/** List endpoints worth probing in the leak check: parameter-free GETs. */
export function leakCheckPaths(routes: RouteInfo[]): string[] {
  return readablePaths(routes, null).filter((p) => !p.includes(":"));
}

/** Collect every key name in a JSON value (any depth, capped). */
export function jsonKeys(v: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 12 || out.size > 2000) return out;
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 20)) jsonKeys(x, out, depth + 1);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out.add(k);
      jsonKeys(x, out, depth + 1);
    }
  }
  return out;
}
