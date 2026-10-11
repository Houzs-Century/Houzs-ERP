// ----------------------------------------------------------------------------
// StockCard — per-SKU drilldown at /inventory/stock-card/:productCode
// (Inv PR2). Optional ?warehouseId=… scopes the ledger + lots to one
// warehouse; otherwise we sum across all warehouses.
//
// Read-only — no new tables, no new API endpoints. Reuses:
//   useInventoryMovements({ productCode, warehouseId? })
//   useInventoryLots(productCode, { warehouseId?, includeClosed? })
//   useInventoryProductBreakdown(productCode) — per-warehouse balances
//
// Layout (full page, PurchaseOrderDetail chrome):
//   1. Header + back link
//   2. Stats: Total Qty · Warehouses · Last Movement · FIFO Value
//   3. Warehouse filter pills (when no ?warehouseId param)
//   4. Per-Warehouse Balance card (All-mode only)
//   5. Movements ledger w/ running balance (computed client-side)
//   6. FIFO Lots card (collapsible, "Show closed lots" toggle)
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Boxes, ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  useInventoryMovements,
  useInventoryLots,
  useInventoryProductBreakdown,
  useWarehouses,
  type InventoryMovement,
  type InventoryLot,
} from '../../vendor/scm/lib/inventory-queries';
import { adjustmentReasonLabel, fmtCenti, fmtDate, fmtDateTime, fmtQty } from '@2990s/shared';
import { DataTable, type Column } from '../../components/DataTable';
import styles from './Inventory.module.css';
import chrome from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (sen: number | null | undefined): string => fmtCenti(sen);

/** Best-effort route for a source doc on the ledger row. Inventory writes
 *  carry source_doc_id (the UUID of the originating GRN/DO/etc) — when
 *  present we can deep-link straight to the detail page. ADJUSTMENT has no
 *  per-document detail page, only a list — link there. */
const docHrefFor = (m: InventoryMovement): string | null => {
  switch (m.source_doc_type) {
    case 'GRN':              return m.source_doc_id ? `/scm/grns/${m.source_doc_id}` : null;
    case 'DO':               return m.source_doc_id ? `/mfg-delivery-orders/${m.source_doc_id}` : null;
    case 'DR':               return m.source_doc_id ? `/delivery-returns/${m.source_doc_id}` : null;
    case 'PURCHASE_RETURN':  return m.source_doc_id ? `/scm/purchase-returns/${m.source_doc_id}` : null;
    case 'STOCK_TRANSFER':   return m.source_doc_id ? `/scm/stock-transfers/${m.source_doc_id}` : null;
    case 'STOCK_TAKE':       return m.source_doc_id ? `/scm/stock-takes/${m.source_doc_id}` : null;
    case 'ADJUSTMENT':       return '/scm/stock-adjustments';
    default:                 return null;
  }
};

export const StockCard = () => {
  const { productCode = '' } = useParams<{ productCode: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const warehouseId = searchParams.get('warehouseId') || undefined;
  const [includeClosed, setIncludeClosed] = useState(false);
  const [lotsOpen, setLotsOpen] = useState(true);

  const warehousesQ = useWarehouses();
  const breakdownQ = useInventoryProductBreakdown(productCode || null);
  const movementsQ = useInventoryMovements({
    productCode: productCode || undefined,
    warehouseId,
  });
  const lotsQ = useInventoryLots(productCode || null, {
    warehouseId,
    includeClosed,
  });

  const warehouses = warehousesQ.data ?? [];
  const breakdownAll = (breakdownQ.data?.balances ?? []).filter((b) => b.product_code === productCode);
  // When filtered, only show the matching warehouse row in the summary stats.
  const breakdown = warehouseId
    ? breakdownAll.filter((b) => b.warehouse_id === warehouseId)
    : breakdownAll;

  // API returns DESC; reverse to ASC for running-balance accumulation, then
  // re-render DESC. Running balance is the cumulative qty *after* the row's
  // movement is applied. Reflects whatever scope the user is viewing (All
  // warehouses or one).
  // OUT rows store qty as a positive count but reduce on-hand; we subtract.
  // IN adds. ADJUSTMENT / TRANSFER carry a SIGNED qty (positive = found stock,
  // negative = write-off / transfer-out) — add as-is.
  const movementsDesc = useMemo(() => movementsQ.data ?? [], [movementsQ.data]);
  const movementsWithBalance = useMemo(() => {
    const asc = [...movementsDesc].slice().reverse();
    let running = 0;
    const out: Array<InventoryMovement & { runningBalance: number }> = [];
    for (const m of asc) {
      running += m.movement_type === 'OUT' ? -m.qty : m.qty;
      out.push({ ...m, runningBalance: running });
    }
    // newest-first render
    return out.reverse();
  }, [movementsDesc]);

  const lots: InventoryLot[] = lotsQ.data ?? [];

  /* Batch 2 — the Movements ledger renders through the shared DataTable
     (was DataGrid). Running Balance is precomputed per row above
     (chronological), so it stays correct no matter how the table re-sorts.
     The Per-Warehouse Balance and FIFO Lots cards stay as plain tables —
     small summary views with their own collapse toggle. */
  type MovementRow = InventoryMovement & { runningBalance: number };
  // SHORT code-name only ("KL WAREHOUSE") — the ONE canonical warehouse label
  // (owner 2026-07-24). Not a code+name concat, not the long `name`.
  const whName = useMemo(() => {
    const byId = new Map(warehouses.map((w) => [w.id, w.code]));
    return (id: string) => byId.get(id) ?? '—';
  }, [warehouses]);
  const movementColumns = useMemo<Column<MovementRow>[]>(() => {
    const signedQty = (m: MovementRow) => m.movement_type === 'OUT' ? -m.qty : m.qty;
    return [
      {
        key: 'date',
        label: 'Date',
        width: '130px',
        getValue: (m) => m.created_at ?? '',
        render: (m) => <span className={styles.numCellZero}>{fmtDateTime(m.created_at)}</span>,
      },
      {
        key: 'type',
        label: 'Type',
        width: '110px',
        getValue: (m) => m.movement_type,
        render: (m) => (
          <span className={`${styles.movementPill} ${
            m.movement_type === 'IN' ? styles.movementIn
            : m.movement_type === 'OUT' ? styles.movementOut
            : styles.movementAdj
          }`}>
            {m.movement_type === 'IN' && (
              <ArrowDownLeft size={11} strokeWidth={2} style={{ marginRight: 4 }} />
            )}
            {m.movement_type === 'OUT' && (
              <ArrowUpRight size={11} strokeWidth={2} style={{ marginRight: 4 }} />
            )}
            {m.movement_type}
          </span>
        ),
      },
      {
        key: 'sourceDoc',
        label: 'Source Doc',
        width: '130px',
        getValue: (m) => m.source_doc_no ?? '',
        render: (m) => {
          const href = docHrefFor(m);
          return m.source_doc_no ? (
            href ? (
              <Link to={href} className={styles.docLink}>{m.source_doc_no}</Link>
            ) : (
              <span className={styles.docLink}>{m.source_doc_no}</span>
            )
          ) : (
            <span className={styles.numCellZero}>—</span>
          );
        },
      },
      {
        key: 'warehouse',
        label: 'Warehouse',
        width: '150px',
        getValue: (m) => whName(m.warehouse_id),
        render: (m) => whName(m.warehouse_id),
      },
      {
        key: 'qty',
        label: 'Qty',
        width: '90px',
        align: 'right',
        getValue: (m) => signedQty(m),
        render: (m) => {
          const qtySign = m.movement_type === 'IN'
            ? '+'
            : m.movement_type === 'OUT'
              ? '−'
              : m.qty > 0 ? '+' : m.qty < 0 ? '−' : '';
          const qtyClass = m.qty > 0 ? styles.numCellPos
            : m.qty < 0 ? styles.numCellNeg
            : styles.numCellZero;
          return (
            <span className={`${styles.numCell} ${qtyClass}`}>
              {qtySign}{fmtQty(Math.abs(m.qty))}
            </span>
          );
        },
      },
      {
        key: 'unitCost',
        label: 'Unit Cost',
        width: '110px',
        align: 'right',
        getValue: (m) => (m.unit_cost_sen ?? 0) / 100,
        render: (m) => (
          <span className={`${styles.numCell} ${styles.numCellZero}`}>
            {m.unit_cost_sen && m.unit_cost_sen > 0 ? fmtRm(m.unit_cost_sen) : '—'}
          </span>
        ),
      },
      {
        key: 'running',
        label: 'Running Balance',
        width: '130px',
        align: 'right',
        getValue: (m) => m.runningBalance,
        render: (m) => (
          <span className={styles.numCell} style={{ fontWeight: 700 }}>
            {fmtQty(m.runningBalance)}
          </span>
        ),
      },
      {
        key: 'reason',
        label: 'Reason',
        width: '130px',
        // reason_code is set on ADJUSTMENT movements (and COUNT on stock-take
        // corrections); other movement types have none → '—'. The raw code
        // (WRITEOFF / DAMAGE …) is mapped to its plain label, matching mobile.
        getValue: (m) => (m.reason_code ? adjustmentReasonLabel(m.reason_code) : ''),
        render: (m) => (
          <span className={styles.numCellZero}>{m.reason_code ? adjustmentReasonLabel(m.reason_code) : '—'}</span>
        ),
      },
      {
        key: 'notes',
        label: 'Notes',
        width: '200px',
        getValue: (m) => m.notes ?? '',
        render: (m) => <span className={`${styles.numCellZero} ${styles.notesCell}`} title={m.notes ?? ''}>{m.notes ?? '—'}</span>,
      },
    ];
  }, [whName]);

  /* Loaded-only search over the ledger — the page filters (DataTable renders
     box + hint), matching the old DataGrid's built-in search fields. */
  const [movementSearch, setMovementSearch] = useState('');
  const visibleMovements = useMemo(() => {
    const term = movementSearch.trim().toLowerCase();
    if (!term) return movementsWithBalance;
    return movementsWithBalance.filter((m) =>
      `${fmtDateTime(m.created_at)} ${m.movement_type} ${m.source_doc_no ?? ''} ${whName(m.warehouse_id)} ${m.qty} ${m.reason_code ? adjustmentReasonLabel(m.reason_code) : ''} ${m.notes ?? ''}`
        .toLowerCase()
        .includes(term),
    );
  }, [movementsWithBalance, movementSearch, whName]);

  // ── Stats (always reflect the active warehouse filter) ────────────────
  const productName =
    breakdownAll[0]?.product_name ?? movementsDesc.find((m) => m.product_name)?.product_name ?? null;
  const totalQty = breakdown.reduce((s, b) => s + (b.qty ?? 0), 0);
  const warehouseCount = breakdown.filter((b) => (b.qty ?? 0) !== 0).length;
  const lastMovementAt = movementsDesc[0]?.created_at ?? null;
  const fifoValue = lots.reduce(
    (s, l) => s + l.qty_remaining * l.unit_cost_sen, 0,
  );

  return (
    <div className={chrome.page}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className={chrome.headerRow}>
        <div className={chrome.titleBlock}>
          <Link to="/scm/inventory" className={chrome.backBtn}>
            <ArrowLeft {...ICON} />
            <span>Inventory</span>
          </Link>
          <div>
            <h1 className={chrome.title}>
              <Boxes size={20} strokeWidth={1.75} style={{ color: 'var(--c-burnt)' }} />
              Stock Card · <span className={styles.codeChip} style={{ fontSize: 'var(--fs-18)' }}>{productCode}</span>
            </h1>
            <p className={chrome.subtitle}>
              {productName ?? 'No movements yet for this SKU.'}
              {warehouseId && warehouses.length > 0 && (() => {
                const w = warehouses.find((x) => x.id === warehouseId);
                return w ? ` · scoped to ${w.code}` : null;
              })()}
            </p>
          </div>
        </div>
      </div>

      {/* ── Stats ──────────────────────────────────────────────────────── */}
      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Current Qty</span>
          <span className={styles.statValue}>{fmtQty(totalQty)}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Warehouses</span>
          <span className={styles.statValue}>{warehouseCount}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>Last Movement</span>
          <span className={styles.statValue} style={{ fontSize: 'var(--fs-16)' }}>
            {lastMovementAt ? fmtDate(lastMovementAt) : '—'}
          </span>
          <span className={styles.statCaption}>{lastMovementAt ? fmtDateTime(lastMovementAt) : 'No activity yet'}</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statLabel}>FIFO Value</span>
          <span className={styles.statValue}>{fmtRm(fifoValue)}</span>
        </div>
      </div>

      {/* ── Warehouse filter pills (All-mode only — once a warehouse is
              picked, the per-warehouse breakdown card is hidden and the
              pills act as the navigation back to All). ────────────────── */}
      <div className={styles.warehouseChips}>
        <button
          type="button"
          className={styles.chip}
          data-active={!warehouseId}
          onClick={() => {
            const p = new URLSearchParams(searchParams);
            p.delete('warehouseId');
            setSearchParams(p, { replace: true });
          }}
        >
          All warehouses
        </button>
        {warehouses.map((w) => (
          <button
            key={w.id}
            type="button"
            className={styles.chip}
            data-active={warehouseId === w.id}
            onClick={() => {
              const p = new URLSearchParams(searchParams);
              p.set('warehouseId', w.id);
              setSearchParams(p, { replace: true });
            }}
          >
            {w.code}
          </button>
        ))}
      </div>

      {/* ── Per-Warehouse Balance (only in All mode) — shared DataTable,
          batch 2 of the SO-sample table unification (owner 2026-07-26). The
          section keeps its title line; the DataTable brings the SO card box,
          header theme, sort/filter/export for free. */}
      {!warehouseId && (
        <section>
          <header className={chrome.cardHeader}>
            <h2 className={chrome.cardTitle}>Per-Warehouse Balance</h2>
          </header>
          <DataTable<(typeof breakdownAll)[number]>
            tableId="stock-card-warehouse-balance"
            layoutFamily="stock-card-warehouse-balance"
            exportName="warehouse-balance"
            rows={breakdownQ.isLoading ? null : breakdownAll}
            loading={breakdownQ.isLoading}
            emptyLabel="No warehouse balances for this SKU."
            getRowKey={(b) => b.warehouse_id}
            columns={[
              {
                key: 'warehouse_code', label: 'Warehouse Code', width: '140px',
                getValue: (b) => b.warehouse_code ?? '',
                render: (b) => <span className={styles.codeChip}>{b.warehouse_code ?? '—'}</span>,
              },
              {
                key: 'warehouse_name', label: 'Warehouse Name',
                getValue: (b) => b.warehouse_name ?? '',
                render: (b) => b.warehouse_name ?? '—',
              },
              {
                key: 'qty', label: 'Qty On Hand', align: 'right', width: '120px',
                getValue: (b) => b.qty,
                render: (b) => (
                  <span className={`${styles.numCell} ${b.qty > 0 ? styles.numCellPos : b.qty < 0 ? styles.numCellNeg : styles.numCellZero}`}>
                    {fmtQty(b.qty)}
                  </span>
                ),
              },
              {
                key: 'value', label: 'Value', align: 'right', width: '130px',
                getValue: (b) => (b.value_sen ?? 0) / 100,
                render: (b) => (
                  <span className={`${styles.numCell} ${styles.numCellZero}`}>
                    {b.value_sen && b.value_sen > 0 ? fmtRm(b.value_sen) : '—'}
                  </span>
                ),
              },
            ] satisfies Column<(typeof breakdownAll)[number]>[]}
          />
        </section>
      )}

      {/* ── Movements ledger ───────────────────────────────────────────── */}
      <section className={chrome.card}>
        <header className={chrome.cardHeader}>
          <h2 className={chrome.cardTitle}>
            Movements ({movementsWithBalance.length}{warehouseId ? ' · filtered' : ''})
          </h2>
        </header>
        {!movementsQ.isLoading && movementsQ.error ? (
          <div className={styles.bannerWarn} style={{ margin: 'var(--space-3)' }}>
            <strong>Failed to load.</strong>{' '}
            {movementsQ.error instanceof Error
              ? movementsQ.error.message
              : String(movementsQ.error)}
          </div>
        ) : (
          <DataTable<MovementRow>
            tableId="stockcard-movements"
            layoutFamily="stockcard-movements"
            exportName="stock-card-movements"
            rows={movementsQ.isLoading ? null : visibleMovements}
            loading={movementsQ.isLoading}
            emptyLabel="No movements for this SKU yet."
            getRowKey={(m) => m.id}
            columns={movementColumns}
            search={{
              value: movementSearch,
              onChange: setMovementSearch,
              placeholder: 'Search movements…',
            }}
          />
        )}
      </section>

      {/* ── FIFO Lots ──────────────────────────────────────────────────── */}
      <section className={chrome.card}>
        <header
          className={chrome.cardHeader}
          style={{ cursor: 'pointer' }}
          onClick={() => setLotsOpen((v) => !v)}
        >
          <h2 className={chrome.cardTitle} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {lotsOpen ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
            FIFO Lots ({lots.length}{includeClosed ? ' · incl closed' : ' · open only'})
          </h2>
          <label
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 'var(--fs-13)', fontFamily: 'var(--font-sans)',
              color: 'var(--c-ink)', cursor: 'pointer',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={includeClosed}
              onChange={(e) => setIncludeClosed(e.target.checked)}
            />
            Show closed lots
          </label>
        </header>
        {lotsOpen && (
          <DataTable<InventoryLot>
            tableId="stock-card-fifo-lots"
            layoutFamily="stock-card-fifo-lots"
            exportName="fifo-lots"
            rows={lotsQ.isLoading ? null : lots}
            loading={lotsQ.isLoading}
            emptyLabel={includeClosed ? 'No lots ever recorded for this SKU.' : 'No open lots — toggle "Show closed lots" to see consumed ones.'}
            getRowKey={(l) => l.id}
            getRowClassName={(l) => (l.qty_remaining === 0 ? 'opacity-50' : undefined)}
            columns={[
              {
                key: 'received_at', label: 'Received At', width: '160px',
                getValue: (l) => l.received_at,
                render: (l) => <span className={styles.numCellZero}>{fmtDateTime(l.received_at)}</span>,
              },
              {
                key: 'source_doc', label: 'Source Doc', width: '150px',
                getValue: (l) => l.source_doc_no ?? '',
                render: (l) => l.source_doc_no
                  ? <span className={styles.docLink}>{l.source_doc_no}</span>
                  : <span className={styles.numCellZero}>—</span>,
              },
              {
                key: 'warehouse', label: 'Warehouse', width: '110px',
                getValue: (l) => l.warehouse_code ?? '',
                render: (l) => l.warehouse_code ?? '—',
              },
              {
                key: 'qty_received', label: 'Qty Received', align: 'right', width: '110px',
                getValue: (l) => l.qty_received,
                render: (l) => <span className={`${styles.numCell} ${styles.numCellZero}`}>{fmtQty(l.qty_received)}</span>,
              },
              {
                key: 'qty_remaining', label: 'Qty Remaining', align: 'right', width: '130px',
                getValue: (l) => l.qty_remaining,
                render: (l) => {
                  const closed = l.qty_remaining === 0;
                  return (
                    <span className={`${styles.numCell} ${closed ? styles.numCellZero : styles.numCellPos}`}>
                      {fmtQty(l.qty_remaining)}
                      {closed && (
                        <span style={{ marginLeft: 6, fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', fontWeight: 500 }}>closed</span>
                      )}
                    </span>
                  );
                },
              },
              {
                key: 'unit_cost', label: 'Unit Cost', align: 'right', width: '110px',
                getValue: (l) => l.unit_cost_sen / 100,
                render: (l) => <span className={`${styles.numCell} ${styles.numCellZero}`}>{fmtRm(l.unit_cost_sen)}</span>,
              },
              {
                key: 'remaining_value', label: 'Remaining Value', align: 'right', width: '140px',
                getValue: (l) => (l.remaining_value_sen ?? l.qty_remaining * l.unit_cost_sen) / 100,
                render: (l) => {
                  const remainingValue = l.remaining_value_sen ?? l.qty_remaining * l.unit_cost_sen;
                  return (
                    <span className={styles.numCell} style={{ fontWeight: 700 }}>
                      {remainingValue > 0 ? fmtRm(remainingValue) : '—'}
                    </span>
                  );
                },
              },
            ] satisfies Column<InventoryLot>[]}
          />
        )}
      </section>
    </div>
  );
};
