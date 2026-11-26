import type { Env } from "../types";


const COMPANY_CODE = /^[A-Z0-9]{2,12}$/;

export function hubTarget(env: Env): { base: string; key: string } | null {
  const base = (env.IT_HUB_URL ?? "").trim().replace(/\/+$/, "");
  const company = (env.IT_HUB_AI_USAGE_COMPANY ?? "").trim().toUpperCase();
  const secret = COMPANY_CODE.test(company) ? (env as unknown as Record<string, unknown>)[`IT_HUB_API_KEY_${company}`] : undefined;
  const key = typeof secret === "string" ? secret.trim() : "";
  return base && key ? { base, key } : null;
}
