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
