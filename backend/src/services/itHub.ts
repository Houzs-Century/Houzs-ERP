import type { Env } from "../types";

// Where this system's reports to the Houzs IT Hub go, and with which key.
//
// IT_HUB_URL is the hub's origin. Each company has its own hub key in the secret
// IT_HUB_API_KEY_<company code>. A report that covers the whole system (AI usage,
// health) goes out with ONE company's key, named by IT_HUB_AI_USAGE_COMPANY: the
// company whose Anthropic workspace this system's key belongs to. Unset address,
// company or key => null, and the caller sends nothing.

const COMPANY_CODE = /^[A-Z0-9]{2,12}$/;

export function hubTarget(env: Env): { base: string; key: string } | null {
  const base = (env.IT_HUB_URL ?? "").trim().replace(/\/+$/, "");
  const company = (env.IT_HUB_AI_USAGE_COMPANY ?? "").trim().toUpperCase();
  const secret = COMPANY_CODE.test(company) ? (env as unknown as Record<string, unknown>)[`IT_HUB_API_KEY_${company}`] : undefined;
  const key = typeof secret === "string" ? secret.trim() : "";
  return base && key ? { base, key } : null;
}
