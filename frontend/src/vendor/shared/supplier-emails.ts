// ----------------------------------------------------------------------------
// supplier-emails — a supplier's three email addresses (owner 2026-11-09:
// "supplier email needs email 2 and 3").
//
// ONE rule for every place that reads them, mirrored byte for byte at
// frontend/src/vendor/shared/supplier-emails.ts (supplier-emails.canonical.test.ts
// holds the two together): the supplier save validates them, the PO send picks
// To and Cc from them, and the documents show them as the supplier's contact.
// No imports, so both apps can carry the same file.
// ----------------------------------------------------------------------------

export interface SupplierEmails {
  email?: string | null;
  email2?: string | null;
  email3?: string | null;
}

/* One address, checked as a real address and not just "contains @": a supplier
   address is where a PO goes, and "a@b" or "a@b.com, c@d.com" is a send that
   fails at the provider. Permissive on the domain (no TLD list). */
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export function isValidEmailAddress(addr: string | null | undefined): boolean {
  return EMAIL_RE.test((addr ?? '').trim());
}

export type SupplierEmailCheck =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/** What the supplier save stores for one email field: trimmed; blank clears
 *  it (null); anything else must be one valid address. */
export function checkSupplierEmail(raw: unknown, label: string): SupplierEmailCheck {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const value = String(raw).trim();
  if (!value) return { ok: true, value: null };
  if (!isValidEmailAddress(value)) {
    return { ok: false, message: `${label} (${value}) is not a valid email address. Put one address per field.` };
  }
  return { ok: true, value };
}

const sameAddress = (a: string) => a.trim().toLowerCase();

/** Every address on file, in order (Email, Email 2, Email 3): trimmed, blanks
 *  dropped, a repeat (any case) shown once. For DISPLAY — an address that is
 *  not valid still shows, so the operator can see it and fix it. */
export function supplierEmailList(s: SupplierEmails | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [s?.email, s?.email2, s?.email3]) {
    const v = (raw ?? '').trim();
    if (!v || seen.has(sameAddress(v))) continue;
    seen.add(sameAddress(v));
    out.push(v);
  }
  return out;
}

export type PoRecipients =
  | { ok: true; to: string; cc: string[] }
  | { ok: false; error: 'no_supplier_email' }
  | { ok: false; error: 'bad_supplier_email'; address: string };

/** Who a PO email goes to. To = Email; Cc = Email 2 and Email 3 — only valid
 *  addresses, each once (any case). With Email blank, the first valid of
 *  Email 2 / Email 3 becomes To.
 *
 *  A main Email that is filled in but NOT valid refuses the send (bad address)
 *  rather than quietly moving the PO to Email 2: the main contact is the one
 *  the operator expects to receive it, and the refusal tells them to fix it.
 *  With nothing usable at all: no address on file, or the first bad one. */
export function resolvePoRecipients(s: SupplierEmails | null | undefined): PoRecipients {
  const main = (s?.email ?? '').trim();
  if (main && !isValidEmailAddress(main)) return { ok: false, error: 'bad_supplier_email', address: main };
  const usable: string[] = [];
  const seen = new Set<string>();
  let firstBad: string | null = null;
  for (const raw of [main, s?.email2, s?.email3]) {
    const v = (raw ?? '').trim();
    if (!v) continue;
    if (!isValidEmailAddress(v)) { firstBad = firstBad ?? v; continue; }
    if (seen.has(sameAddress(v))) continue;
    seen.add(sameAddress(v));
    usable.push(v);
  }
  if (usable.length === 0) {
    return firstBad ? { ok: false, error: 'bad_supplier_email', address: firstBad } : { ok: false, error: 'no_supplier_email' };
  }
  return { ok: true, to: usable[0], cc: usable.slice(1) };
}
