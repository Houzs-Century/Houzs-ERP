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
  // SALES docs (DO / SI): the source PO(s) the shipped/invoiced goods actually
  // came from — the durable batch_no = source-PO hard link, not a guess. Empty /
  // absent → the Source PO cell shows a dash (plain FIFO / pre-batch stock).
  sourcePos?: string[];
  // PURCHASE docs (PO / GRN / PI): the Delivery Order(s) that have shipped this
  // line's goods (batch_no = this PO) with the qty shipped per DO. Empty / absent
  // → the Delivered cell shows a dash (nothing delivered against this line yet).
  deliveredDos?: Array<{ doNo: string; qty: number }>;
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

// Column widths are driven by which optional columns are on, so the template is
// built at RUNTIME and applied via an inline style — a dynamically-joined
// `grid-cols-[...]` class would never be seen by Tailwind's JIT scanner.
function buildGrid(opts: { assign: boolean; delivered: boolean; sourcePo: boolean }): {
  cols: string;
  minW: number;
} {
  const cols = ["92px", "minmax(180px,1fr)", "56px", "104px"];
  let minW = 540;
  if (opts.assign) { cols.push("minmax(150px,190px)", "120px"); minW += 300; }
  if (opts.delivered) { cols.push("minmax(150px,200px)"); minW += 200; }
  if (opts.sourcePo) { cols.push("minmax(140px,190px)"); minW += 200; }
  return { cols: cols.join(" "), minW };
}

export function DocumentLinesExpansion({
  isLoading,
  isError,
  errorMessage,
  lines,
  emptyLabel = "No lines on this document.",
  showAssignment = false,
  showDelivered = false,
  showSourcePo = false,
  onOpenSo,
  onOpenDo,
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
  // Purchase docs (PO / GRN / PI): render a Delivered column from each line's
  // `deliveredDos` — the DO(s) that shipped this line's goods.
  showDelivered?: boolean;
  // Sales docs (DO / SI): render a Source PO column from each line's `sourcePos`.
  showSourcePo?: boolean;
  onOpenSo?: (soDocNo: string) => void;
  onOpenDo?: (doNo: string) => void;
}) {
  const { cols: gridCols, minW: minWpx } = buildGrid({
    assign: showAssignment,
    delivered: showDelivered,
    sourcePo: showSourcePo,
  });
  const gridStyle = { gridTemplateColumns: gridCols } as const;
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
      <div style={{ minWidth: `${minWpx}px` }}>
        <div
          style={gridStyle}
          className="grid items-start gap-2 border-b border-border-subtle bg-surface-2 px-4 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted"
        >
          <span>Group</span>
          <span>Item</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Amount</span>
          {showAssignment && <span>Assigned SO</span>}
          {showAssignment && <span>SO Delivery Date</span>}
          {showDelivered && <span>Delivered</span>}
          {showSourcePo && <span>Source PO</span>}
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
          const delivered = l.deliveredDos ?? [];
          const sourcePos = l.sourcePos ?? [];
          return (
            <div
              key={i}
              style={gridStyle}
              className="grid items-start gap-2 border-b border-border-subtle px-4 py-2.5 last:border-b-0"
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
              {showDelivered && (
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  {delivered.length > 0 ? (
                    delivered.map((d) => {
                      const base =
                        "rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-secondary";
                      const label = (
                        <>
                          {d.doNo}
                          {d.qty > 0 && (
                            <span className="text-ink-muted">{` x${d.qty}`}</span>
                          )}
                        </>
                      );
                      return onOpenDo ? (
                        <button
                          type="button"
                          key={d.doNo}
                          onClick={() => onOpenDo(d.doNo)}
                          className={cn(base, "hover:border-accent hover:text-accent")}
                        >
                          {label}
                        </button>
                      ) : (
                        <span key={d.doNo} className={base}>
                          {label}
                        </span>
                      );
                    })
                  ) : (
                    <span className="text-[11px] text-ink-muted">—</span>
                  )}
                </span>
              )}
              {showSourcePo && (
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  {sourcePos.length > 0 ? (
                    sourcePos.map((po) => (
                      <span
                        key={po}
                        className="rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-accent-ink"
                      >
                        {po}
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
// raise-link, or a DO's own intrinsic SO) reads as a solid chip. EVERY assigned
// SO renders (owner 2026-07-31 — no "first + N" collapse); they wrap. The
// primary assignment's delivery date rides inline. `sourceLinked === false` is
// threaded into the tooltip so the guess-vs-binding distinction (2026-07-29
// incident) survives even in the compact column.
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
  const base = "rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold";
  // ALL assigned SOs render (owner 2026-07-31 — no "first + N" collapse); the
  // flex-wrap lays them out. Each chip keeps its own floating(guess) vs
  // solid(linked) tone + tooltip. The primary's delivery date rides inline.
  const chipTitle = (a: OriginAssignment): string =>
    a.locked === false
      ? "MRP guess — a live allocation, not a stored link. It moves as demand moves and can disappear."
      : a.source === "delivered"
        ? "Locked — the goods were delivered against this Sales Order"
        : sourceLinked === false
          ? "This Sales Order is an MRP allocation — no stored link on the purchase order line"
          : "Locked — a stored link to this Sales Order";
  const chipTone = (a: OriginAssignment): string =>
    a.locked === false
      ? "border border-dashed border-border text-ink-secondary"
      : "border border-border-subtle bg-surface-2 text-accent-ink";
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {list.map((a) => {
        const label = (
          <>
            {a.soDocNo}
            {a.locked === false && <span className="text-ink-muted">{" ~"}</span>}
          </>
        );
        // Each SO carries its OWN delivery date inline (owner: show every SO with
        // its date, no collapse). The chip + its date form one wrapping unit.
        return (
          <span key={a.soDocNo} className="inline-flex items-center gap-1">
            {onOpenSo ? (
              <button
                type="button"
                title={chipTitle(a)}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSo(a.soDocNo);
                }}
                className={cn(base, chipTone(a), "hover:border-accent hover:text-accent")}
              >
                {label}
              </button>
            ) : (
              <span title={chipTitle(a)} className={cn(base, chipTone(a))}>
                {label}
              </span>
            )}
            {a.deliveryDate && (
              <span className="whitespace-nowrap font-mono text-[10.5px] text-ink-muted">
                {formatDate(a.deliveryDate)}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// DeliveredCell — the COLLAPSED header-row "Delivered" summary for the PO / GRN /
// PI lists: EVERY Delivery Order that has shipped this purchase document's goods
// (batch_no = the PO number), with the qty shipped per DO. No "first + N"
// collapse (owner 2026-07-31) — all DOs render and wrap. A dash when nothing has
// shipped yet.
// ---------------------------------------------------------------------------
export function DeliveredCell({
  dos,
  onOpenDo,
}: {
  dos: Array<{ doNo: string; qty: number }> | undefined | null;
  onOpenDo?: (doNo: string) => void;
}) {
  const list = dos ?? [];
  if (list.length === 0) return <span className="text-[12px] text-ink-muted">—</span>;
  const base =
    "rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-secondary";
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {list.map((d) => {
        const label = (
          <>
            {d.doNo}
            {d.qty > 0 && <span className="text-ink-muted">{` x${d.qty}`}</span>}
          </>
        );
        return onOpenDo ? (
          <button
            type="button"
            key={d.doNo}
            title="A Delivery Order that shipped this document's goods"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDo(d.doNo);
            }}
            className={cn(base, "hover:border-accent hover:text-accent")}
          >
            {label}
          </button>
        ) : (
          <span key={d.doNo} className={base}>
            {label}
          </span>
        );
      })}
    </span>
  );
}

export default DocumentLinesExpansion;
