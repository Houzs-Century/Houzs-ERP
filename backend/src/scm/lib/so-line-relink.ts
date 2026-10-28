// ----------------------------------------------------------------------------
// so-line-relink — carry the SO-line links across a delete-and-reinsert.
//
// THREE tables reference scm.mfg_sales_order_items.id with a FK declared
// `ON DELETE SET NULL` (backend/scripts/scm-schema/2990s-full-schema.sql):
//
//   purchase_order_items.so_item_id   :1747   ← decides drop-ship / MRP binding
//   delivery_order_items.so_item_id   :1651
//   sales_invoice_items.so_item_id    :1767
//
// So the instant an SO line row is DELETEd, the database silently wipes every
// downstream document's only record of which SO line it served. For a genuine
// line removal that is correct — the line is gone, so the link is meaningless.
// For a delete-and-REINSERT (the TBC sofa exchange replaces a whole sofa build
// with a new set of module lines) it is data loss wearing a routine operation's
// clothes: the PO that is on its way to fulfil that build stops being findable
// from the SO, the drop-ship offer disappears, and the shipment can never bind
// its incoming batch.
//
// `snapshotSo` in so-revision.ts already froze this mapping for the amendment
// engine (its `poLinks` blob). This module is the same idea generalised: freeze
// BEFORE the delete, decide what to restore with a PURE function, apply after
// the reinsert — plan / apply separated the way oversell-retrocost.ts is, so
// the decision is testable without a database.
//
// WHAT IS DELIBERATELY NOT RESTORED: an old line whose SKU has no counterpart
// in the new set. A sofa exchange that genuinely swaps a 2-seater module for a
// 3-seater has changed what was ordered; inventing a link to a different SKU
// would be worse than the null, because every consumer downstream (drop-ship
// batch resolution, MRP coverage, costing) trusts the link to mean "this PO
// line is FOR that SO line". Those are returned as `dropped` so the caller can
// say so out loud instead of losing them silently.
// ----------------------------------------------------------------------------

export const SO_LINK_TABLES = [
  'purchase_order_items',
  'delivery_order_items',
  'sales_invoice_items',
] as const;

export type SoLinkTable = (typeof SO_LINK_TABLES)[number];

/** One downstream row that currently points at an SO line. */
export type SoLinkRow = { table: SoLinkTable; rowId: string; soItemId: string };

/** The identity a match is made on. `lineNo` only orders duplicates WITHIN one
 *  bucket; it never decides which bucket a line is in.
 *
 *  `variantSig` is part of the identity, not decoration — docs/bugs/0672 site
 *  11. Without it two lines of the SAME model in different fabrics (the ordinary
 *  sofa case, and exactly what a TBC exchange produces) share one bucket and are
 *  paired by POSITION, so a reordered replacement set re-points the purchase
 *  order dedicated to the BLUE two-seater at the GREY one. The SKU matches, the
 *  foreign key is valid, nothing dangles — and the floor is told the wrong sofa
 *  is covered. Build it with `soLineVariantSig`. */
export type SoLineIdentity = {
  id: string;
  itemCode: string | null;
  lineNo?: number | null;
  variantSig?: string | null;
};

export type SoLineRelinkPlan = {
  /** Rewrite these rows' so_item_id onto the replacement line. */
  restore: Array<{ table: SoLinkTable; rowId: string; soItemId: string }>;
  /** No replacement carries this SKU — the link is genuinely gone. */
  dropped: Array<{ table: SoLinkTable; rowId: string; oldSoItemId: string; itemCode: string | null }>;
};

const normCode = (code: string | null | undefined): string => (code ?? '').trim().toUpperCase();

/** The colour a line is FOR, read the way the importers actually write it.
 *
 *  `colourId` first (the fabric-colour row's own id, which survives a rename),
 *  then the label, then the legacy `colourCode`. The same precedence
 *  probe-link-identity.mjs uses — and the reason it uses it is recorded in
 *  docs/bugs/0674: an earlier version compared `colourCode` alone, found 0
 *  comparable pairs on every edge, and that EMPTY answer printed identically to
 *  a clean one. A line with no colour returns '', so non-sofa lines bucket
 *  exactly as they did before. */
export function soLineVariantSig(variants: unknown): string {
  const v = (variants ?? {}) as Record<string, unknown>;
  const raw = v.colourId ?? v.colourLabel ?? v.colourCode ?? '';
  return String(raw).trim().toUpperCase();
}

/** Bucket identity: the SKU AND the variant. The NUL separator cannot appear in
 *  either half, so no pair of (code, variant) can collide with another. */
const bucketKey = (l: SoLineIdentity): string => `${normCode(l.itemCode)}\u0000${(l.variantSig ?? '').trim().toUpperCase()}`;

/* Deterministic order within one SKU bucket: line_no when the document is
   numbered, then id. Both sides are ordered the same way, so the k-th old line
   of a SKU pairs with the k-th new line of that SKU — which is what makes a
   two-module build with two identical modules map 1:1 instead of at random. */
function orderedIds(lines: SoLineIdentity[]): Map<string, string[]> {
  const byCode = new Map<string, SoLineIdentity[]>();
  for (const l of lines) {
    if (!l.id) continue;
    const key = bucketKey(l);
    const bucket = byCode.get(key) ?? [];
    bucket.push(l);
    byCode.set(key, bucket);
  }
  const out = new Map<string, string[]>();
  for (const [code, bucket] of byCode) {
    const sorted = [...bucket].sort((a, b) => {
      const an = typeof a.lineNo === 'number' ? a.lineNo : Number.POSITIVE_INFINITY;
      const bn = typeof b.lineNo === 'number' ? b.lineNo : Number.POSITIVE_INFINITY;
      if (an !== bn) return an - bn;
      return a.id.localeCompare(b.id);
    });
    out.set(code, sorted.map((l) => l.id));
  }
  return out;
}

/** PURE. Decide, per captured link, whether it can follow the replacement set. */
export function planSoLineRelink(
  oldLines: SoLineIdentity[],
  newLines: SoLineIdentity[],
  links: SoLinkRow[],
): SoLineRelinkPlan {
  const oldByCode = orderedIds(oldLines);
  const newByCode = orderedIds(newLines);

  // old SO line id -> replacement SO line id, paired ordinally inside each SKU.
  const oldToNew = new Map<string, string>();
  const codeOfOld = new Map<string, string>();
  /* Reported to the caller as a human ITEM CODE, never the bucket key — the
     dropped list is read by a person deciding what to re-link by hand. */
  const humanCode = new Map<string, string>(oldLines.filter((l) => l.id).map((l) => [l.id, normCode(l.itemCode)]));
  for (const [code, oldIds] of oldByCode) {
    const newIds = newByCode.get(code) ?? [];
    oldIds.forEach((oldId, i) => {
      codeOfOld.set(oldId, humanCode.get(oldId) ?? code);
      const replacement = newIds[i];
      if (replacement) oldToNew.set(oldId, replacement);
    });
  }

  const plan: SoLineRelinkPlan = { restore: [], dropped: [] };
  for (const link of links) {
    if (!link.rowId || !link.soItemId) continue;
    const replacement = oldToNew.get(link.soItemId);
    if (replacement) {
      plan.restore.push({ table: link.table, rowId: link.rowId, soItemId: replacement });
    } else {
      plan.dropped.push({
        table: link.table,
        rowId: link.rowId,
        oldSoItemId: link.soItemId,
        itemCode: codeOfOld.get(link.soItemId) ?? null,
      });
    }
  }
  return plan;
}

/** Freeze every downstream link pointing at these SO lines. Call BEFORE the
    delete — afterwards the FK has already nulled them and there is nothing to
    read. Best-effort per table: a table this deployment does not have must not
    take the whole command down, so its links are simply absent. */
export async function snapshotSoLineLinks(sb: any, soItemIds: string[]): Promise<SoLinkRow[]> {
  const ids = [...new Set(soItemIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const out: SoLinkRow[] = [];
  for (const table of SO_LINK_TABLES) {
    try {
      const { data, error } = await sb.from(table).select('id, so_item_id').in('so_item_id', ids);
      if (error) continue;
      for (const r of (data ?? []) as Array<{ id: string; so_item_id: string | null }>) {
        if (r.id && r.so_item_id) out.push({ table, rowId: r.id, soItemId: r.so_item_id });
      }
    } catch { /* table absent in this deployment — nothing to carry */ }
  }
  return out;
}

/** Write the plan's restores. Runs inside the caller's transaction, so a failed
    restore is a failed command: half a build's links carried and half nulled is
    the ambiguous state this whole module exists to prevent. Returns the counts
    the caller reports back / audits. */
export async function applySoLineRelink(
  sb: any,
  plan: SoLineRelinkPlan,
  onWriteError: (error: { message?: string } | null | undefined, label: string) => void,
): Promise<{ restored: number; dropped: number }> {
  for (const r of plan.restore) {
    const { error } = await sb.from(r.table).update({ so_item_id: r.soItemId }).eq('id', r.rowId);
    onWriteError(error, `SO line re-link failed for ${r.table} ${r.rowId}`);
  }
  return { restored: plan.restore.length, dropped: plan.dropped.length };
}
