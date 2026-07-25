// ----------------------------------------------------------------------------
// Currencies — the owner-maintained currency MASTER (backend Phase 1-A,
// migration 0082).
//
// The single source of truth for the currency dropdown list everywhere (GRN /
// Purchase Invoice / Payment Voucher) + each currency's current rate to MYR.
// Adding a currency here makes it selectable across the app with NO code change;
// GRN / PI / PV auto-fill their exchange rate from the rate set here.
//
// MYR is the base currency — its rate is fixed at 1 (a base-currency rate of 1
// is a no-op in the money path) and is read-only here.
//
// HOUZS VENDOR — verbatim from 2990's apps/backend/src/pages/Currencies.tsx.
// Import boundary only: currencies-queries / DataGrid / NotifyDialog →
// ../../vendor/scm/*. Gated by scm.currency.manage at the route (App.tsx) + nav.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useCurrencies,
  useCreateCurrency,
  useUpdateCurrency,
  type CurrencyRow,
} from '../../vendor/scm/lib/currencies-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRate = (raw: string | number): string => {
  const n = Number(raw);
  return Number.isFinite(n) ? n.toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 6 }) : '—';
};

export const Currencies = () => {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CurrencyRow | null>(null);
  const currencies = useCurrencies();

  const columns = useMemo<DataGridColumn<CurrencyRow>[]>(() => [
    {
      key: 'code',
      label: 'Code',
      width: 100,
      accessor: (r) => <span className={styles.codeChip}>{r.code}</span>,
      searchValue: (r) => r.code,
      filterValue: (r) => r.code,
      sortFn: (a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code),
    },
    {
      key: 'name',
      label: 'Name',
      width: 220,
      accessor: (r) => r.name,
      sortFn: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'symbol',
      label: 'Symbol',
      width: 90,
      accessor: (r) => r.symbol ?? '—',
    },
    {
      key: 'rate',
      label: 'Rate to MYR',
      width: 140,
      align: 'right',
      accessor: (r) => (
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          {r.code === 'MYR' ? '1 (base)' : fmtRate(r.rate_to_myr)}
        </span>
      ),
      sortFn: (a, b) => Number(a.rate_to_myr) - Number(b.rate_to_myr),
    },
    {
      key: 'status',
      label: 'Status',
      width: 110,
      accessor: (r) => (
        <span className={`${styles.statusPill} ${r.is_active ? styles.statusActive : styles.statusInactive}`}>
          {r.is_active ? 'Active' : 'Inactive'}
        </span>
      ),
      searchValue: (r) => (r.is_active ? 'Active' : 'Inactive'),
      filterValue: (r) => (r.is_active ? 'Active' : 'Inactive'),
      sortFn: (a, b) => Number(a.is_active) - Number(b.is_active),
    },
    {
      key: 'actions',
      label: '',
      width: 80,
      align: 'right',
      sortable: false,
      groupable: false,
      accessor: (r) => (
        <span onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" onClick={() => setEditing(r)}>Edit</Button>
        </span>
      ),
      searchValue: () => '',
    },
  ], []);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="Currencies"
        actions={
          <Button variant="primary" size="md" onClick={() => setCreating(true)}>
            <Plus {...ICON} />
            <span>Add Currency</span>
          </Button>
        }
      />

      <p className={styles.eyebrow} style={{ marginBottom: 'var(--space-3)' }}>
        The rate is MYR per 1 unit of the currency (e.g. RMB → MYR ≈ 0.62). MYR is the base — its rate is always 1.
        GRN, Purchase Invoice and Payment Voucher auto-fill their exchange rate from here.
      </p>

      <DataGrid
        rows={currencies.data ?? []}
        columns={columns}
        storageKey="dg-currencies"
        exportName="Currencies"
        rowKey={(r) => r.code}
        searchPlaceholder="Search code, name, symbol…"
        groupBanner={false}
        isLoading={currencies.isLoading}
        emptyMessage="No currencies yet."
      />

      {(creating || editing) && (
        <CurrencyDrawer
          editing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      )}
    </div>
  );
};

const CurrencyDrawer = ({
  editing, onClose,
}: {
  editing: CurrencyRow | null;
  onClose: () => void;
}) => {
  const create = useCreateCurrency();
  const update = useUpdateCurrency();
  const notify = useNotify();
  const isMyr = editing?.code === 'MYR';
  const [form, setForm] = useState({
    code: editing?.code ?? '',
    name: editing?.name ?? '',
    symbol: editing?.symbol ?? '',
    // Show the stored rate as a plain string for editing (numeric → string).
    rate: editing ? String(Number(editing.rate_to_myr)) : '1',
    isActive: editing?.is_active ?? true,
  });

  const submit = () => {
    const code = form.code.trim().toUpperCase();
    if (!editing && !/^[A-Z0-9]{2,8}$/.test(code)) {
      notify({ title: 'Code must be 2–8 letters/digits (e.g. EUR, GBP).', tone: 'error' });
      return;
    }
    if (!form.name.trim()) {
      notify({ title: 'Name is required.', tone: 'error' });
      return;
    }
    const rateNum = isMyr ? 1 : Number(form.rate);
    if (!isMyr && !(Number.isFinite(rateNum) && rateNum > 0)) {
      notify({ title: 'Rate to MYR must be a number greater than 0.', tone: 'error' });
      return;
    }

    if (editing) {
      update.mutate({
        code: editing.code,
        name: form.name.trim(),
        symbol: form.symbol.trim() || undefined,
        rateToMyr: rateNum,
        isActive: form.isActive,
      }, { onSuccess: onClose });
    } else {
      create.mutate({
        code,
        name: form.name.trim(),
        symbol: form.symbol.trim() || undefined,
        rateToMyr: rateNum,
      }, { onSuccess: onClose });
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>{editing ? `Edit ${editing.code}` : 'Add Currency'}</h2>
          <button type="button" onClick={onClose} className={styles.codeChip}>
            <X {...ICON} />
          </button>
        </div>
        <div className={styles.drawerBody}>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Code *</div>
            <input className={styles.searchInput} style={{ width: '100%' }}
              value={form.code} placeholder="RMB / USD / EUR" disabled={!!editing}
              onChange={(e) => setForm((s) => ({ ...s, code: e.target.value.toUpperCase() }))} />
          </label>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Name *</div>
            <input className={styles.searchInput} style={{ width: '100%' }}
              value={form.name} placeholder="Chinese Yuan (RMB)"
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))} />
          </label>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Symbol</div>
            <input className={styles.searchInput} style={{ width: '100%' }}
              value={form.symbol} placeholder="¥ / $ / RM"
              onChange={(e) => setForm((s) => ({ ...s, symbol: e.target.value }))} />
          </label>
          <label style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
            <div className={styles.eyebrow}>Rate to MYR {isMyr ? '(base — fixed at 1)' : '*'}</div>
            <input className={styles.searchInput} style={{ width: '100%' }} type="number"
              min="0" step="0.000001" inputMode="decimal"
              value={isMyr ? '1' : form.rate} disabled={isMyr}
              placeholder="0.62"
              onChange={(e) => setForm((s) => ({ ...s, rate: e.target.value }))} />
          </label>
          {editing && !isMyr && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={form.isActive}
                onChange={(e) => setForm((s) => ({ ...s, isActive: e.target.checked }))} />
              Active
            </label>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={create.isPending || update.isPending}>
            {(create.isPending || update.isPending) ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default Currencies;
