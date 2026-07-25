import { useMemo, useState } from "react";
import { adjustmentReasonLabel, formatVariantKey } from "@2990s/shared";
import { fmtCenti } from "../lib/scm";
import { formatDate } from "../lib/utils";
import {
  useInventoryMovements,
  useInventoryReservations,
  useWarehouses,
  buildStockBreakdown,
  type InventoryMovement,
  type InventoryReservation,
} from "../vendor/scm/lib/inventory-queries";

/* ------------------------------------------------------------------ *
 * Mobile Stock Card — per-SKU on-hand, the merged per-lot stock view
 * (each open lot with its warehouse, attributes, qty, unit cost, SOURCE
 * doc, received date, reservation + reserving SO's delivery date), and the
 * movement ledger. Phone twin of desktop pages/scm-v2/Inventory.tsx's Stock
 * Breakdown drawer; reuses the SAME shared feed + transform
 * (useInventoryReservations + buildStockBreakdown) so owned vs CONSIGNMENT is
 * split by the lot's SOURCE (never the warehouse flag) and consignment stays
 * OUT of value — one logic layer, two presentations. A warehouse filter (pills)
 * scopes the whole card. No backend. Opened from the Inventory list.
 * ------------------------------------------------------------------ */

type MovementRow = InventoryMovement & { runningBalance: number };

// OUT reduces on-hand (qty stored positive); IN/ADJUSTMENT/TRANSFER carry the
// value that applies (ADJ/TRANSFER are already signed). Verbatim from desktop
// StockCard running-balance rule.
const signedQty = (m: InventoryMovement): number => (m.movement_type === "OUT" ? -m.qty : m.qty);

const TYPE_PILL: Record<InventoryMovement["movement_type"], { cls: string; label: (m: InventoryMovement) => string }> = {
  IN: { cls: "in", label: (m) => `IN${m.source_doc_type ? ` · ${m.source_doc_type}` : ""}` },
  OUT: { cls: "out", label: (m) => `OUT${m.source_doc_type ? ` · ${m.source_doc_type}` : ""}` },
  ADJUSTMENT: { cls: "adj", label: () => "ADJ" },
  TRANSFER: { cls: "tr", label: () => "TRANSFER" },
};

/* One lot's card — warehouse + attributes + qty/cost, its SOURCE doc, received
   date, reservation status and (when reserved) the reserving SO(s) + delivery
   date. Owned shows the lot value; consignment shows a badge and no value. */
function LotCard({ l, consignment, first }: { l: InventoryReservation; consignment: boolean; first: boolean }) {
  const attrs = formatVariantKey(l.variant_key, l.fabric_supplier_code);
  const value = (l.qty_remaining ?? 0) * (l.unit_cost_sen ?? 0);
  const claims = l.reserved_by ?? [];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "8px 2px",
        borderTop: first ? "none" : "1px solid var(--line2)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {l.warehouse_code || l.warehouse_name || "—"}
          {consignment && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: 0.3,
                color: "var(--amber, #a06a00)",
                background: "var(--amber-bg, rgba(255,176,32,.16))",
                borderRadius: 4,
                padding: "1px 5px",
                verticalAlign: "middle",
              }}
            >
              CONSIGNMENT
            </span>
          )}
        </span>
        <span className="tnum" style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)", flex: "none" }}>
          {consignment ? "—" : value > 0 ? fmtCenti(value) : "—"}
        </span>
      </div>

      {attrs && (
        <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--mut)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {attrs}
        </span>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10.5, color: "var(--mut)" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {l.source_doc_no || "—"}
          {/* GRN-sourced lot also traces to its originating PO (display only). */}
          {l.source_po_no ? ` · from ${l.source_po_no}` : ""}
          {l.received_at ? ` · ${formatDate(l.received_at)}` : ""}
        </span>
        <span className="tnum" style={{ flex: "none" }}>
          {l.qty_remaining} · {fmtCenti(l.unit_cost_sen)}
        </span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10.5 }}>
        <span
          style={{
            fontWeight: 800,
            color: l.status === "RESERVED" ? "var(--red, #c0392b)" : "var(--green, #2b8a3e)",
          }}
        >
          {l.status === "RESERVED" ? "Reserved" : "Free"}
        </span>
        <span style={{ color: "var(--mut)", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {claims.length === 0
            ? "—"
            : claims
                .map((x) => `${x.doc_no}${x.delivery_date ? ` (${formatDate(x.delivery_date)})` : ""}`)
                .join(", ")}
        </span>
      </div>
    </div>
  );
}

export function MobileStockCard({
  productCode,
  productName,
  canTransfer,
  onBack,
  onNewTransfer,
}: {
  productCode: string;
  productName: string | null;
  canTransfer: boolean;
  onBack: () => void;
  onNewTransfer: () => void;
}) {
  // A warehouse filter scopes the whole card. Desktop keeps it in ?warehouseId;
  // the mobile screen has no route params, so it lives in local state.
  const [warehouseId, setWarehouseId] = useState<string | undefined>(undefined);

  const warehousesQ = useWarehouses();
  // ONE per-lot feed drives both the stat header and the merged lot list — the
  // SAME endpoint + transform the desktop drawer uses.
  const reservationsQ = useInventoryReservations({ productCode, warehouseId });
  const movementsQ = useInventoryMovements({ productCode, warehouseId });

  const warehouses = warehousesQ.data ?? [];
  // Movements carry only warehouse_id; map it to the SHORT code-name ("KL
  // WAREHOUSE") the desktop Warehouse column shows — the ONE canonical label.
  const whName = (id: string) => {
    const w = warehouses.find((x) => x.id === id);
    return w ? w.code : "—";
  };
  const selectedWh = warehouseId ? warehouses.find((w) => w.id === warehouseId) ?? null : null;

  // Owned vs consignment split + owned value/qty totals (consignment excluded
  // from value). Null-safe shared transform.
  const bd = useMemo(() => buildStockBreakdown(reservationsQ.data), [reservationsQ.data]);

  // API returns DESC; reverse to ASC to accumulate the running balance, then
  // render DESC (newest first) with the balance AFTER each movement.
  const rows = useMemo<MovementRow[]>(() => {
    const desc = movementsQ.data ?? [];
    const asc = [...desc].reverse();
    let running = 0;
    const out: MovementRow[] = [];
    for (const m of asc) {
      running += signedQty(m);
      out.push({ ...m, runningBalance: running });
    }
    return out.reverse();
  }, [movementsQ.data]);

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> Inventory
          </button>
          <span className="eyebrow">Stock Card · {productCode}</span>
        </div>
        <div className="hdr-row" style={{ marginTop: 2 }}>
          <div className="scr-title">{productName || productCode}</div>
        </div>
      </header>

      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 40, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="sc-hero">
          <div className="l">On hand (owned) · {selectedWh ? selectedWh.code : "all warehouses"}</div>
          <div className="v tnum">{bd.ownedQty} <span className="u">units</span></div>
          {bd.consignmentQty > 0 && (
            <div style={{ marginTop: 6, fontSize: 11, fontWeight: 700, opacity: 0.85 }}>
              Consignment (not owned) · <span className="tnum">{bd.consignmentQty}</span> units
            </div>
          )}
          <div
            style={{
              marginTop: 7,
              paddingTop: 7,
              borderTop: "1px solid rgba(255,255,255,.18)",
              fontSize: 11,
              fontWeight: 700,
              opacity: 0.85,
            }}
          >
            Owned value · <span className="tnum">{fmtCenti(bd.ownedValueSen)}</span>
          </div>
        </div>

        {warehouses.length > 0 && (
          <div className="chips">
            <button
              type="button"
              className={`chip${!warehouseId ? " on" : ""}`}
              onClick={() => setWarehouseId(undefined)}
            >
              All warehouses
            </button>
            {warehouses.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`chip${warehouseId === w.id ? " on" : ""}`}
                onClick={() => setWarehouseId(w.id)}
              >
                {w.code}
              </button>
            ))}
          </div>
        )}

        {/* Merged stock lots — oldest first (FIFO). Owned lots, then consignment
            lots (badged, no value). Same feed + split as the desktop drawer. */}
        <div className="sc-sl"><span className="t">Stock lots · oldest first</span><span className="ln" /></div>
        {reservationsQ.isLoading ? (
          <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "20px 0" }}>Loading…</div>
        ) : reservationsQ.error ? (
          <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "20px 0" }}>Couldn't load stock lots.</div>
        ) : bd.ownedLots.length === 0 && bd.consignmentLots.length === 0 ? (
          <div className="empty"><div className="empty-t">No open lots for this SKU.</div></div>
        ) : (
          <>
            {bd.ownedLots.length > 0 && (
              <div className="card" style={{ padding: "3px 12px" }}>
                {bd.ownedLots.map((l, i) => (
                  <LotCard key={l.id ?? `own|${l.warehouse_id}|${l.variant_key}|${l.batch_no ?? ""}|${i}`} l={l} consignment={false} first={i === 0} />
                ))}
              </div>
            )}
            {bd.consignmentLots.length > 0 && (
              <>
                <div className="sc-sl"><span className="t">Consignment · not owned, excluded from value</span><span className="ln" /></div>
                <div className="card" style={{ padding: "3px 12px" }}>
                  {bd.consignmentLots.map((l, i) => (
                    <LotCard key={l.id ?? `con|${l.warehouse_id}|${l.variant_key}|${l.batch_no ?? ""}|${i}`} l={l} consignment first={i === 0} />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        <div className="sc-sl"><span className="t">Movements{warehouseId ? " · filtered" : ""}</span><span className="ln" /></div>
        {movementsQ.isLoading ? (
          <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "20px 0" }}>Loading…</div>
        ) : movementsQ.error ? (
          <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "20px 0" }}>Couldn't load movements.</div>
        ) : rows.length === 0 ? (
          <div className="empty"><div className="empty-t">No movements yet.</div></div>
        ) : (
          <div className="card" style={{ padding: "4px 13px" }}>
            {rows.map((m) => {
              const pill = TYPE_PILL[m.movement_type];
              const sq = signedQty(m);
              return (
                <div key={m.id} className="sc-mv">
                  <span className={`sc-mp ${pill.cls}`}>{pill.label(m)}</span>
                  <div className="md">
                    <div className="dt tnum">{formatDate(m.created_at)}</div>
                    {/* An ADJUSTMENT has no source_doc_no, so the raw reason_code
                        (WRITEOFF / COUNT / DAMAGE / THEFT) was reaching the screen.
                        Desktop already labels it (StockAdjustments.tsx) — same
                        helper here so the two can't drift. */}
                    <div className="rf">
                      {m.source_doc_no ||
                        (m.reason_code ? adjustmentReasonLabel(m.reason_code) : "") ||
                        m.notes ||
                        "—"}
                    </div>
                    {/* Which warehouse the movement hit + its unit cost — desktop
                        shows both as columns; the money must be visible here too. */}
                    <div className="rf">
                      {whName(m.warehouse_id)}
                      {m.unit_cost_sen != null && m.unit_cost_sen > 0 ? ` · ${fmtCenti(m.unit_cost_sen)}` : ""}
                    </div>
                  </div>
                  <span className={`sc-mq tnum${sq < 0 ? " neg" : ""}`}>{sq > 0 ? `+${sq}` : sq}</span>
                  <span className="sc-mb tnum">{m.runningBalance}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {canTransfer && (
        <div className="actbar">
          <button className="btn" onClick={onNewTransfer}>New stock transfer</button>
        </div>
      )}
    </div>
  );
}

export default MobileStockCard;
