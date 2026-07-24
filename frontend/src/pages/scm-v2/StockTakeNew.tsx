// ----------------------------------------------------------------------------
// StockTakeNew — at /inventory/stock-takes/new (PR — Inv PR5).
//
// Step 1: pick Warehouse + Scope + Date + Notes. On Submit the server
// snapshots system_qty for every in-scope SKU and creates an OPEN stock
// take. We navigate to the detail page where commander enters counts.
// (PR-DRAFT-removal 2026-05-27: renamed DRAFT→OPEN per migration 0078.)
//
// HOUZS VENDOR — verbatim from apps/backend/src/pages/StockTakeNew.tsx.
// Import boundary only: react-router → react-router-dom; ConfirmDialog/
// NotifyDialog + useWarehouses ← vendored; balances/take hooks ← vendored
// stock-queries; mfg-products-queries via vendored slice; css colocated.
// Back/Cancel → list, Create → /scm/stock-takes/:id.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, X, ClipboardList } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useWarehouses } from '../../vendor/scm/lib/inventory-queries';
import { useInventoryBalances } from '../../vendor/scm/lib/stock-queries';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useMfgProducts } from '../../vendor/scm/lib/mfg-products-queries';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import {
  useCreateStockTake,
  type StockTakeScopeType,
} from '../../vendor/scm/lib/stock-queries';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const todayISO = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'BEDFRAME',  label: 'Bedframe'  },
  { value: 'MATTRESS',  label: 'Mattress'  },
  { value: 'SOFA',      label: 'Sofa'      },
  { value: 'ACCESSORY', label: 'Accessory' },
  { value: 'SERVICE',   label: 'Service'   },
];

export const StockTakeNew = () => {
  const navigate = useNavigate();
  const create   = useCreateStockTake();
  /* One key for the one take this page is open to raise (lib/idempotency.ts).
     Route-level form, navigates to the take detail on success, so the MOUNT is
     exactly one take. */
  const idemKey  = useIdempotencyKey();

  const askConfirm = useConfirm();
  const notify = useNotify();

  const [warehouseId, setWarehouseId] = useState<string>('');
  const [takeDate,    setTakeDate]    = useState<string>(todayISO());
  const [scopeType,   setScopeType]   = useState<StockTakeScopeType>('ALL');
  const [scopeValue,  setScopeValue]  = useState<string>('');
  const [notes,       setNotes]       = useState<string>('');

  const warehouses = useWarehouses();
  const allSkus    = useMfgProducts();

  // Live "expected count sheet size" — same query the server will use
  // (v_inventory_all_skus filtered by scope) so the commander sees a
  // realistic preview before clicking Create. Empty when no warehouse picked.
  const balances = useInventoryBalances({
    warehouseId: warehouseId || undefined,
    showAll:     true,
    category:    scopeType === 'CATEGORY' && scopeValue ? scopeValue : undefined,
  });

  const previewCount = useMemo(() => {
    if (!warehouseId) return 0;
    const list = balances.data?.balances ?? [];
    if (scopeType === 'CODE_PREFIX') {
      const p = scopeValue.trim().toUpperCase();
      if (!p) return list.length;
      return list.filter((b) => b.product_code.toUpperCase().startsWith(p)).length;
    }
    return list.length;
  }, [balances.data, scopeType, scopeValue, warehouseId]);

  // Suggested prefixes from the actual SKU master so the commander doesn't
  // have to remember every code shape. Top-3 most common 2-3 letter prefixes.
  const prefixOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const sku of allSkus.data ?? []) {
      const code = sku.code ?? '';
      const m = code.match(/^([A-Z]{2,3})/);
      const prefix = m?.[1];
      if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([p]) => p);
  }, [allSkus.data]);

  const needsScopeValue = scopeType === 'CATEGORY' || scopeType === 'CODE_PREFIX';
  const canCreate = Boolean(
    warehouseId &&
    takeDate &&
    (!needsScopeValue || scopeValue.trim()),
  );

  const onCreate = async () => {
    if (!canCreate) {
      notify({ title: 'Pick a warehouse, date, and (for Category/Prefix scopes) a scope value.', tone: 'error' });
      return;
    }
    if (previewCount === 0) {
      const proceed = await askConfirm({
        title: 'No SKUs match this scope at the chosen warehouse.',
        body: 'The count sheet will be empty. Continue?',
        confirmLabel: 'Create',
      });
      if (!proceed) return;
    }
    create.mutate(
      {
        idempotencyKey: idemKey,
        warehouseId,
        takeDate,
        scopeType,
        scopeValue: needsScopeValue ? scopeValue.trim() : null,
        notes:      notes.trim() || undefined,
      },
      {
        onSuccess: (res) => navigate(`/scm/stock-takes/${res.id}`),
        onError:   (err) => notify({ title: 'Create failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Warehouse"
        title="New Stock Take"
        actions={
          <>
            <div className={styles.actions}>
              <Button variant="ghost" size="md" onClick={() => navigate('/scm/stock-takes')}>
                <X {...ICON} /> Cancel
              </Button>
              <Button variant="primary" size="md" onClick={onCreate} disabled={create.isPending}>
                <Save {...ICON} />
                {create.isPending ? 'Snapshotting…' : 'Create Count Sheet'}
              </Button>
            </div>
          </>
        }
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Setup</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid4}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Warehouse *</span>
              <select
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                className={styles.fieldSelect}
              >
                <option value="">— Pick warehouse —</option>
                {sortByText(warehouses.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Take Date *</span>
              <input
                type="date"
                value={takeDate}
                onChange={(e) => setTakeDate(e.target.value)}
                className={styles.fieldInput}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Scope *</span>
              <select
                value={scopeType}
                onChange={(e) => {
                  setScopeType(e.target.value as StockTakeScopeType);
                  setScopeValue('');
                }}
                className={styles.fieldSelect}
              >
                <option value="ALL">All SKUs in warehouse</option>
                <option value="CATEGORY">By category</option>
                <option value="CODE_PREFIX">By code prefix</option>
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {scopeType === 'CATEGORY' ? 'Category *' :
                 scopeType === 'CODE_PREFIX' ? 'Code prefix *' :
                 'Scope value'}
              </span>
              {scopeType === 'CATEGORY' ? (
                <select
                  value={scopeValue}
                  onChange={(e) => setScopeValue(e.target.value)}
                  className={styles.fieldSelect}
                >
                  <option value="">— Pick category —</option>
                  {sortByText(CATEGORIES).map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              ) : scopeType === 'CODE_PREFIX' ? (
                <>
                  <input
                    type="text"
                    list="stk-prefix-suggestions"
                    value={scopeValue}
                    onChange={(e) => setScopeValue(e.target.value.toUpperCase())}
                    placeholder="e.g. BF, MAT, SOF…"
                    className={styles.fieldInput}
                    style={{ fontFamily: 'var(--font-mono)' }}
                  />
                  <datalist id="stk-prefix-suggestions">
                    {prefixOptions.map((p) => <option key={p} value={p} />)}
                  </datalist>
                </>
              ) : (
                <input
                  type="text"
                  value="(all SKUs)"
                  disabled
                  className={styles.fieldInput}
                  style={{ background: 'var(--c-cream)' }}
                />
              )}
            </label>
          </div>

          <div style={{ marginTop: 'var(--space-3)' }}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Notes</span>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Monthly cycle count · KL warehouse"
                className={styles.fieldInput}
              />
            </label>
          </div>

          <div style={{
            marginTop: 'var(--space-4)',
            padding: 'var(--space-3) var(--space-4)',
            background: 'var(--c-cream)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-md)',
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
          }}>
            <ClipboardList size={18} strokeWidth={1.75} style={{ color: 'var(--fg-muted)' }} />
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-ink)' }}>
              {!warehouseId ? (
                <span style={{ color: 'var(--fg-muted)' }}>
                  Pick a warehouse to preview the count sheet size.
                </span>
              ) : balances.isLoading ? (
                <span style={{ color: 'var(--fg-muted)' }}>Counting in-scope SKUs…</span>
              ) : (
                <>
                  Count sheet will contain{' '}
                  <strong style={{ fontFamily: 'var(--font-mono)' }}>
                    {previewCount.toLocaleString('en-MY')}
                  </strong>{' '}
                  SKU{previewCount === 1 ? '' : 's'} with their current system qty snapshotted.
                </>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
