// ---------------------------------------------------------------------------
// Mail Center — a typed recipient FIELD → a clean list of addresses.
//
// Shared by desktop Compose.tsx and the phone's MobileMailCenter.tsx so To, Cc
// and Bcc are parsed and validated identically on both. The backend normalises
// again in `recipientList()` (backend/src/services/email.ts) — this is for the
// inline validation the operator sees, NOT a trust boundary.
// ---------------------------------------------------------------------------

// Conservative single-@ shape check — mirrors the backend's EMAIL_RE.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Comma or semicolon separated, trimmed, de-duplicated case-insensitively —
   the same split the backend performs. */
export function parseRecipients(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;]/)) {
    const addr = part.trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

// The first entry in the field that is not a valid address, or null. Returning
// the ADDRESS rather than a boolean is deliberate: "a valid recipient is
// required" over a five-address field names nothing the operator can fix.
export function firstInvalid(raw: string): string | null {
  return parseRecipients(raw).find((a) => !EMAIL_RE.test(a)) ?? null;
}
