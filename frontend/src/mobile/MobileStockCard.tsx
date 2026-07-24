import { useMemo, useState } from "react";
import { adjustmentReasonLabel, formatVariantKey } from "@2990s/shared";
import { fmtCenti } from "../lib/scm";
import { formatDate } from "../lib/utils";
import {
  useInventoryMovements,
  useInventoryProductBreakdown,
  useInventoryLots,
  useWarehouses,
  type InventoryMovement,
  type InventoryLot,
} from "../vendor/scm/lib/inventory-queries";

/* ------------------------------------------------------------------ *
 * Mobile Stock Card — per-SKU on-hand, per-(warehouse × variant) split,
 * the movement ledger (each row carries its warehouse + unit cost and a
 * client-computed running balance) and the FIFO lots + value. Phone twin
 * of desktop pages/scm-v2/StockCard.tsx; reuses the SAME shared hooks
 * (useInventoryProductBreakdown / useInventoryMovements / useInventoryLots /
 * useWarehouses). A warehouse filter (pills) scopes the whole card, exactly
 * as the desktop ?warehouseId param does. No backend. Opened from the
 * Inventory list (MobileApp routes an inventory row here).
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
  const [includeClosed, setIncludeClosed] = useState(false);

  const warehousesQ = useWarehouses();
  const breakdownQ = useInventoryProductBreakdown(productCode);
  const movementsQ = useInventoryMovements({ productCode, warehouseId });
  const lotsQ = useInventoryLots(productCode, { warehouseId, includeClosed });

  const warehouses = warehousesQ.data ?? [];
  // Movements carry only warehouse_id; map it to the SHORT code-name ("KL
  // WAREHOUSE") the desktop Warehouse column now shows — the ONE canonical
  // warehouse label (owner 2026-07-24), not a code+name concat.
  const whName = (id: string) => {
    const w = warehouses.find((x) => x.id === id);
    return w ? w.code : "—";
  };
  const selectedWh = warehouseId ? warehouses.find((w) => w.id === warehouseId) ?? null : null;

  const balances = useMemo(
    () => (breakdownQ.data?.balances ?? []).filter((b) => b.product_code === productCode),
    [breakdownQ.data, productCode],
  );
  // On-hand reflects the active warehouse filter (all warehouses when none).
  const onHand = useMemo(
    () =>
      balances
        .filter((b) => !warehouseId || b.warehouse_id === warehouseId)
        .reduce((s, b) => s + (b.qty ?? 0), 0),
    [balances, warehouseId],
  );

  // FIFO value = every open lot's remaining qty × unit cost, over the active
  // warehouse scope (the lots query already applies warehouseId). Mirrors the
  // desktop StockCard stat so a SKU's money is visible on the phone too.
  const lots: InventoryLot[] = lotsQ.data ?? [];
  const fifoValue = useMemo(
    () => lots.reduce((s, l) => s + l.qty_remaining * l.unit_cost_sen, 0),
    [lots],
  );

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
          <div className="l">On hand · {selectedWh ? selectedWh.code : "all warehouses"}</div>
          <div className="v tnum">{onHand} <span className="u">units</span></div>
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
            FIFO value · <span className="tnum">{fmtCenti(fifoValue)}</span>
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

        {/* Per-(warehouse × variant) split — one cell per real stock bucket
            (migration 0095). Keying by warehouse_id ALONE collided two variants
            of one warehouse onto a duplicate React key and two identical rows;
            the composite key + Attributes label keeps them distinct. Shown in
            All mode only, like the desktop per-warehouse card. */}
        {!warehouseId && balances.length > 0 && (
          <>
            <div className="sc-sl"><span className="t">Per warehouse</span><span className="ln" /></div>
            <div className="sc-whgrid">
              {balances.map((b) => {
                const attrs = formatVariantKey(b.variant_key, b.fabric_supplier_code);
                return (
                  <div key={`${b.warehouse_id}|${b.variant_key ?? ""}`}>
                    <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                      <span className="wn" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {b.warehouse_code || b.warehouse_name || "—"}
                      </span>
                      {attrs && (
                        <span
                          style={{
                            fontSize: 9.5,
                            fontWeight: 600,
                            color: "var(--mut)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {attrs}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, flex: "none" }}>
                      <span className="wq tnum">{b.qty ?? 0}</span>
                      {b.value_sen != null && b.value_sen > 0 && (
                        <span className="tnum" style={{ fontSize: 10, fontWeight: 700, color: "var(--mut)" }}>
                          {fmtCenti(b.value_sen)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
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

        {/* FIFO Lots — the open lots (oldest first) that the next OUT consumes,
            with each lot's remaining value. "Show closed" reveals fully-consumed
            lots so the whole FIFO consumption order is visible. Mirrors desktop. */}
        <div className="sc-sl">
          <span className="t">FIFO Lots</span>
          <span className="ln" />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 10,
              fontWeight: 700,
              color: "var(--mut2)",
              whiteSpace: "nowrap",
            }}
          >
            <input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} />
            Show closed
          </label>
        </div>
        {lotsQ.isLoading ? (
          <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "20px 0" }}>Loading…</div>
        ) : lotsQ.error ? (
          <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "20px 0" }}>Couldn't load lots.</div>
        ) : lots.length === 0 ? (
          <div className="empty">
            <div className="empty-t">
              {includeClosed ? "No lots recorded for this SKU." : "No open lots — turn on Show closed to see consumed ones."}
            </div>
          </div>
        ) : (
          <div className="card" style={{ padding: "4px 13px" }}>
            {lots.map((l, i) => {
              const closed = l.qty_remaining === 0;
              // Prefer the server's remaining value; fall back to qty × cost
              // exactly as desktop StockCard does (never a fake 0).
              const remainingValue = l.remaining_value_sen ?? l.qty_remaining * l.unit_cost_sen;
              return (
                <div
                  key={l.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    padding: "9px 2px",
                    borderTop: i === 0 ? "none" : "1px solid var(--line2)",
                    opacity: closed ? 0.55 : 1,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                    <span className="tnum" style={{ fontSize: 11.5, fontWeight: 800, color: "var(--ink)" }}>
                      {formatDate(l.received_at)}
                    </span>
                    <span className="tnum" style={{ fontSize: 12.5, fontWeight: 800, color: "var(--ink)" }}>
                      {remainingValue > 0 ? fmtCenti(remainingValue) : "—"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10, color: "var(--mut)" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {l.source_doc_no || "—"}{l.warehouse_code ? ` · ${l.warehouse_code}` : ""}
                    </span>
                    <span className="tnum" style={{ flex: "none" }}>
                      {l.qty_remaining} of {l.qty_received} · {fmtCenti(l.unit_cost_sen)}{closed ? " · closed" : ""}
                    </span>
                  </div>
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
