// ----------------------------------------------------------------------------
// RECONCILIATION SETUP — one screen, every company.
//
// The owner, 2026-08-18: "我记得我说我这个自动对账要做成每个公司都能用，无论是
// merchant recon还是bank recon。具体怎样应该是我会overall 维护，然后在维护那边选
// 这个公司是使用哪里几个 merchant，然后他有什么bank。可能是以勾选的方式选择？"
//
// So: pick a company at the top, tick what it uses underneath. He does not have
// to switch the top bar to set up the other company, and a company nobody has
// set up yet shows every merchant unticked instead of an empty screen.
//
// What is shared and what is not, made structural rather than explained:
//
//   • HOW a merchant's report reads (format, unique reference, fee, headings)
//     is taught ONCE and every company uses it — his standing principle;
//   • WHICH merchants a company uses, and WHICH of its banks each pays into,
//     is that company's own (PBB pays Houzs into Maybank and 2990 into Hong
//     Leong);
//   • the BANKS themselves are the chart of accounts, which is already
//     maintained centrally — his own answer: "chart of account 我也是会做成总维护
//     不是？" — so this screen ticks which of them a company banks with rather
//     than inventing a second bank master to drift from the first.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import {
  useSettlementMaintenance, useSaveMaintenanceMerchant, useSaveMaintenanceBank,
  useSaveAcquirerSetup,
  type MaintenanceMerchant, type MaintenanceBank,
} from './settlement-queries';
import {
  ICON, btn, cell, num, table, headRow, rowLine, softText, danger, good, refusalText,
} from './settlement-ui';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';

export const SettlementSetup = () => {
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const q = useSettlementMaintenance(companyId);
  const data = q.data;

  const merchants = data?.merchants ?? [];
  const banks = data?.bankAccounts ?? [];
  /* The company actually being shown — the server answers with it, so a first
     load (no companyId yet) still knows which company it is talking about. */
  const shownId = data?.companyId ?? null;
  const open = merchants.find((m) => m.code === editing) ?? null;

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Reconciliation setup" />

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 'var(--fs-13)', fontWeight: 600 }} htmlFor="setup-company">Company</label>
        <select id="setup-company" aria-label="Company" style={{ padding: '6px 10px', fontSize: 'var(--fs-13)' }}
          value={shownId ?? ''} onChange={(e) => { setCompanyId(Number(e.target.value)); setEditing(null); }}>
          {(data?.companies ?? []).map((co) => <option key={co.id} value={co.id}>{co.name}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <Link to="/scm/merchant-recon" style={{ ...btn(), textDecoration: 'none' }}>
          <ArrowLeft {...ICON} /> Merchant reconciliation
        </Link>
      </div>

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}

      {open && shownId != null
        ? <MerchantForm merchant={open} onDone={() => setEditing(null)} />
        : shownId != null && (
          <>
            <MerchantTicks companyId={shownId} merchants={merchants} banks={banks} onEdit={setEditing} />
            <BankTicks companyId={shownId} banks={banks} />
          </>
        )}
    </div>
  );
};

/* ── Which merchants this company uses, and where each pays ───────────────── */

const MerchantTicks = ({ companyId, merchants, banks, onEdit }: {
  companyId: number; merchants: MaintenanceMerchant[]; banks: MaintenanceBank[]; onEdit: (code: string) => void;
}) => {
  const save = useSaveMaintenanceMerchant();
  const usable = banks.filter((b) => b.enabled);

  return (
    <section className="space-y-2">
      <b>Which merchants does this company use?</b>
      <table style={table}>
        <thead>
          <tr style={headRow}>
            <th style={cell}>Use</th>
            <th style={cell}>Merchant</th>
            <th style={cell}>Money lands in</th>
            <th style={cell}>Report</th>
            <th style={cell} />
          </tr>
        </thead>
        <tbody>
          {merchants.map((m) => (
            <tr key={m.code} style={rowLine}>
              <td style={cell}>
                <input type="checkbox" checked={m.enabled} aria-label={`Use ${m.code}`}
                  onChange={(e) => save.mutate({ companyId, code: m.code, enabled: e.target.checked })} />
              </td>
              <td style={cell}>
                <b>{m.display_name}</b>{' '}
                {m.code !== m.display_name && <span className={styles.codeChip}>{m.code}</span>}
              </td>
              <td style={cell}>
                {/* Off = no bank to choose. A merchant this company does not use
                    has no money to land anywhere. */}
                <select style={{ padding: '4px 8px', fontSize: 'var(--fs-13)', minWidth: 190 }}
                  aria-label={`${m.code} bank account`} disabled={!m.enabled}
                  value={m.bank_account_code ?? ''}
                  onChange={(e) => save.mutate({ companyId, code: m.code, bankAccountCode: e.target.value || null })}>
                  <option value="">not set</option>
                  {usable.map((b) => (
                    <option key={b.account_code} value={b.account_code}>{b.account_name}</option>
                  ))}
                </select>
                {m.enabled && !m.bank_account_code && (
                  <div style={{ fontSize: 'var(--fs-12)', color: danger }}>will use the company default</div>
                )}
              </td>
              <td style={{ ...cell, color: m.ready ? undefined : danger }}>
                {m.ready
                  ? <>{m.statement_format} · {m.autoMatchable ? 'matches by reference' : 'by hand, always'}</>
                  : 'not taught yet'}
              </td>
              <td style={cell}>
                <button type="button" style={btn()} onClick={() => onEdit(m.code)}>Report layout</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={softText}>
        The report layout is taught once and every company uses it. The tick and the bank are this company&rsquo;s own.
      </div>
    </section>
  );
};

/* ── Which banks this company has ─────────────────────────────────────────── */

const BankTicks = ({ companyId, banks }: { companyId: number; banks: MaintenanceBank[] }) => {
  const save = useSaveMaintenanceBank();

  return (
    <section className="space-y-2">
      <b>Which banks does this company have?</b>
      {banks.length === 0 && (
        <div style={{ fontSize: 'var(--fs-13)', color: danger }}>
          This company has no money accounts in its chart yet — add them in Accounting first.
        </div>
      )}
      {banks.length > 0 && (
        <table style={table}>
          <thead>
            <tr style={headRow}>
              <th style={cell}>Has</th><th style={cell}>Account</th><th style={num}>Code</th>
              <th style={cell}>Used by</th>
            </tr>
          </thead>
          <tbody>
            {banks.map((b) => (
              <tr key={b.account_code} style={rowLine}>
                <td style={cell}>
                  <input type="checkbox" checked={b.enabled} aria-label={`Has ${b.account_code}`}
                    onChange={(e) => save.mutate({ companyId, accountCode: b.account_code, enabled: e.target.checked })} />
                </td>
                <td style={cell}>{b.account_name}</td>
                <td style={num}>{b.account_code}</td>
                <td style={{ ...cell, color: b.usedBy.length > 0 ? good : undefined }}>
                  {b.usedBy.length > 0 ? b.usedBy.join(', ') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {save.isError && (
        <div style={{ fontSize: 'var(--fs-13)', color: danger, display: 'flex', gap: 6 }}>
          <AlertTriangle {...ICON} />
          <span>{refusalText(save.error, 'That bank was not changed.')}</span>
        </div>
      )}
      <div style={softText}>
        These are this company&rsquo;s money accounts from the chart of accounts, which is maintained centrally.
        Unticking one that a merchant still pays into is refused — point the merchant somewhere else first.
      </div>
    </section>
  );
};

/* ── One merchant's report layout — GLOBAL, every company shares it ───────── */

const HEADING_FIELDS = [
  { key: 'date', label: 'Date heading', hint: 'e.g. Txn Date' },
  { key: 'ref', label: 'Reference heading', hint: 'e.g. Approval Code' },
  { key: 'gross', label: 'Amount heading', hint: 'e.g. Gross' },
  { key: 'fee', label: 'Fee heading', hint: 'e.g. MDR' },
  { key: 'net', label: 'Net heading', hint: 'e.g. Net Credited' },
] as const;

const MerchantForm = ({ merchant, onDone }: { merchant: MaintenanceMerchant; onDone: () => void }) => {
  const save = useSaveAcquirerSetup();
  const [form, setForm] = useState({
    statementFormat: merchant.statement_format ?? '',
    hasUniqueRef: merchant.has_unique_ref == null ? '' : String(merchant.has_unique_ref),
    feeMethod: merchant.fee_method ?? '',
    dateToleranceDays: String(merchant.date_tolerance_days),
  });
  const [headings, setHeadings] = useState<Record<string, string>>(() => {
    const m = merchant.column_map ?? {};
    return Object.fromEntries(HEADING_FIELDS.map((f) => [f.key, m[f.key] ?? '']));
  });
  const [mapError, setMapError] = useState('');

  const requiredHeadings = ['date', 'gross',
    ...(form.feeMethod === 'stated' ? ['fee'] : []),
    ...(form.feeMethod === 'gross-minus-net' ? ['net'] : []),
    ...(form.hasUniqueRef === 'true' ? ['ref'] : []),
  ];

  const submit = () => {
    const missing = requiredHeadings.filter((k) => !String(headings[k] ?? '').trim());
    if (missing.length > 0) {
      setMapError(`Fill in the ${missing.map((k) => HEADING_FIELDS.find((f) => f.key === k)?.label.replace(' heading', '')).join(', ')} heading${missing.length > 1 ? 's' : ''} — a report cannot be read without ${missing.length > 1 ? 'them' : 'it'}.`);
      return;
    }
    setMapError('');
    save.mutate({
      code: merchant.code,
      statementFormat: form.statementFormat || null,
      hasUniqueRef: form.hasUniqueRef === '' ? null : form.hasUniqueRef === 'true',
      feeMethod: form.feeMethod || null,
      dateToleranceDays: Number(form.dateToleranceDays) || 0,
      columnMap: Object.fromEntries(
        Object.entries(headings).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v !== ''),
      ),
    }, { onSuccess: onDone });
  };

  /* `key` matters for the heading fields below, which are rendered from a list —
     without it React cannot tell one input from the next and reuses the wrong
     DOM node when the required-field marks change. */
  const field = (label: string, node: React.ReactNode, key?: string) => (
    <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 'var(--fs-12)' }}>
      <span style={{ color: 'var(--c-ink-soft, #777)' }}>{label}</span>
      {node}
    </label>
  );
  const grid: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 'var(--space-3)',
  };
  const input: React.CSSProperties = { padding: '6px 8px', fontSize: 'var(--fs-13)', width: '100%', boxSizing: 'border-box' };
  const legend: React.CSSProperties = {
    fontSize: 'var(--fs-12)', fontWeight: 700, letterSpacing: '.04em',
    textTransform: 'uppercase', color: 'var(--c-ink-soft, #777)',
  };

  return (
    <section className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <button type="button" style={btn()} onClick={onDone}><ArrowLeft {...ICON} /> Back</button>
        <b>{merchant.display_name} — report layout</b>
        <span style={softText}>Taught once. Every company reads {merchant.display_name}&rsquo;s file this way.</span>
      </div>

      <div className="space-y-2">
        <div style={legend}>How the file is built</div>
        <div style={grid}>
          {field('File format', (
            <select style={input} value={form.statementFormat} aria-label={`${merchant.code} statement format`}
              onChange={(e) => setForm({ ...form, statementFormat: e.target.value })}>
              <option value="">not known</option><option value="CSV">CSV</option>
              <option value="XLSX">XLSX</option><option value="PDF">PDF</option>
            </select>
          ))}
          {field('Has a unique reference?', (
            <select style={input} value={form.hasUniqueRef} aria-label={`${merchant.code} unique reference`}
              onChange={(e) => setForm({ ...form, hasUniqueRef: e.target.value })}>
              <option value="">not known</option><option value="true">yes</option><option value="false">no</option>
            </select>
          ))}
          {field('Fee shown as', (
            <select style={input} value={form.feeMethod} aria-label={`${merchant.code} fee method`}
              onChange={(e) => setForm({ ...form, feeMethod: e.target.value })}>
              <option value="">not known</option>
              <option value="stated">a column on each line</option>
              <option value="gross-minus-net">gross minus net</option>
              <option value="prorated-summary">one total for the statement</option>
            </select>
          ))}
          {field('Days it may drift', (
            <input style={input} value={form.dateToleranceDays} aria-label={`${merchant.code} date tolerance`}
              onChange={(e) => setForm({ ...form, dateToleranceDays: e.target.value })} />
          ))}
        </div>
        {form.hasUniqueRef === 'false' && (
          <div style={{ fontSize: 'var(--fs-12)', color: danger }}>
            Without a unique reference nothing from {merchant.code} can be confirmed automatically — every line
            will be matched by hand.
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div style={legend}>Column headings, exactly as they appear in the file</div>
        <div style={grid}>
          {HEADING_FIELDS.map((f) => {
            const required = requiredHeadings.includes(f.key);
            return field(`${f.label}${required ? ' *' : ''}`, (
              <input
                style={{ ...input, borderColor: required && !headings[f.key] ? danger : undefined }}
                value={headings[f.key] ?? ''} placeholder={f.hint}
                aria-label={`${merchant.code} ${f.label}`}
                onChange={(e) => setHeadings({ ...headings, [f.key]: e.target.value })}
              />
            ), f.key);
          })}
        </div>
      </div>

      {mapError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{mapError}</div>}

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button type="button" style={btn(true, save.isPending)} disabled={save.isPending} onClick={submit}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" style={btn()} onClick={onDone}>Cancel</button>
      </div>
    </section>
  );
};

export default SettlementSetup;
