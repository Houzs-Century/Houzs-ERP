// ----------------------------------------------------------------------------
// Currencies — the owner-maintained currency MASTER (backend Phase 1-A,
// migration 0082), Finance › Setup › Currencies in the owner's Claude Design
// redesign (Finance-1a-Setup, batch 6 §6.4).
//
// The single source of truth for the currency dropdown list everywhere (GRN /
// Purchase Invoice / Payment Voucher) + each currency's current rate to MYR.
// Adding a currency here makes it selectable across the app with NO code change;
// GRN / PI / PV auto-fill their exchange rate from the rate set here.
//
// MYR is the base currency — its rate is fixed at 1 (a base-currency rate of 1
// is a no-op in the money path) and is read-only here.
//
// The list is the shared table: a double-click (or the row's ⋯ / right-click)
// opens Edit in a centred modal; New currency opens the same modal empty.
// Gated by scm.currency.manage at the route (App.tsx) + nav.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { MoreHorizontal, Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useCurrencies,
  useCreateCurrency,
  useUpdateCurrency,
  type CurrencyRow,
} from '../../vendor/scm/lib/currencies-queries';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { fmtDateOrDash } from '../../vendor/shared/format';
import { useToastOptional } from '../../hooks/useToast';
import { Check, Field, PopMenu, SetupModal, Tag } from './finance/SetupParts';
import sp from './finance/SetupParts.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtRate = (raw: string | number): string => {
  const n = Number(raw);
  return Number.isFinite(n) ? n.toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 6 }) : '—';
};

export const Currencies = () => {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CurrencyRow | null>(null);
  const [menu, setMenu] = useState<{ row: CurrencyRow; x: number; y: number } | null>(null);
  const currencies = useCurrencies();
  const rows = currencies.data ?? [];

  const columns = useMemo<Column<CurrencyRow>[]>(() => [
    {
      key: 'code', label: 'Code', width: '90px',
      render: (r) => <span className={sp.strong}>{r.code}</span>,
      getValue: (r) => r.code,
      sortCompare: (a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code),
    },
    { key: 'name', label: 'Name', render: (r) => r.name, getValue: (r) => r.name },
    { key: 'symbol', label: 'Symbol', width: '90px', render: (r) => <span className={sp.muted}>{r.symbol ?? '—'}</span>, getValue: (r) => r.symbol ?? '' },
    {
      key: 'rate', label: 'Rate to MYR', width: '130px', align: 'right',
      render: (r) => <span className={sp.num}>{r.code === 'MYR' ? '1 · base' : fmtRate(r.rate_to_myr)}</span>,
      getValue: (r) => Number(r.rate_to_myr),
      exportValue: (r) => Number(r.rate_to_myr),
    },
    {
      key: 'status', label: 'Status', width: '120px',
      render: (r) => (r.is_active ? <Tag tone="info">Active</Tag> : <Tag tone="calm">Not offered</Tag>),
      getValue: (r) => (r.is_active ? 'Active' : 'Not offered'),
    },
    {
      /* updated_at moves on ANY edit, not only the rate — so it reads Updated. */
      key: 'updated', label: 'Updated', width: '110px',
      render: (r) => <span className={sp.muted}>{fmtDateOrDash(r.updated_at)}</span>,
      getValue: (r) => r.updated_at,
      exportValue: (r) => fmtDateOrDash(r.updated_at),
    },
    {
      key: 'acts', label: '', width: '56px', align: 'right', disableSort: true, filterable: false,
      render: (r) => (
        <span className={sp.acts}>
          <button type="button" className={sp.more} aria-label={`More for ${r.code}`} title="Edit"
            onClick={(e) => { e.stopPropagation(); setMenu({ row: r, x: e.clientX, y: e.clientY }); }}
            onDoubleClick={(e) => e.stopPropagation()}>
            <MoreHorizontal size={14} />
          </button>
        </span>
      ),
    },
  ], []);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance · Setup"
        title="Currencies"
        description="The currency master and each currency’s rate to MYR"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus {...ICON} />
            <span>New currency</span>
          </Button>
        }
      />

      <section className={sp.card} aria-label="Currencies">
        <div className={sp.cardBody}>
          <DataTable<CurrencyRow>
            tableId="currencies"
            exportName="currencies"
            exportXlsx
            columns={columns}
            rows={currencies.isLoading ? null : rows}
            loading={currencies.isLoading}
            error={currencies.isError ? `The currencies could not be loaded — ${currencies.error instanceof Error ? currencies.error.message : 'try again.'}` : null}
            emptyLabel="No currency in the master yet — New currency adds one."
            getRowKey={(r) => r.code}
            defaultSort={(a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code)}
            onRowDoubleClick={(r) => setEditing(r)}
            contextMenu={(r) => [{ label: 'Edit', onClick: () => setEditing(r) }]}
            freezeHeight="off"
          />
        </div>
        <div className={sp.cardFoot}>
          The currency list every GRN, purchase invoice and payment voucher picks from, with each currency’s rate to MYR (MYR
          per 1 unit — RMB ≈ 0.62); those documents fill their rate from here. MYR is the base: its rate is fixed at 1. A new
          currency here is selectable everywhere at once.
        </div>
      </section>

      {menu && (
        <PopMenu x={menu.x} y={menu.y} label={`${menu.row.code} menu`} onClose={() => setMenu(null)}
          items={[{ label: 'Edit', onClick: () => setEditing(menu.row) }]} />
      )}

      {(creating || editing) && (
        <CurrencyForm
          editing={editing}
          taken={rows.map((r) => r.code)}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      )}
    </div>
  );
};

/* ── New currency / Edit <code> — the centred modal ─────────────────────── */
const CurrencyForm = ({
  editing, taken, onClose,
}: {
  editing: CurrencyRow | null;
  taken: string[];
  onClose: () => void;
}) => {
  const create = useCreateCurrency();
  const update = useUpdateCurrency();
  const toast = useToastOptional();
  const isMyr = editing?.code === 'MYR';
  const [form, setForm] = useState({
    code: editing?.code ?? '',
    name: editing?.name ?? '',
    symbol: editing?.symbol ?? '',
    // Show the stored rate as a plain string for editing (numeric → string).
    rate: editing ? String(Number(editing.rate_to_myr)) : '',
    isActive: editing?.is_active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => { setForm((s) => ({ ...s, ...patch })); setError(null); };

  const submit = () => {
    const code = form.code.trim().toUpperCase();
    if (!editing && !/^[A-Z0-9]{2,8}$/.test(code)) { setError('The code is 2–8 letters or digits, e.g. JPY.'); return; }
    if (!editing && taken.includes(code)) { setError(`${code} is already in the list.`); return; }
    if (!form.name.trim()) { setError('Name the currency.'); return; }
    const rateNum = isMyr ? 1 : Number(form.rate);
    if (!isMyr && !(Number.isFinite(rateNum) && rateNum > 0)) { setError('The rate must be more than 0.'); return; }

    if (editing) {
      update.mutate({
        code: editing.code,
        name: form.name.trim(),
        symbol: form.symbol.trim() || undefined,
        rateToMyr: rateNum,
        isActive: form.isActive,
      }, {
        onSuccess: () => { onClose(); toast?.success(`${editing.code} saved`); },
        onError: (e) => setError(e instanceof Error ? e.message : 'Not saved.'),
      });
    } else {
      create.mutate({
        code,
        name: form.name.trim(),
        symbol: form.symbol.trim() || undefined,
        rateToMyr: rateNum,
      }, {
        onSuccess: () => { onClose(); toast?.success(`${code} added · selectable on documents now`); },
        onError: (e) => setError(e instanceof Error ? e.message : 'Not added.'),
      });
    }
  };

  return (
    <SetupModal
      title={editing ? `Edit ${editing.code}` : 'New currency'}
      sub={editing
        ? (isMyr ? 'MYR is the base currency; its rate stays 1.' : 'GRN, purchase invoices and payment vouchers fill this rate from now.')
        : 'Selectable on every GRN, purchase invoice and payment voucher as soon as it is saved.'}
      okLabel={editing ? 'Save' : 'Add currency'}
      busyLabel="Saving…"
      busy={create.isPending || update.isPending}
      error={error}
      onOk={submit}
      onCancel={onClose}
    >
      {!editing && (
        <Field label="Code" w="22%">
          <input className={sp.input} aria-label="Currency code" value={form.code} placeholder="JPY"
            onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
        </Field>
      )}
      <Field label="Name" w={editing ? '64%' : '48%'}>
        <input className={sp.input} aria-label="Currency name" value={form.name} placeholder="Japanese Yen" onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Symbol" w={editing ? '32%' : '22%'}>
        <input className={sp.input} aria-label="Currency symbol" value={form.symbol} placeholder="¥" onChange={(e) => set({ symbol: e.target.value })} />
      </Field>
      {!isMyr && (
        <Field label="Rate to MYR" hint={`1 ${editing ? editing.code : form.code.trim().toUpperCase() || 'unit'} = this many ringgit`}>
          <input className={sp.input} aria-label="Rate to MYR" type="number" min="0" step="0.000001" inputMode="decimal"
            value={form.rate} placeholder="0.0294" onChange={(e) => set({ rate: e.target.value })} />
        </Field>
      )}
      {editing && !isMyr && (
        <Field label="Status" group>
          <Check checked={form.isActive} onChange={(isActive) => set({ isActive })}>Active · offered on documents</Check>
        </Field>
      )}
    </SetupModal>
  );
};

export default Currencies;
