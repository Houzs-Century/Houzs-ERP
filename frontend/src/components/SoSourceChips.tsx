// SoSourceChips — the ONE renderer for a Sales-Order line's "Incoming PO" /
// source cell, shared by the SO list drill-down (MfgSalesOrdersListV2), the SO
// detail page (SalesOrderDetailV2) and the ?edit=1 editor (SalesOrderDetail).
// Owner 2026-08-01: SO / DO / SI / GRN must show IDENTICAL source-PO data for
// the same order — the backend resolves through one lib (source-po-trace.ts),
// and this component is the one place the SO side turns that payload into
// pixels, so a styling or precedence fix lands on every surface at once.
//
// Precedence per line (all can coexist on a partially-shipped line):
//   1. shipped_source_pos — the PO(s) the DELIVERED goods actually came from
//      (consumption → lot → batch_no, GRN-healed). Durable, survives delivery.
//   2. STOCK ADJ — shipped and/or allocated from a PO-less stock ADJUSTMENT
//      (free gift / cancel add-back). Explained, never a blank.
//   3. ready_source_pos — the READY (allocated, un-shipped) trace: sofa's
//      stored allocated_batch_no, non-sofa's FIFO projection over the bucket's
//      open lots in the engine's own consumption order. Answers "this READY
//      line will draw from PO X" before any DO exists.
//   4. coverage_po (+ ETA) — the MRP incoming-PO coverage for the un-arrived
//      remainder (stock_state === 'po').
//   Nothing at all → a dash.
//
// This is a DETAIL/DRILL surface — every chip renders (the "+N" ChipOverflow
// rule applies to LIST header cells only).

import { showDeliveredQty, sourcePoTitle, StockAdjChip } from "./DocumentLinesExpansion";
import { type CoverageState, coveragePlaceholder } from "./coverage-state";
import { cn, formatDate } from "../lib/utils";
import { PO_CELL_MAX, poCellChips, type SoPoChipRow } from "../lib/soPoChips";

export type ReadySourceChip = {
  po: string | null;
  qty: number;
  kind: "po" | "adjustment";
};

export type SoLineSourceFields = {
  item_group?: string | null;
  stock_status?: string | null;
  stock_state?: "stock" | "po" | "shortage" | null;
  /** The SERVER's verdict over both columns above (scm/lib/so-line-effective-stock.ts),
   *  since 2026-08-17. The SO list's Stock Status column rolls up this same
   *  function, so the pill and the board column can no longer hold two
   *  opinions — which is what printed `SHORT: MATTRESS` over a mattress that
   *  was in the warehouse on 2990-SO-2608-002. */
  stock_status_effective?: "READY" | "PARTIAL" | "PENDING" | null;
  coverage_po?: string | null;
  coverage_eta?: string | null;
  shipped_source_pos?: string[];
  shipped_source_adj?: boolean;
  ready_source_pos?: ReadySourceChip[];
  delivered_qty?: number | null;
  remaining_qty?: number | null;
};

/* 2990-parity stock pill (one home — formerly drillStock in the SO list):
   fully shipped → DELIVERED; on-hand → READY; partially covered → PARTIAL;
   else PENDING. SERVICE lines carry no physical stock, so a service is
   inherently available → always READY (owner 2026-07-24). */
export function soLineStockPill(l: SoLineSourceFields): { label: string; cls: string } | null {
  if ((l.item_group ?? "").toUpperCase().includes("SERVICE"))
    return { label: "READY", cls: "bg-synced-bg text-synced" };
  const shipped = (l.delivered_qty ?? 0) > 0 && (l.remaining_qty ?? null) === 0;
  if (shipped) return { label: "DELIVERED", cls: "bg-surface-dim text-ink-muted" };
  /* PREFER THE SERVER'S VERDICT. The `||` below is the rule this client used to
     own outright, and the SO list rolled up a DIFFERENT one — so the same order
     read READY here and SHORT on the board. Since 2026-08-17 both handlers stamp
     `stock_status_effective` from ONE backend function and the list rolls up the
     same call, so the two surfaces are the same answer rather than two
     implementations that agree on a good day. The fallback stays for a payload
     that predates the field (a cached detail response, the consignment line
     shape) and is byte-identical to the old behaviour. */
  const effective = l.stock_status_effective
    ?? (l.stock_state === "stock" || l.stock_status === "READY" ? "READY"
      : l.stock_status === "PARTIAL" ? "PARTIAL" : "PENDING");
  if (effective === "READY") return { label: "READY", cls: "bg-synced-bg text-synced" };
  if (effective === "PARTIAL") return { label: "PARTIAL", cls: "bg-warning-bg text-warning-text" };
  return { label: "PENDING", cls: "bg-surface-dim text-ink-muted" };
}

export function SoStockPill({ line }: { line: SoLineSourceFields }) {
  const stock = soLineStockPill(line);
  if (!stock) return <span className="text-[11px] text-ink-muted">—</span>;
  return (
    <span
      className={
        "inline-block rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider " +
        stock.cls
      }
    >
      {stock.label}
    </span>
  );
}

const chipBase =
  "rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-docno text-[11px] font-semibold text-accent-ink";

/* Soft-until-DO (Decision, docs/modules/purchase-order.md 2026-08-06): only a
   SHIPPED source is anchored history and earns the solid chip. READY
   projections and incoming MRP coverage are floating — live, recomputed on
   every view — so they wear the dashed identity the other surfaces use. */
const floatingChipBase =
  "rounded border border-dashed border-border px-1.5 py-0.5 font-docno text-[11px] font-semibold text-ink-secondary";

export function SoSourceChips({
  line,
  coverage,
}: {
  line: SoLineSourceFields;
  /* REQUIRED (coverage-state.tsx). Chips 3 and 4 read `ready_source_pos` and
     `coverage_po`, which the detail payload hard-codes empty and a SECOND query
     fills (docs/bugs/0596). Until it lands this cell used to print a bare dash —
     "nothing is on the way" — which is a claim, not a blank. Owner 2026-09-02:
     「我以为是 bugs」. */
  coverage: CoverageState;
}) {
  const shippedPos = line.shipped_source_pos ?? [];
  const shippedSet = new Set(shippedPos);
  const fullyShipped = (line.delivered_qty ?? 0) > 0 && (line.remaining_qty ?? null) === 0;
  // READY chips only while something is still un-shipped; a PO already shown
  // as the shipped source is not repeated (one chip per PO, the shipped
  // meaning wins). Adjustment folds into ONE "STOCK ADJ" chip with the
  // shipped-side flag.
  const readyChips = fullyShipped
    ? []
    : (line.ready_source_pos ?? []).filter((r) => !(r.po && shippedSet.has(r.po)));
  const readyPoChips = readyChips.filter((r) => r.kind === "po" && r.po);
  const anyAdj = Boolean(line.shipped_source_adj) || readyChips.some((r) => r.kind === "adjustment");
  // Incoming (un-arrived) remainder — the MRP coverage PO + ETA.
  const incomingPo = line.stock_state === "po" && line.coverage_po ? line.coverage_po : null;
  const showIncoming = incomingPo && !shippedSet.has(incomingPo) && !readyPoChips.some((r) => r.po === incomingPo);

  if (shippedPos.length === 0 && readyPoChips.length === 0 && !anyAdj && !incomingPo) {
    /* BEFORE the dash: an unresolved read is not "nothing on the way". */
    return coveragePlaceholder(coverage) ?? <span className="text-[11px] text-ink-muted">—</span>;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shippedPos.map((po) => (
        <span
          key={`s-${po}`}
          title={`${sourcePoTitle(po)} The delivered goods physically shipped from this PO's batch.`}
          className={chipBase}
        >
          {po}
        </span>
      ))}
      {readyPoChips.map((r) => (
        <span
          key={`r-${r.po}`}
          title={`${sourcePoTitle(r.po as string)} READY — a live FIFO projection of the batch the delivery would consume, recomputed on every view; the Delivery Order decides the actual batch.`}
          className={floatingChipBase}
        >
          {r.po}
          {showDeliveredQty(r.qty, readyPoChips.length + shippedPos.length) && (
            <span className="text-ink-muted">{` x${r.qty}`}</span>
          )}
        </span>
      ))}
      {anyAdj && <StockAdjChip />}
      {showIncoming && (
        <span
          title="Incoming — live MRP coverage for the un-arrived remainder, recomputed on every view; it moves as demand moves."
          className={cn(floatingChipBase, "whitespace-nowrap font-mono")}
        >
          {incomingPo}
          {line.coverage_eta ? ` · ETA ${formatDate(line.coverage_eta)}` : ""}
        </span>
      )}
    </span>
  );
}

/* SO LIST "PO No." cell (2026-08-11) — a LIST surface, so unlike the drill
   above it caps and shows a "+N". Two chip identities, never conflated:

     solid  a GOODS SOURCE (`source_po_union`) — shipped consumed batch or
            READY allocation. "他拿的货是谁的货".
     muted  a RAISED PO (`converted_po_nos`) — this SO's lines were converted
            into that purchase order. Procurement provenance, the same muted
            dress the "bought for" chips wear on the purchase-doc rows.

   The raised arm is visible because both source arms need EXECUTION (a DO line,
   or an open lot that still resolves to a PO). A CONFIRMED order that has not
   shipped satisfies neither, so the cell used to render "—" — with the raised
   PO hidden in a tooltip ON the em-dash — for documents whose own Relationship
   Map named a purchase order. Mobile twin: `SourcePosRowMobile`'s `raised`
   slot in mobile/source-chips.tsx. Keep the two in lockstep. */
export function SoListPoCell({ row }: { row: SoPoChipRow }) {
  const { source, all } = poCellChips(row);
  if (all.length === 0 && !row.source_po_adj) return <span className="text-ink-muted">—</span>;
  const shown = all.slice(0, PO_CELL_MAX);
  const hidden = all.length - shown.length;
  const raisedTone =
    "rounded border border-border-subtle bg-surface-dim px-1.5 py-0.5 font-docno text-[11px] font-semibold text-ink-secondary";
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((n) => (source.includes(n) ? (
        <span
          key={n}
          title={`Source PO ${n} — the goods on this order come from this purchase order (shipped batch or READY allocation).`}
          className="rounded bg-primary-soft px-1.5 py-0.5 font-docno text-[11px] font-semibold text-primary-ink"
        >
          {n}
        </span>
      ) : (
        <span
          key={n}
          title={`Raised PO ${n} — this order's lines were converted into this purchase order. Procurement provenance: the goods have not been drawn from stock yet, so it is not (yet) a goods source.`}
          className={raisedTone}
        >
          {n}
        </span>
      )))}
      {hidden > 0 && (
        <span title={`All purchase orders on this sales order: ${all.join(", ")}`} className={raisedTone}>
          {`+${hidden}`}
        </span>
      )}
      {row.source_po_adj && <StockAdjChip />}
    </div>
  );
}

export default SoSourceChips;
