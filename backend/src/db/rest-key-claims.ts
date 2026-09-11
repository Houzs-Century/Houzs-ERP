/* What the configured PostgREST key IS, read off the key itself — so /health can
   say it and a rehearsal can refuse a mis-set secret instead of chasing it for
   three weeks.

   WHY. On staging the Worker's SUPABASE_SERVICE_ROLE_KEY held a key whose JWT
   `role` claim was not `service_role`. PostgREST then ran every request as that
   role: the base tables answered (that role could read them), the Sales Orders
   VIEW refused ("permission denied for view mfg_sales_orders_with_payment_totals"),
   and every catalog check said service_role was fine — because it was. The
   read-only probe that settled it is run 34644526231; docs/bugs/0824.

   A Supabase key is a JWT. Its payload is base64url JSON carrying `role` and
   `ref` (the project). Nothing here verifies the signature or exposes the key:
   the two claims are the only output, and both are public facts about the
   project (`ref` is in every REST URL). */

export type RestKeyClaims = {
  /** `service_role`, `anon`, `authenticated`, … or null when the key is not a readable JWT. */
  role: string | null;
  /** Supabase project ref the key was minted for, or null. */
  ref: string | null;
};

const b64urlToJson = (segment: string): Record<string, unknown> | null => {
  try {
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const text = atob(padded);
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export function restKeyClaims(key: string | null | undefined): RestKeyClaims {
  if (!key) return { role: null, ref: null };
  const parts = key.split(".");
  if (parts.length !== 3) return { role: null, ref: null };
  const payload = b64urlToJson(parts[1]);
  if (!payload) return { role: null, ref: null };
  const role = typeof payload.role === "string" ? payload.role : null;
  const ref = typeof payload.ref === "string" ? payload.ref : null;
  return { role, ref };
}

/** Project ref from a `https://<ref>.supabase.co` URL, or null. */
export function restUrlRef(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.(co|in)\b/i.exec(url);
  return m ? m[1] : null;
}
