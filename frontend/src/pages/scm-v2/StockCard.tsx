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
import { adjustmentReasonLabel, fmtCenti, fmtDate as fmtDateShared, fmtQty } from '@2990s/shared';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import styles from './Inventory.module.css';
import chrome from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRm = (sen: number | null | undefined): string => fmtCenti(sen);

const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const date = fmtDateShared(d);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
};

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return fmtDateShared(d);
};

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

  /* DataGrid conversion (dg-inventory rollout) — the Movements ledger renders
     through the shared grid. Running Balance is precomputed per row above
     (chronological), so it stays correct no matter how the grid re-sorts.
     The Per-Warehouse Balance and FIFO Lots cards stay as plain tables —
     small summary views with their own collapse toggle. */
  type MovementRow = InventoryMovement & { runningBalance: number };
  const movementColumns = useMemo<DataGridColumn<MovementRow>[]>(() => {
    // SHORT code-name only ("KL WAREHOUSE") — the ONE canonical warehouse label
    // (owner 2026-07-24). Not a code+name concat, not the long `name`.
    const whName = (id: string) => {
      const wh = warehouses.find((w) => w.id === id);
      return wh ? wh.code : '—';
    };
    const signedQty = (m: MovementRow) => m.movement_type === 'OUT' ? -m.qty : m.qty;
    return [
      {
        key: 'date',
        label: 'Date',
        width: 130,
        accessor: (m) => <span className={styles.numCellZero}>{fmtDateTime(m.created_at)}</span>,
        searchValue: (m) => fmtDateTime(m.created_at),
        filterValue: (m) => fmtDateTime(m.created_at),
        sortFn: (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''),
      },
      {
        key: 'type',
        label: 'Type',
        width: 110,
        accessor: (m) => (
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
        searchValue: (m) => m.movement_type,
        filterValue: (m) => m.movement_type,
        sortFn: (a, b) => (a.movement_type ?? '').localeCompare(b.movement_type ?? ''),
      },
      {
        key: 'sourceDoc',
        label: 'Source Doc',
        width: 130,
        accessor: (m) => {
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
        searchValue: (m) => m.source_doc_no ?? '',
        filterValue: (m) => m.source_doc_no ?? '—',
        sortFn: (a, b) => (a.source_doc_no ?? '').localeCompare(b.source_doc_no ?? ''),
      },
      {
        key: 'warehouse',
        label: 'Warehouse',
        width: 150,
        accessor: (m) => whName(m.warehouse_id),
        searchValue: (m) => whName(m.warehouse_id),
        filterValue: (m) => whName(m.warehouse_id),
      },
      {
        key: 'qty',
        label: 'Qty',
        width: 90,
        align: 'right',
        accessor: (m) => {
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
        searchValue: (m) => String(m.qty),
        filterValue: (m) => String(m.qty),
        sortFn: (a, b) => signedQty(a) - signedQty(b),
      },
      {
        key: 'unitCost',
        label: 'Unit Cost',
        width: 110,
        align: 'right',
        accessor: (m) => (
          <span className={`${styles.numCell} ${styles.numCellZero}`}>
            {m.unit_cost_sen && m.unit_cost_sen > 0 ? fmtRm(m.unit_cost_sen) : '—'}
          </span>
        ),
        searchValue: () => '',
        filterValue: (m) => m.unit_cost_sen && m.unit_cost_sen > 0 ? fmtRm(m.unit_cost_sen) : '—',
        sortFn: (a, b) => (a.unit_cost_sen ?? 0) - (b.unit_cost_sen ?? 0),
      },
      {
        key: 'running',
        label: 'Running Balance',
        width: 130,
        align: 'right',
        accessor: (m) => (
          <span className={styles.numCell} style={{ fontWeight: 700 }}>
            {fmtQty(m.runningBalance)}
          </span>
        ),
        searchValue: (m) => String(m.runningBalance),
        filterValue: (m) => String(m.runningBalance),
        sortFn: (a, b) => a.runningBalance - b.runningBalance,
      },
      {
        key: 'reason',
        label: 'Reason',
        width: 130,
        // reason_code is set on ADJUSTMENT movements (and COUNT on stock-take
        // corrections); other movement types have none → '—'. The raw code
        // (WRITEOFF / DAMAGE …) is mapped to its plain label, matching mobile.
        accessor: (m) => (
          <span className={styles.numCellZero}>{m.reason_code ? adjustmentReasonLabel(m.reason_code) : '—'}</span>
        ),
        searchValue: (m) => (m.reason_code ? adjustmentReasonLabel(m.reason_code) : ''),
        filterValue: (m) => (m.reason_code ? adjustmentReasonLabel(m.reason_code) : '—'),
      },
      {
        key: 'notes',
        label: 'Notes',
        width: 200,
        accessor: (m) => <span className={`${styles.numCellZero} ${styles.notesCell}`} title={m.notes ?? ''}>{m.notes ?? '—'}</span>,
        searchValue: (m) => m.notes ?? '',
        filterValue: (m) => m.notes ?? '—',
      },
    ];
  }, [warehouses]);

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

      {/* ── Per-Warehouse Balance card (only in All mode) ──────────────── */}
      {!warehouseId && (
        <section className={chrome.card}>
          <header className={chrome.cardHeader}>
            <h2 className={chrome.cardTitle}>Per-Warehouse Balance</h2>
          </header>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Warehouse Code</th>
                <th>Warehouse Name</th>
                <th style={{ textAlign: 'right' }}>Qty On Hand</th>
                <th style={{ textAlign: 'right' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {breakdownQ.isLoading && (
                <tr><td colSpan={4} className={styles.emptyRow}>Loading…</td></tr>
              )}
              {!breakdownQ.isLoading && breakdownAll.length === 0 && (
                <tr><td colSpan={4} className={styles.emptyRow}>No warehouse balances for this SKU.</td></tr>
              )}
              {!breakdownQ.isLoading && breakdownAll.map((b) => {
                const qtyClass = b.qty > 0 ? styles.numCellPos
                  : b.qty < 0 ? styles.numCellNeg
                  : styles.numCellZero;
                return (
                  <tr key={b.warehouse_id}>
                    <td><span className={styles.codeChip}>{b.warehouse_code ?? '—'}</span></td>
                    <td>{b.warehouse_name ?? '—'}</td>
                    <td className={`${styles.numCell} ${qtyClass}`}>
                      {fmtQty(b.qty)}
                    </td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>
                      {b.value_sen && b.value_sen > 0 ? fmtRm(b.value_sen) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
          <DataGrid<MovementRow>
            rows={movementsWithBalance}
            columns={movementColumns}
            storageKey="dg-stockcard-movements"
            rowKey={(m) => m.id}
            searchPlaceholder="Search movements…"
            groupBanner={false}
            isLoading={movementsQ.isLoading}
            emptyMessage="No movements for this SKU yet."
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
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Received At</th>
                <th>Source Doc</th>
                <th>Warehouse</th>
                <th style={{ textAlign: 'right' }}>Qty Received</th>
                <th style={{ textAlign: 'right' }}>Qty Remaining</th>
                <th style={{ textAlign: 'right' }}>Unit Cost</th>
                <th style={{ textAlign: 'right' }}>Remaining Value</th>
              </tr>
            </thead>
            <tbody>
              {lotsQ.isLoading && (
                <tr><td colSpan={7} className={styles.emptyRow}>Loading lots…</td></tr>
              )}
              {!lotsQ.isLoading && lots.length === 0 && (
                <tr><td colSpan={7} className={styles.emptyRow}>
                  {includeClosed ? 'No lots ever recorded for this SKU.' : 'No open lots — toggle "Show closed lots" to see consumed ones.'}
                </td></tr>
              )}
              {!lotsQ.isLoading && lots.map((l) => {
                const closed = l.qty_remaining === 0;
                const remainingValue =
                  l.remaining_value_sen ?? l.qty_remaining * l.unit_cost_sen;
                return (
                  <tr key={l.id} style={closed ? { opacity: 0.55 } : undefined}>
                    <td className={styles.numCellZero}>{fmtDateTime(l.received_at)}</td>
                    <td>
                      {l.source_doc_no
                        ? <span className={styles.docLink}>{l.source_doc_no}</span>
                        : <span className={styles.numCellZero}>—</span>}
                    </td>
                    <td>{l.warehouse_code ?? '—'}</td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>
                      {fmtQty(l.qty_received)}
                    </td>
                    <td className={`${styles.numCell} ${closed ? styles.numCellZero : styles.numCellPos}`}>
                      {fmtQty(l.qty_remaining)}
                      {closed && (
                        <span style={{
                          marginLeft: 6, fontSize: 'var(--fs-11)',
                          color: 'var(--fg-muted)', fontWeight: 500,
                        }}>closed</span>
                      )}
                    </td>
                    <td className={`${styles.numCell} ${styles.numCellZero}`}>{fmtRm(l.unit_cost_sen)}</td>
                    <td className={`${styles.numCell}`} style={{ fontWeight: 700 }}>
                      {remainingValue > 0 ? fmtRm(remainingValue) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};
