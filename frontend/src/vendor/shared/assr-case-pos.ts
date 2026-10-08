// ----------------------------------------------------------------------------
// assr-case-pos — the purchase-order numbers a service case shows, as ONE
// reader for the screens and the printed copies.
//
// WHY THIS FILE EXISTS. The list's "PO" column merged the SO's supplier "Order
// PO"s with the case's own service PO, but the printed Office / Supplier copy
// (routes/assr_print.ts) read `po_no` alone. A case created from an ERP sales
// order has `po_no` empty (the create path never fills it), so staff saw the PO
// on screen and a dash on paper (BUG-91, Farra 2026-10-08).
//
// The pair of paths is load-bearing: check-shared-mirrors.mjs compares
// backend/src/scm/shared and frontend/src/vendor/shared by basename. Keep the
// two files BYTE-IDENTICAL, no imports.
// ----------------------------------------------------------------------------

/**
 * "Order PO" — the supplier purchase orders raised from the case's SALES ORDER,
 * merged by the list and detail reads as `order_pos`
 * (backend/src/services/assrOrderPos.ts). It is NOT `po_no`: that is the
 * case's own service PO, which generate-po mints and costing reads.
 * Read-only, never stored.
 */
export type AssrOrderPo = { id: string; po_number: string };

export function assrOrderPos(row: unknown): AssrOrderPo[] {
  const r = (row ?? {}) as Record<string, unknown>;
  const raw = r.order_pos ?? r.orderPos;
  if (!Array.isArray(raw)) return [];
  const out: AssrOrderPo[] = [];
  for (const p of raw as Array<Record<string, unknown> | null>) {
    const id = p?.id;
    const num = p?.po_number ?? p?.poNumber;
    if (typeof id === "string" && id && typeof num === "string" && num) out.push({ id, po_number: num });
  }
  return out;
}

/** "PO1 · PO2", the same separator the DO No column uses; "" when none. */
export function assrOrderPoText(row: unknown): string {
  return assrOrderPos(row).map((p) => p.po_number).join(" · ");
}

/**
 * "PO" — the case's purchase-order references as ONE value: the SO's supplier
 * "Order PO"s (`order_pos`, read-only) first, then the case's own service PO
 * (`po_no`). Deduped so a service PO hand-typed as the order PO without its
 * company prefix (`HC-PO-009918` vs `PO-009918`) shows once, not twice.
 *
 * DISPLAY ONLY. The two are never merged in the data: generate-po refuses once
 * `po_no` is set and costing prices the repair from it. The detail screens
 * still show the two apart, because that is where the service PO is edited.
 */
export function assrMergedPos(row: unknown): AssrOrderPo[] {
  const out: AssrOrderPo[] = [];
  const seen = new Set<string>();
  const add = (id: string, po_number: string): void => {
    const key = canonicalPoNumber(po_number);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ id, po_number });
  };
  for (const p of assrOrderPos(row)) add(p.id, p.po_number);
  const r = (row ?? {}) as Record<string, unknown>;
  const poNo = r.po_no ?? r.poNo;
  if (typeof poNo === "string" && poNo.trim()) add("", poNo.trim());
  return out;
}

/** "PO1 · PO2", same separator as assrOrderPoText; "" when the case has none. */
export function assrMergedPoText(row: unknown): string {
  return assrMergedPos(row).map((p) => p.po_number).join(" · ");
}

/** Canonical form for the dedupe above: upper-case, drop whitespace, and strip
 *  a leading company-code prefix ("HC-", "2990-") when what remains is itself a
 *  PO number, so a prefixed order PO and its bare-typed twin compare equal.
 *  Anything that is not `<code>-PO…` is compared whole, so genuinely different
 *  numbers (e.g. "APO/2609-001") never collapse. */
function canonicalPoNumber(s: string): string {
  const t = s.trim().toUpperCase().replace(/\s+/g, "");
  const m = t.match(/^[A-Z0-9]+-(PO[-/].*)$/);
  return m ? m[1] : t;
}
