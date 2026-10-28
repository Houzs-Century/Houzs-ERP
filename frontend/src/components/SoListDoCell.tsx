/* SO list "DO No." cell (owner 2026-08-14).
 *
 * Replaces "Current Doc No.", which was backed by the server's `current_doc_no`
 * — the furthest-forward document of ANY kind, ranking DO → Sales Invoice →
 * Delivery Return and falling back to the order's own number when nothing
 * downstream exists. Under a delivery heading that read as a delivery number
 * even when it was an invoice number, or the SO number of an order that had
 * never shipped. This cell shows Delivery Orders and nothing else; an order
 * with no DO gets a dash, which is an answer, not a gap.
 *
 * Caps like its PO No. sibling (SoSourceChips → SoListPoCell): this is a LIST
 * surface, a part-delivered order's DOs do not fit 150px, and the drill-down is
 * where every one is listed. The overflow chip's tooltip still names them all,
 * so nothing is hidden the way a bare "+1" hides a second receipt.
 */

/** Same cap the PO No. column uses, so the two read as a pair. */
export const DO_CELL_MAX = 3;

const chip =
  "rounded bg-primary-soft px-1.5 py-0.5 font-docno text-[11px] font-semibold text-primary-ink";
const overflowChip =
  "rounded border border-border-subtle bg-surface-dim px-1.5 py-0.5 font-docno text-[11px] font-semibold text-ink-secondary";

export function SoListDoCell({ doNos }: { doNos?: string[] | null }) {
  const all = (doNos ?? []).filter(Boolean);
  if (all.length === 0) return <span className="text-[12px] text-ink-muted">—</span>;
  const shown = all.slice(0, DO_CELL_MAX);
  const hidden = all.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((n) => (
        <span key={n} title={`Delivery Order ${n} — goods on this sales order shipped on it.`} className={chip}>
          {n}
        </span>
      ))}
      {hidden > 0 && (
        <span title={`All delivery orders on this sales order: ${all.join(", ")}`} className={overflowChip}>
          {`+${hidden}`}
        </span>
      )}
    </div>
  );
}

export default SoListDoCell;
