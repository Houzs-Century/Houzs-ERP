// ----------------------------------------------------------------------------
// MobileLineRemark — the free-text remark under a document line on the phone.
//
// ONE renderer for a row that used to exist twice, in two files, for the same
// thing. MobileSODetail has shown the SALES line's `remark` since the owner
// reported (2026-08-11) that a SVC-ADDON line whose whole job was "Please take
// back Cody Bedframe (King Size) 2 units" rendered as an RM0 row showing only
// its SKU code. MobileModuleDetail — the phone's PURCHASE-order surface — had
// no such row at all, so the owner's 2026-09-04 request 「SO line 和 PO line 的
// remarks」 needed the same block a second time. It is extracted instead,
// because two copies of a display rule drift.
//
// WHAT IT CARRIES ON A PO LINE, and why it matters: scm.purchase_order_items
// .notes is where the AutoCount migration parked the book's own Description 2 —
// the customer's spec text in the salesperson's own words. Measured on
// production 2026-09-04, 923 of the 1,117 migrated company-1 PO lines hold it
// (891 byte-identical to description2, 32 the same text plus a suffix), e.g.
// `col:PC-151-03/m.gap:12inch/divan:8inch+2inchleg`. Unlike description2 — which
// the item PATCH regenerates from buildVariantSummary on every write and which
// IS on the AutoCount write-back path — `notes` is neither regenerated nor sent
// back (PO_ITEM_COLS, backend/src/scm/lib/autocount-outbox.ts, does not select
// it). So it survives a save, and until 2026-09-04 nothing rendered it.
//
// It WRAPS and never truncates: half an instruction is worse than none.
// Renders nothing at all for blank / whitespace text.
// ----------------------------------------------------------------------------

export function MobileLineRemark({ text }: { text?: string | null }) {
  const remark = (text ?? "").trim();
  if (!remark) return null;
  return (
    <div style={{ flexBasis: "100%", fontSize: 11, color: "var(--mut)", marginTop: 3, fontStyle: "italic", whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.35 }}>
      {remark}
    </div>
  );
}

export default MobileLineRemark;
