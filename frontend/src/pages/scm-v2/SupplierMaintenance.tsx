// ----------------------------------------------------------------------------
// SupplierMaintenance — Finance › Money out › Supplier Maintenance (owner
// 2026-10-02, after 「我之前不是说要有吗？」 — he asked on 09-29 for supplier
// maintenance on the Finance side, 「类似 ap invoice 这样」):
//   A1  the list lives in Money out's sidebar, named Supplier Maintenance;
//   A2a a supplier Finance opens here is Finance's alone — purchasing never sees
//       it — until Finance ticks 「采购也用」;
//   A3a the supplier's bank, kept with the Finance part and carried into the
//       AP Payment that pays it.
// One row per supplier, purchasing's and Finance's own, with what the books say
// is owed to it; a row pops the supplier out like an AP invoice: the Finance
// part, the purchasing part, its open invoices, advances, credit left and the
// latest payments. Server: backend/src/scm/routes/supplier-maintenance.ts
// (reads); a save goes to /suppliers, which owns the rules.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useSupplierMaintenance, useSupplierMaintenanceDetail, useCreateMaintainedSupplier, useUpdateMaintainedSupplier,
  supplierBankLine, type SupplierMaintenanceBody, type SupplierMaintenanceDetail, type SupplierMaintenanceRow,
} from '../../vendor/scm/lib/supplier-maintenance-queries';
import type { SupplierRow } from '../../vendor/scm/lib/suppliers-queries';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { Modal } from '../../vendor/scm/components/Modal';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { fmtDateOrDash, fmtSen } from '../../vendor/shared/format';
import { humaniseStatusKey } from '../../vendor/scm/lib/status-pill';
import styles from './SalesOrderDetail.module.css';

type ChipKey = 'all' | 'trade' | 'other' | 'missing' | 'financeOnly' | 'inactive';
const CHIPS: Array<[ChipKey, string]> = [
  ['all', '全部 · All'], ['trade', 'Trade 400'], ['other', 'Other creditor 405'],
  ['missing', '缺 TIN / 注册号'], ['financeOnly', 'Finance only'], ['inactive', 'Inactive'],
];
const inChip = (r: SupplierMaintenanceRow, k: ChipKey): boolean => {
  if (k === 'trade') return r.controlKind === 'TRADE';
  if (k === 'other') return r.controlKind === 'OTHER';
  if (k === 'missing') return r.missingTax === true;
  if (k === 'financeOnly') return r.forPurchasing === false;
  if (k === 'inactive') return r.status !== 'ACTIVE';
  return true;
};

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)' };
const right: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const chip = (on: boolean): React.CSSProperties => ({
  padding: '4px 10px', borderRadius: 999, fontSize: 'var(--fs-12)', cursor: 'pointer',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  background: on ? 'var(--c-ink)' : 'transparent', color: on ? 'var(--c-cream)' : 'var(--c-ink)',
});
const th: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'left', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em',
  textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'middle', borderBottom: '1px solid var(--border-weak, #efede6)' };
const tag = (bg: string, fg: string): React.CSSProperties => ({ fontSize: 'var(--fs-11)', padding: '1px 6px', borderRadius: 6, background: bg, color: fg, whiteSpace: 'nowrap' });
const TAG_OK = tag('#e6f2e6', '#2f6b2f');
const TAG_MISSING = tag('#fbe9e7', '#a5321f');
const TAG_INFO = tag('#e8eef7', '#2c4f7c');

const Meta = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div>
    <div style={soft}>{label}</div>
    <div style={{ fontSize: 'var(--fs-13)' }}>{value}</div>
  </div>
);
const dash = (v: unknown) => (String(v ?? '').trim() ? String(v) : '—');

export const SupplierMaintenance = () => {
  const q = useSupplierMaintenance();
  const finance = q.data?.finance === true;
  const [chipKey, setChipKey] = useState<ChipKey>('all');
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get('open');
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('open', id); else next.delete('open');
    setSearchParams(next, { replace: true });
  };
  const [form, setForm] = useState<null | { mode: 'new' } | { mode: 'edit'; supplier: SupplierRow }>(null);

  const all = useMemo(() => q.data?.rows ?? [], [q.data]);
  const rows = useMemo(() => all.filter((r) => inChip(r, chipKey)), [all, chipKey]);
  const counts = useMemo(() => Object.fromEntries(CHIPS.map(([k]) => [k, all.filter((r) => inChip(r, k)).length])) as Record<ChipKey, number>, [all]);

  const columns = useMemo<Column<SupplierMaintenanceRow>[]>(() => [
    { key: 'code', label: 'Code', render: (r) => <span style={mono}>{r.code}</span>, getValue: (r) => r.code },
    {
      key: 'name', label: 'Name',
      render: (r) => <span>{r.name}{r.forPurchasing === false ? <> <span style={TAG_INFO}>Finance only</span></> : null}</span>,
      getValue: (r) => r.name,
    },
    { key: 'control', label: 'Control', render: (r) => (r.controlKind === 'OTHER' ? 'Other 405' : 'AP 400'), getValue: (r) => r.controlCode },
    { key: 'terms', label: 'Terms', render: (r) => dash(r.paymentTerms), getValue: (r) => r.paymentTerms ?? '' },
    ...(finance ? [
      {
        key: 'tax', label: 'TIN / 注册号',
        render: (r: SupplierMaintenanceRow) => (r.missingTax ? <span style={TAG_MISSING}>缺</span> : <span style={TAG_OK}>有</span>),
        getValue: (r: SupplierMaintenanceRow) => (r.missingTax ? 'missing' : 'ok'),
      },
      {
        key: 'bank', label: 'Bank',
        render: (r: SupplierMaintenanceRow) => supplierBankLine({ bank_name: r.bankName, bank_account_no: r.bankAccountNo, bank_account_name: null }) ?? <span style={soft}>—</span>,
        getValue: (r: SupplierMaintenanceRow) => supplierBankLine({ bank_name: r.bankName, bank_account_no: r.bankAccountNo, bank_account_name: r.bankAccountName }) ?? '',
      },
    ] as Column<SupplierMaintenanceRow>[] : []),
    {
      key: 'owed', label: 'Owed', align: 'right',
      render: (r) => <span style={{ fontWeight: r.owedSen > 0 ? 600 : 400 }}>{fmtSen(r.owedSen)}</span>,
      getValue: (r) => r.owedSen, exportValue: (r) => r.owedSen / 100, exportFormat: 'money',
    },
    {
      key: 'advance', label: '预付未冲', align: 'right',
      render: (r) => (r.advanceSen > 0 ? fmtSen(r.advanceSen) : <span style={soft}>—</span>),
      getValue: (r) => r.advanceSen, exportValue: (r) => r.advanceSen / 100, exportFormat: 'money',
    },
    { key: 'open', label: 'Open bills', align: 'right', render: (r) => (r.openInvoices > 0 ? r.openInvoices : <span style={soft}>—</span>), getValue: (r) => r.openInvoices },
    { key: 'status', label: 'Status', render: (r) => <span style={{ fontSize: 'var(--fs-11)' }}>{humaniseStatusKey(r.status)}</span>, getValue: (r) => r.status },
  ], [finance]);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Money out"
        title="Supplier Maintenance · 供应商"
        actions={finance ? (
          <Button variant="primary" size="sm" onClick={() => setForm({ mode: 'new' })}>
            <Plus size={16} strokeWidth={1.75} /> New supplier
          </Button>
        ) : undefined}
      />
      <section className={styles.card}>
        <div className={styles.cardHeader} style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {CHIPS.filter(([k]) => finance || (k !== 'missing' && k !== 'financeOnly')).map(([k, label]) => (
              <button key={k} type="button" style={chip(chipKey === k)} aria-pressed={chipKey === k} onClick={() => setChipKey(k)}>
                {label} · {counts[k]}
              </button>
            ))}
          </div>
          <span style={soft}>Owed = the supplier&apos;s balance in the books, after payments, advances and credit notes.</span>
        </div>
        <div className={styles.cardBody} style={{ overflowX: 'auto' }}>
          <DataTable<SupplierMaintenanceRow>
            tableId="supplier-maintenance"
            exportName="supplier-maintenance"
            exportXlsx
            columns={columns}
            rows={q.data ? rows : null}
            loading={q.isLoading}
            error={q.isError ? `The suppliers could not be loaded — ${q.error instanceof Error ? q.error.message : 'something went wrong.'}` : null}
            emptyLabel={all.length > 0 ? 'No supplier in this view — pick another filter.' : 'No supplier yet — New supplier opens one.'}
            getRowKey={(r) => r.id}
            getRowStyle={(r) => (r.status !== 'ACTIVE' ? { opacity: 0.55 } : undefined)}
            onRowClick={(r) => setOpen(r.id)}
          />
        </div>
      </section>

      {openId && (
        <SupplierPopOut
          id={openId}
          finance={finance}
          onClose={() => setOpen(null)}
          onEdit={(supplier) => setForm({ mode: 'edit', supplier })}
        />
      )}

      {form && (
        <Modal
          title={form.mode === 'new' ? 'New supplier · 新供应商' : `Edit ${form.supplier.code} · ${form.supplier.name}`}
          onClose={() => setForm(null)}
          width="min(860px, 100%)"
          ariaLabel={form.mode === 'new' ? 'New supplier' : `Edit ${form.supplier.code}`}
        >
          <SupplierForm
            key={form.mode === 'new' ? 'new' : form.supplier.id}
            supplier={form.mode === 'edit' ? form.supplier : null}
            onDone={(id) => { setForm(null); if (id) setOpen(id); }}
            onCancel={() => setForm(null)}
          />
        </Modal>
      )}
    </div>
  );
};

/* ── The supplier, popped out over the list ──────────────────────────────── */
const SupplierPopOut = ({ id, finance, onClose, onEdit }: {
  id: string; finance: boolean; onClose: () => void; onEdit: (s: SupplierRow) => void;
}) => {
  const q = useSupplierMaintenanceDetail(id);
  const d = q.data;
  const s = d?.supplier;
  return (
    <Modal
      title={s ? `${s.code} · ${s.name}` : 'Supplier'}
      onClose={onClose}
      ariaLabel={s ? `Supplier ${s.code}` : 'Supplier'}
      actions={s && finance ? <Button variant="secondary" size="sm" onClick={() => onEdit(s)}>Edit</Button> : undefined}
    >
      {q.isLoading && <div style={soft} role="status">Loading the supplier…</div>}
      {q.isError && <div role="alert" style={{ color: 'var(--c-festive-b, #B8331F)' }}>The supplier could not be loaded — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</div>}
      {d && s && <SupplierDetailBody d={d} s={s} finance={finance} />}
    </Modal>
  );
};

const SupplierDetailBody = ({ d, s, finance }: { d: SupplierMaintenanceDetail; s: SupplierRow; finance: boolean }) => {
  const preErp = d.openInvoices.filter((i) => i.preErp).reduce((n, i) => n + i.outstandingMyrSen, 0);
  const advanceLeft = d.advances.reduce((n, a) => n + a.leftSen, 0);
  const creditLeft = d.credits.reduce((n, c) => n + c.leftSen, 0);
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--space-3)' };
  const h3: React.CSSProperties = { margin: 'var(--space-4) 0 var(--space-2)', fontSize: 'var(--fs-13)', fontWeight: 600 };
  return (
    <div>
      <div style={{ ...grid, background: 'var(--c-cream, #f7f5ef)', borderRadius: 8, padding: '10px 12px' }}>
        <Meta label={`Owed — the books (${d.controlCode})`} value={<strong>{fmtSen(d.balanceSen)}</strong>} />
        <Meta label="预付未冲 · Advance unspent" value={advanceLeft > 0 ? fmtSen(advanceLeft) : '—'} />
        <Meta label="CN 未冲 · Credit left" value={creditLeft > 0 ? fmtSen(creditLeft) : '—'} />
        {preErp > 0 && <Meta label="AutoCount bills not in the books" value={fmtSen(preErp)} />}
      </div>

      {finance && (
        <>
          <h3 style={h3}>Finance · 财务资料</h3>
          <div style={grid}>
            <Meta label="Credit Account (code)" value={<span style={mono}>{s.code}</span>} />
            <Meta label="Control account" value={<span style={mono}>{d.controlCode}</span>} />
            <Meta label="TIN Number" value={dash(s.tin_number)} />
            <Meta label="Business Reg No" value={dash(s.business_reg_no)} />
            <Meta label="Registration No." value={dash(s.registration_no)} />
            <Meta label="Exemption No." value={dash(s.exemption_no)} />
            <Meta label="Credit limit" value={s.credit_limit_sen ? fmtSen(s.credit_limit_sen) : '—'} />
            <Meta label="Statement type" value={dash(s.statement_type ? humaniseStatusKey(s.statement_type) : null)} />
            <Meta label="Aging basis" value={dash(s.aging_basis ? humaniseStatusKey(s.aging_basis) : null)} />
            <Meta label="Bank · 银行" value={dash(s.bank_name)} />
            <Meta label="Account no. · 户口号码" value={<span style={mono}>{dash(s.bank_account_no)}</span>} />
            <Meta label="Account name · 户口名字" value={dash(s.bank_account_name)} />
            <Meta label="采购也用 · Purchasing" value={s.for_purchasing === false ? <span style={TAG_INFO}>Finance only — purchasing does not see it</span> : 'Yes — shared with purchasing'} />
          </div>
        </>
      )}

      <h3 style={h3}>Purchasing · 采购资料</h3>
      <div style={grid}>
        <Meta label="Contact person" value={dash(s.contact_person)} />
        <Meta label="Phone" value={dash(s.phone)} />
        <Meta label="Email" value={dash(s.email)} />
        <Meta label="Currency" value={s.currency} />
        <Meta label="Payment terms" value={dash(s.payment_terms)} />
        <Meta label="Status" value={humaniseStatusKey(s.status)} />
        <Meta label="Billing address" value={dash(s.address)} />
      </div>

      <h3 style={h3}>Open bills · 未付的单 ({d.openInvoices.length})</h3>
      {d.openInvoices.length === 0 ? <div style={soft}>Nothing owing on a bill.</div> : (
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
          <thead><tr>
            <th style={th}>No.</th><th style={th}>Date</th><th style={th}>Due</th><th style={th}>Supplier ref</th>
            <th style={{ ...th, ...right }}>Total</th><th style={{ ...th, ...right }}>Outstanding (RM)</th>
          </tr></thead>
          <tbody>
            {d.openInvoices.map((i) => (
              <tr key={`${i.kind}-${i.id}`}>
                <td style={td}>
                  <Link to={i.kind === 'PI' ? `/scm/purchase-invoices/${i.id}` : `/scm/ap-invoices?open=${encodeURIComponent(i.id)}`} style={{ ...mono, color: 'var(--c-orange)' }}>{i.number}</Link>
                  {i.kind === 'API' ? <> <span style={TAG_INFO}>AP</span></> : null}
                  {i.preErp ? <> <span style={tag('#fdf2df', '#8a5a12')}>AutoCount</span></> : null}
                </td>
                <td style={td}>{fmtDateOrDash(i.date)}</td>
                <td style={td}>{fmtDateOrDash(i.dueDate)}</td>
                <td style={td}>{dash(i.supplierRef)}</td>
                <td style={{ ...td, ...right }}>{i.currency !== 'MYR' ? `${i.currency} ` : ''}{fmtSen(i.totalSen)}</td>
                <td style={{ ...td, ...right, fontWeight: 600 }}>{fmtSen(i.outstandingMyrSen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(d.advances.length > 0 || d.credits.length > 0) && (
        <>
          <h3 style={h3}>Not yet knocked off · 未冲</h3>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
            <tbody>
              {d.advances.map((a) => (
                <tr key={`adv-${a.pvId}`}>
                  <td style={td}><Link to={`/scm/payment-vouchers/${a.pvId}`} style={{ ...mono, color: 'var(--c-orange)' }}>{a.pvNumber}</Link> <span style={soft}>· advance (预付)</span></td>
                  <td style={td}>{fmtDateOrDash(a.date)}</td>
                  <td style={{ ...td, ...right }}>{fmtSen(a.leftSen)}</td>
                </tr>
              ))}
              {d.credits.map((n) => (
                <tr key={`cn-${n.id}`}>
                  <td style={td}><span style={mono}>{n.noteNumber}</span> <span style={soft}>· credit note left</span></td>
                  <td style={td}>{fmtDateOrDash(n.date)}</td>
                  <td style={{ ...td, ...right }}>{fmtSen(n.leftSen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3 style={h3}>Latest payments · 最近付款</h3>
      {d.payments.length === 0 ? <div style={soft}>No voucher has paid this supplier yet.</div> : (
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
          <thead><tr><th style={th}>Voucher</th><th style={th}>Date</th><th style={th}>Status</th><th style={{ ...th, ...right }}>Amount (RM)</th></tr></thead>
          <tbody>
            {d.payments.map((p) => (
              <tr key={p.id} style={p.status === 'CANCELLED' ? { opacity: 0.55 } : undefined}>
                <td style={td}><Link to={`/scm/payment-vouchers/${p.id}`} style={{ ...mono, color: 'var(--c-orange)' }}>{p.pvNumber ?? 'Draft voucher'}</Link></td>
                <td style={td}>{fmtDateOrDash(p.date)}</td>
                <td style={td}>{humaniseStatusKey(p.status)}</td>
                <td style={{ ...td, ...right }}>{fmtSen(p.totalMyrSen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

/* ── New / Edit — Finance's form: the Finance part, the bank, and the purchasing
   essentials. The currency and the full address stay on purchasing's supplier
   page (a PO is priced in the supplier's currency); a supplier opened here is
   MYR, which is all an AP invoice takes. ──────────────────────────────────── */
type FormState = {
  code: string; name: string; status: string; forPurchasing: boolean;
  tinNumber: string; businessRegNo: string; registrationNo: string; exemptionNo: string;
  creditLimitSen: number | null; statementType: string; agingBasis: string;
  bankName: string; bankAccountNo: string; bankAccountName: string;
  paymentTerms: string; contactPerson: string; phone: string; email: string; address: string; notes: string;
};
/** The form's plain text fields — what the one-line field helper edits. */
type TextKey = { [K in keyof FormState]: FormState[K] extends string ? K : never }[keyof FormState];

const fromSupplier = (s: SupplierRow | null): FormState => ({
  code: s?.code ?? '', name: s?.name ?? '', status: s?.status ?? 'ACTIVE',
  /* A supplier Finance opens here is Finance's alone until ticked (A2a). */
  forPurchasing: s ? s.for_purchasing !== false : false,
  tinNumber: s?.tin_number ?? '', businessRegNo: s?.business_reg_no ?? '', registrationNo: s?.registration_no ?? '', exemptionNo: s?.exemption_no ?? '',
  creditLimitSen: s?.credit_limit_sen ?? null, statementType: s?.statement_type ?? 'OPEN_ITEM', agingBasis: s?.aging_basis ?? 'INVOICE_DATE',
  bankName: s?.bank_name ?? '', bankAccountNo: s?.bank_account_no ?? '', bankAccountName: s?.bank_account_name ?? '',
  paymentTerms: s?.payment_terms ?? '', contactPerson: s?.contact_person ?? '',
  phone: s?.phone ?? '', email: s?.email ?? '', address: s?.address ?? '', notes: s?.notes ?? '',
});

/** A code that names neither control posts to trade creditors (400-0000). */
export const codeNote = (code: string): string | null => {
  const c = code.trim();
  if (!c) return null;
  if (c.startsWith('405-')) return 'Other creditor — posts to 405-0000.';
  if (c.startsWith('400-')) return 'Trade creditor — posts to 400-0000.';
  return 'This code starts with neither 400- nor 405-, so it posts to trade creditors (400-0000). An other creditor\'s code starts 405-; the bank account goes in the Bank fields, not here.';
};

const SupplierForm = ({ supplier, onDone, onCancel }: {
  supplier: SupplierRow | null; onDone: (id: string | null) => void; onCancel: () => void;
}) => {
  const create = useCreateMaintainedSupplier();
  const update = useUpdateMaintainedSupplier();
  const [f, setF] = useState<FormState>(() => fromSupplier(supplier));
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  const saving = create.isPending || update.isPending;
  const note = codeNote(f.code);

  const field = (label: string, k: TextKey, opts: { placeholder?: string; full?: boolean; mono?: boolean } = {}) => (
    <label className={styles.field} style={opts.full ? { gridColumn: '1 / -1' } : undefined}>
      <span className={styles.fieldLabel}>{label}</span>
      <input className={styles.fieldInput} value={f[k]} placeholder={opts.placeholder} aria-label={label}
        style={opts.mono ? mono : undefined}
        onChange={(e) => set(k, e.target.value)} />
    </label>
  );
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-3)' };
  const h3: React.CSSProperties = { margin: 'var(--space-3) 0 var(--space-2)', fontSize: 'var(--fs-13)', fontWeight: 600 };

  const submit = async () => {
    if (!f.code.trim() || !f.name.trim()) { setProblem('A supplier needs its code (the AutoCount creditor no.) and its name.'); return; }
    setProblem(null);
    const body: SupplierMaintenanceBody = {
      name: f.name.trim(), status: f.status, forPurchasing: f.forPurchasing,
      tinNumber: f.tinNumber.trim() || null, businessRegNo: f.businessRegNo.trim() || null,
      registrationNo: f.registrationNo.trim() || null, exemptionNo: f.exemptionNo.trim() || null,
      creditLimitSen: f.creditLimitSen ?? 0, statementType: f.statementType, agingBasis: f.agingBasis,
      bankName: f.bankName, bankAccountNo: f.bankAccountNo, bankAccountName: f.bankAccountName,
      paymentTerms: f.paymentTerms.trim() || null, contactPerson: f.contactPerson.trim() || null,
      phone: f.phone.trim() || null, email: f.email.trim() || null, address: f.address.trim() || null, notes: f.notes.trim() || null,
    };
    try {
      if (supplier) {
        /* The code goes only when it changed — the server refuses a change once
           documents or the ledger carry the old one. */
        const code = f.code.trim();
        const res = await update.mutateAsync({ id: supplier.id, ...body, ...(code !== supplier.code ? { code } : {}) });
        onDone(res.supplier.id);
      } else {
        const res = await create.mutateAsync({ ...body, code: f.code.trim() });
        onDone(res.supplier.id);
      }
    } catch {
      /* The mutation's own dialog says why; the form stays open. */
    }
  };

  return (
    <div>
      <h3 style={h3}>Identity</h3>
      <div style={grid}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Credit Account (code) *</span>
          <input className={styles.fieldInput} value={f.code} placeholder="405-T001" aria-label="Credit Account (code)" style={mono}
            onChange={(e) => set('code', e.target.value)} />
          {note && <span style={{ ...soft, color: note.startsWith('This code') ? '#8a5a12' : undefined }}>{note}</span>}
        </label>
        {field('Company name *', 'name')}
        {supplier && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Status</span>
            <select className={styles.fieldInput} value={f.status} aria-label="Status" onChange={(e) => set('status', e.target.value)}>
              <option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="BLOCKED">Blocked</option>
            </select>
          </label>
        )}
        <label className={styles.field} style={{ alignSelf: 'end' }}>
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-13)' }}>
            <input type="checkbox" checked={f.forPurchasing} aria-label="采购也用 · Purchasing uses it too" onChange={(e) => set('forPurchasing', e.target.checked)} />
            采购也用 · Purchasing uses it too
          </span>
          <span style={soft}>{f.forPurchasing ? 'Purchasing sees this supplier.' : 'Finance only — purchasing does not see it.'}</span>
        </label>
      </div>

      <h3 style={h3}>Finance · 财务资料</h3>
      <div style={grid}>
        {field('TIN Number', 'tinNumber')}
        {field('Business Reg No', 'businessRegNo')}
        {field('Registration No.', 'registrationNo')}
        {field('Exemption No.', 'exemptionNo')}
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Credit limit (RM)</span>
          <MoneyInput bare valueSen={f.creditLimitSen} allowBlank inputClassName={styles.fieldInput} placeholder="0.00" aria-label="Credit limit (RM)"
            onCommit={(sen) => set('creditLimitSen', sen)} />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Statement type</span>
          <select className={styles.fieldInput} value={f.statementType} aria-label="Statement type" onChange={(e) => set('statementType', e.target.value)}>
            <option value="OPEN_ITEM">Open item</option><option value="BALANCE_FORWARD">Balance forward</option><option value="NO_STATEMENT">No statement</option>
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Aging basis</span>
          <select className={styles.fieldInput} value={f.agingBasis} aria-label="Aging basis" onChange={(e) => set('agingBasis', e.target.value)}>
            <option value="INVOICE_DATE">Invoice date</option><option value="DUE_DATE">Due date</option>
          </select>
        </label>
      </div>

      <h3 style={h3}>Bank · 银行（付款时带出来）</h3>
      <div style={grid}>
        {field('Bank', 'bankName', { placeholder: 'Maybank' })}
        {field('Account no.', 'bankAccountNo', { mono: true })}
        {field('Account name', 'bankAccountName')}
      </div>

      <h3 style={h3}>Purchasing · 采购资料</h3>
      <div style={grid}>
        {field('Payment terms', 'paymentTerms', { placeholder: '30 days' })}
        {field('Contact person', 'contactPerson')}
        {field('Phone', 'phone')}
        {field('Email', 'email')}
        {field('Billing address', 'address', { full: true })}
        {field('Notes', 'notes', { full: true })}
      </div>

      {problem && <div role="alert" style={{ marginTop: 'var(--space-3)', color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-13)' }}>{problem}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={() => void submit()} disabled={saving}>{saving ? 'Saving…' : supplier ? 'Save' : 'Create supplier'}</Button>
      </div>
    </div>
  );
};
