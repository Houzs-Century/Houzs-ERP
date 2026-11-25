// The AI Connector's in-process call marker (routes/mcp.ts -> middleware/auth.ts).
// An hzmcp_ token is honoured ONLY on a request carrying this header with this
// isolate's random secret — i.e. a call routes/mcp.ts made into the app itself.
// The secret never leaves the isolate, so a token copied out of an AI app cannot
// be used against /api/* directly.
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

// ── one token check per lookup ──────────────────────────────────────────────
// routes/mcp.ts verifies the token at the door (mcpIdentity: token not expired
// or revoked, account active, AI access on) and then makes one or more inner
// GETs for the same tool call. Those inner GETs reuse that answer for a few
// seconds instead of resolving the token again in middleware/auth.ts. Every new
// request from the AI app is still checked at the door, so Disconnect / Remove
// stop the NEXT request. Per isolate; never shared between isolates.
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
