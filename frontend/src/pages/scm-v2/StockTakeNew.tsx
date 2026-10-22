// ----------------------------------------------------------------------------
// StockTakeNew — at /inventory/stock-takes/new (PR — Inv PR5).
//
// Step 1: pick Warehouse + Assignee + Scope + Date + Notes (+ Blind). On
// Submit the server snapshots system_qty for every in-scope SKU and creates
// an OPEN stock take. We navigate to the detail page where commander enters
// counts. (PR-DRAFT-removal 2026-05-27: renamed DRAFT→OPEN per mig 0078.)
//
// Round 1 (owner 2026-10-06): ASSIGNEES — everyone counting, at least one — are
// a record, not a post gate. "Only SKUs with stock" is a tick box (on by
// default) that combines with Category / Prefix. The BLIND toggle hides system
// qty / variance from the counter until posted. To split
// one warehouse count across people, create several takes with a CATEGORY /
// prefix scope, each with its own assignee — the scope mechanism IS the
// sub-sheet mechanism, no extra data model needed.
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
import { usePickableStaff } from '../../vendor/scm/lib/admin-queries';
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
import { DateField } from "../../vendor/scm/components/DateField";
import { StaffMultiPick } from '../../vendor/scm/components/StaffMultiPick';

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
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [takeDate,    setTakeDate]    = useState<string>(todayISO());
  const [scopeType,   setScopeType]   = useState<StockTakeScopeType>('ALL');
  const [scopeValue,  setScopeValue]  = useState<string>('');
  const [notes,       setNotes]       = useState<string>('');
  const [blind,       setBlind]       = useState<boolean>(false);
  /* Owner 2026-10-06: a zero-qty line is not worth a row — on by default, and
     it combines with Category / Prefix (it used to be a scope of its own). */
  const [nonzeroOnly, setNonzeroOnly] = useState<boolean>(true);

  const warehouses = useWarehouses();
  const allSkus    = useMfgProducts();
  /* Assignee options: the ACTIVE company's staff (the pickable list, not the
     display roster) — the person responsible must be someone here and now. */
  const pickableStaff = usePickableStaff();

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
    /* Same approximation for "only SKUs with stock": the server resolves
       per-variant buckets; here we count SKUs whose balance ≠ 0 so the sheet
       visibly shrinks before Create. */
    const inScope = scopeType === 'CODE_PREFIX' && scopeValue.trim()
      ? list.filter((b) => b.item_code.toUpperCase().startsWith(scopeValue.trim().toUpperCase()))
      : list;
    return nonzeroOnly || scopeType === 'NONZERO'
      ? inScope.filter((b) => Number(b.qty ?? 0) !== 0).length
      : inScope.length;
  }, [balances.data, scopeType, scopeValue, warehouseId, nonzeroOnly]);

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
    assigneeIds.length > 0 &&
    takeDate &&
    (!needsScopeValue || scopeValue.trim()),
  );

  const onCreate = async () => {
    if (!canCreate) {
      notify({ title: 'Pick a warehouse, assignee, date, and (for Category/Prefix scopes) a scope value.', tone: 'error' });
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
        assigneeStaffIds: assigneeIds,
        nonzeroOnly,
        takeDate,
        scopeType,
        scopeValue: needsScopeValue ? scopeValue.trim() : null,
        notes:      notes.trim() || undefined,
        blind,
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

            <div className={styles.field}>
              <span className={styles.fieldLabel}>Assignees *</span>
              {/* Who is counting — often two or three people (owner
                  2026-10-06). A record; it does not decide who may post. */}
              <StaffMultiPick
                label="Add assignee"
                options={pickableStaff.data ?? []}
                value={assigneeIds}
                onChange={setAssigneeIds}
                nameOf={(id) => {
                  const s = (pickableStaff.data ?? []).find((x) => x.id === id);
                  return s?.name || s?.staffCode || id;
                }}
                disabled={false}
              />
            </div>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Take Date *</span>
              <DateField fullWidth value={takeDate} onChange={(iso) => setTakeDate(iso)} className={styles.fieldInput}/>
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

          <div style={{ marginTop: 'var(--space-3)' }}>
            <label style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              fontSize: 'var(--fs-13)', color: 'var(--c-ink)', cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={nonzeroOnly}
                onChange={(e) => setNonzeroOnly(e.target.checked)}
              />
              <span>
                <strong>Only SKUs with stock</strong>
                {' '}— leave lines whose system qty is 0 off the sheet (stock found that the system
                does not list goes in with Add line)
              </span>
            </label>
          </div>

          {/* Blind count (phase 1): the counter works without seeing what the
              system expects — the honest way to count. Server-enforced: while
              OPEN, system qty + variance are stripped from the wire for
              everyone except stock-take supervisors. */}
          <div style={{ marginTop: 'var(--space-3)' }}>
            <label style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              fontSize: 'var(--fs-13)', color: 'var(--c-ink)', cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={blind}
                onChange={(e) => setBlind(e.target.checked)}
              />
              <span>
                <strong>Blind count</strong>
                {' '}— hide system qty and variance from the counter until this take is posted
                (supervisors can still see them)
              </span>
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
