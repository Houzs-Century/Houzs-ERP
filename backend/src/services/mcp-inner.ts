export const MCP_INNER_HEADER = "x-houzs-mcp-inner";

let secret: string | null = null;
export function mcpInnerSecret(): string {
  if (!secret) {
    const a = new Uint8Array(32);
    crypto.getRandomValues(a);
    secret = Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return secret;
}

export function isMcpInner(value: string | undefined): boolean {
  if (!value || !secret || value.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < value.length; i++) diff |= value.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export const VERIFIED_TTL_MS = 15_000;
const verified = new Map<string, { id: unknown; exp: number }>();

export function rememberVerified(token: string, id: unknown, now: number): void {
  if (verified.size > 500) {
    for (const [k, v] of verified) if (v.exp <= now) verified.delete(k);
  }
  verified.set(token, { id, exp: now + VERIFIED_TTL_MS });
}

export function recallVerified<T>(token: string, now: number): T | null {
  const e = verified.get(token);
  if (!e) return null;
  if (e.exp <= now) {
    verified.delete(token);
    return null;
  }
  return e.id as T;
}

export const MCP_ACTION_HEADER = "x-houzs-mcp-action";

export const ACTION_ALLOWLIST: readonly { kind: string; method: string; path: string }[] = [
  { kind: "meeting", method: "POST", path: "/api/meetings/meetings" },
  { kind: "email", method: "POST", path: "/api/mail-center/compose" },
];

export const ARMED_TTL_MS = 30_000;
const armed = new Map<string, { kind: string; tokenId: string; exp: number }>();

/** confirm_action, after claiming the row: open the door for exactly one call. */
export function armAction(actionId: string, kind: string, tokenId: string, now: number): void {
  for (const [k, v] of armed) if (v.exp <= now) armed.delete(k);
  armed.set(actionId, { kind, tokenId, exp: now + ARMED_TTL_MS });
}

/** Drop an armed action that was never used (the inner call failed before auth). */
export function disarmAction(actionId: string): void {
  armed.delete(actionId);
}

/** middleware/auth.ts: may this non-GET MCP request through? Single use: a match is consumed. */
export function admitMcpWrite(a: { method: string; path: string; actionId: string | undefined; tokenId: string; now: number }): boolean {
  if (!a.actionId) return false;
  const e = armed.get(a.actionId);
  if (!e) return false;
  armed.delete(a.actionId);
  if (e.exp <= a.now || e.tokenId !== a.tokenId) return false;
  const p = a.path.replace(/\/+$/, "");
  return ACTION_ALLOWLIST.some((r) => r.kind === e.kind && r.method === a.method.toUpperCase() && r.path === p);
}

/** The allowlisted route for an action kind (confirm_action calls exactly this). */
export function actionRoute(kind: string): { method: string; path: string } | null {
  const r = ACTION_ALLOWLIST.find((x) => x.kind === kind);
  return r ? { method: r.method, path: r.path } : null;
}
