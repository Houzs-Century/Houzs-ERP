// DocumentLinesExpansion — shared inline per-line breakdown rendered under a
// document row when the DataTable chevron is toggled. It is the DRY twin of the
// SO list's SoLinesExpansion (frontend/src/pages/scm-v2/MfgSalesOrdersListV2.tsx):
// Group pill + item CODE/variant identity + Qty + Amount. The SO/DO list keeps
// its own richer variant (Stock pill + Incoming PO/ETA columns) because those
// fields ride the SO detail payload; the six purchase/sales document lists that
// consume THIS component do not carry per-line MRP coverage, so they render the
// four columns their existing detail hooks actually return.
//
// Each caller owns its own detail hook and field quirks (which column is Qty,
// which is the line amount, how the code resolves) and maps its raw items into
// DocumentDrillLine[] before handing them here — this component is purely
// presentational so no list's field mapping leaks into another's.

import { buildVariantSummary, fmtCenti, orderLineIdentity } from "@2990s/shared";
import { ItemGroupPill } from "../vendor/scm/lib/category-badges";
import type { OriginAssignment } from "../vendor/scm/lib/flow-queries";
import { cn, formatDate } from "../lib/utils";

// A single normalised drill line. Callers resolve `code` (e.g. material_code ||
// item_code), `qty` (ordered / received / returned as the document means) and
// `amountCenti` (line_total_centi / total_centi) themselves; `itemGroup` +
// `variants` feed the same live buildVariantSummary the detail drawers use.
export type DocumentDrillLine = {
  itemGroup: string | null;
  code: string | null;
  description: string | null;
  description2: string | null;
  variants: Record<string, unknown> | null;
  qty: number;
  amountCenti: number;
  // The REAL origin Sales Order(s) this line was raised from, matched by SKU
  // (purchase docs only). Empty / absent → the Assigned SO + delivery cells show
  // a dash, exactly like the SO detail's Stock / Incoming PO columns.
  assignedSos?: OriginAssignment[];
  // Does a STORED so_item_id back this line's SKU, or is the Assigned SO above
  // only an MRP allocation? The two used to render identically apart from a
  // dashed border, and the owner read a guess as a binding (2026-07-29). When
  // false, the cell says so in words.
  sourceLinked?: boolean;
};

// Permissive superset of the per-line fields the six document detail hooks
// return. Each list's items are cast to this in its wrapper (the same shape the
// SI/DR detail drawers already cast to inline), so a wrapper never has to
// import that list's exact item type — it just reads the fields it means and
// picks its own Qty / amount source. Every field is optional; a document that
// omits one falls through to the `??` defaults in the wrapper.
export type DrillItemFields = {
  item_group?: string | null;
  material_code?: string | null;
  item_code?: string | null;
  product_code?: string | null;
  description?: string | null;
  material_name?: string | null;
  product_name?: string | null;
  description2?: string | null;
  variants?: Record<string, unknown> | null;
  qty?: number | null;
  received_qty?: number | null;
  qty_returned?: number | null;
  unit_price_centi?: number | null;
  line_total_centi?: number | null;
  total_centi?: number | null;
  amount_centi?: number | null;
};

// Shared centi → RM string, same helper the lists use.
const fmtRm = (centi: number): string => fmtCenti(centi);

const GRID =
  "grid grid-cols-[92px_minmax(220px,1fr)_64px_110px] items-start gap-2";
// With the two purchase-doc origin columns (Assigned SO + SO Delivery Date),
// mirroring the SO detail's Group…Stock…Incoming-PO grid.
const GRID_ASSIGN =
  "grid grid-cols-[92px_minmax(200px,1fr)_56px_104px_minmax(150px,190px)_120px] items-start gap-2";

export function DocumentLinesExpansion({
  isLoading,
  isError,
  errorMessage,
  lines,
  emptyLabel = "No lines on this document.",
  showAssignment = false,
  onOpenSo,
}: {
  isLoading: boolean;
  isError?: boolean;
  errorMessage?: string | null;
  lines: DocumentDrillLine[];
  emptyLabel?: string;
  // Purchase docs (PO / GRN / PI): render the Assigned SO + SO Delivery Date
  // columns from each line's `assignedSos`. onOpenSo makes the SO chip clickable
  // (desktop deep-link); omit it for a display-only surface.
  showAssignment?: boolean;
  onOpenSo?: (soDocNo: string) => void;
}) {
  const grid = showAssignment ? GRID_ASSIGN : GRID;
  const minW = showAssignment ? "min-w-[840px]" : "min-w-[540px]";
  if (isLoading) {
    return (
      <div className="py-4 text-center text-[12px] text-ink-muted">
        Loading lines…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="py-4 text-center text-[12px] text-err">
        {errorMessage || "Failed to load lines."}
      </div>
    );
  }
  if (lines.length === 0) {
    return (
      <div className="py-4 text-center text-[12px] text-ink-muted">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <div className={minW}>
        <div
          className={cn(
            grid,
            "border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted"
          )}
        >
          <span>Group</span>
          <span>Item</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Amount</span>
          {showAssignment && <span>Assigned SO</span>}
          {showAssignment && <span>SO Delivery Date</span>}
        </div>
        {lines.map((l, i) => {
          // Item CODE first, then the variant subtitle; live variant summary
          // wins over the stored description2 (which can be stale on older rows
          // with no variants blob) — the same shared order-line rule the detail
          // drawers already apply.
          const { primary, secondary } = orderLineIdentity({
            code: l.code ?? undefined,
            description: l.description ?? undefined,
            variant:
              buildVariantSummary(l.itemGroup ?? "others", l.variants ?? null) ||
              (l.description2 ?? ""),
          });
          const assigned = l.assignedSos ?? [];
          return (
            <div
              key={i}
              className={cn(
                grid,
                "border-b border-border-subtle px-4 py-2.5 last:border-b-0"
              )}
            >
              <span>
                <ItemGroupPill group={l.itemGroup} />
              </span>
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold text-ink">
                  {primary || "—"}
                </div>
                {secondary && (
                  <div className="mt-0.5 text-[11px] leading-snug text-ink-secondary">
                    {secondary}
                  </div>
                )}
              </div>
              <span className="text-right font-money text-[12px] text-ink-secondary">
                {l.qty}
              </span>
              <span className="text-right font-money text-[12px] font-semibold text-ink">
                {fmtRm(l.amountCenti)}
              </span>
              {showAssignment && (
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex min-w-0 flex-wrap gap-1">
                  {assigned.length > 0 ? (
                    assigned.map((a) => {
                      // Floating (live MRP coverage) reads as a dashed chip with a
                      // trailing "~"; static (delivered→DO-locked or raised-from-SO)
                      // reads as a solid chip. Owner distinguishes the two.
                      const floating = a.locked === false;
                      const title = floating
                        ? "MRP guess — a live allocation, not a stored link. It moves as demand moves and can disappear."
                        : a.source === "delivered"
                          ? "Locked — this PO's goods were delivered against this Sales Order"
                          : "Locked — this PO line stores a link to this Sales Order";
                      const base =
                        "rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold";
                      const tone = floating
                        ? "border border-dashed border-border text-ink-secondary"
                        : "border border-border-subtle bg-surface-2 text-accent-ink";
                      return onOpenSo ? (
                        <button
                          type="button"
                          key={a.soDocNo}
                          title={title}
                          onClick={() => onOpenSo(a.soDocNo)}
                          className={cn(base, tone, "hover:border-accent hover:text-accent")}
                        >
                          {a.soDocNo}
                          {floating && <span className="text-ink-muted">{" ~"}</span>}
                        </button>
                      ) : (
                        <span key={a.soDocNo} title={title} className={cn(base, tone)}>
                          {a.soDocNo}
                          {floating && <span className="text-ink-muted">{" ~"}</span>}
                        </span>
                      );
                    })
                  ) : (
                    <span className="text-[11px] text-ink-muted">—</span>
                  )}
                  </span>
                  {/* The dashed border alone was too quiet: say in words that
                      nothing in the database binds this line, so nobody reads a
                      live allocation as a commitment (BUG-HISTORY 2026-07-31). */}
                  {assigned.length > 0 && l.sourceLinked === false && (
                    <span
                      className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted"
                      title="No stored link on the purchase order line — this is an MRP allocation only. Bind the line to its Sales Order line on the PO's edit screen."
                    >
                      MRP guess · not linked
                    </span>
                  )}
                </span>
              )}
              {showAssignment && (
                <span className="flex min-w-0 flex-col gap-0.5">
                  {assigned.length > 0 ? (
                    assigned.map((a) => (
                      <span
                        key={a.soDocNo}
                        className="whitespace-nowrap font-mono text-[11px] text-ink-secondary"
                      >
                        {a.deliveryDate ? formatDate(a.deliveryDate) : "—"}
                      </span>
                    ))
                  ) : (
                    <span className="text-[11px] text-ink-muted">—</span>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AssignedSoCell — the COLLAPSED header-row "Assigned SO" summary, shared by the
// PO / GRN / PI / DO lists. It is the one-line twin of the drill-down's per-line
// Assigned-SO cell above: a FLOATING (live MRP) assignment reads as a dashed
// chip with a trailing "~"; a STATIC one (delivered → DO-locked, a stored
// raise-link, or a DO's own intrinsic SO) reads as a solid chip. Several SOs
// collapse to "first + N". The delivery date rides a quiet second line when the
// primary assignment carries one. `sourceLinked === false` is threaded into the
// tooltip so the guess-vs-binding distinction (2026-07-29 incident) survives
// even in the compact column.
// ---------------------------------------------------------------------------
export function AssignedSoCell({
  assignments,
  sourceLinked,
  onOpenSo,
}: {
  assignments: OriginAssignment[] | undefined | null;
  sourceLinked?: boolean;
  onOpenSo?: (soDocNo: string) => void;
}) {
  const list = assignments ?? [];
  if (list.length === 0) return <span className="text-[12px] text-ink-muted">—</span>;
  const first = list[0];
  const extra = list.length - 1;
  const floating = first.locked === false;
  const title = floating
    ? "MRP guess — a live allocation, not a stored link. It moves as demand moves and can disappear."
    : first.source === "delivered"
      ? "Locked — the goods were delivered against this Sales Order"
      : sourceLinked === false
        ? "This Sales Order is an MRP allocation — no stored link on the purchase order line"
        : "Locked — a stored link to this Sales Order";
  const base = "rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold";
  const tone = floating
    ? "border border-dashed border-border text-ink-secondary"
    : "border border-border-subtle bg-surface-2 text-accent-ink";
  const label = (
    <>
      {first.soDocNo}
      {floating && <span className="text-ink-muted">{" ~"}</span>}
    </>
  );
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1">
        {onOpenSo ? (
          <button
            type="button"
            title={title}
            onClick={(e) => {
              e.stopPropagation();
              onOpenSo(first.soDocNo);
            }}
            className={cn(base, tone, "hover:border-accent hover:text-accent")}
          >
            {label}
          </button>
        ) : (
          <span title={title} className={cn(base, tone)}>
            {label}
          </span>
        )}
        {extra > 0 && (
          <span
            className="text-[11px] font-semibold text-ink-muted"
            title={list.map((a) => a.soDocNo).join(", ")}
          >
            +{extra}
          </span>
        )}
      </span>
      {first.deliveryDate && (
        <span className="whitespace-nowrap font-mono text-[10.5px] text-ink-muted">
          {formatDate(first.deliveryDate)}
        </span>
      )}
    </span>
  );
}

export default DocumentLinesExpansion;
