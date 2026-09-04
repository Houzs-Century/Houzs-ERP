// ----------------------------------------------------------------------------
// RECONCILIATION SETUP — ONE maintenance table, every company at once.
//
// The owner's own shape (2026-08-18): "我应该 overall maintenance table，左手边是
// merchant、bank，上面 header 是公司，这个公司有就 tick." So merchants and banks
// are the ROWS, companies are the COLUMNS, and a tick in a cell means that
// company uses that merchant / banks with that account.
//
// He asked for this because the work is comparative: the question is never
// "what does Houzs use" on its own, it is "which of my companies use PBB, and
// where does each of them get paid". A screen showing one company at a time
// cannot answer that without the operator remembering the last one.
//
// What is shared and what is not, made structural:
//
//   • HOW a merchant's report reads (format, unique reference, fee, headings)
//     is taught ONCE and every company uses it — it sits on the ROW, outside
//     every company column, because that is exactly what it is;
//   • WHICH merchants a company uses, and WHICH of its banks each pays into,
//     is the CELL — PBB pays Houzs into Maybank and 2990 into Hong Leong;
//   • the banks themselves are the chart of accounts, already maintained
//     centrally — his answer: "chart of account 我也是会做成总维护不是？"
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import {
  useSettlementMaintenance, useSaveMaintenanceMerchant, useSaveMaintenanceBank,
  useSaveAcquirerSetup,
  type MaintenanceMerchant, type MaintenanceBank, type MaintenanceCompany,
} from './settlement-queries';
import { ICON, btn, softText, danger, refusalText } from './settlement-ui';
import { useAccounts, useAccountRoles, useSaveBankDefault } from '../../vendor/scm/lib/accounting-queries';
import { useBankRules, useSaveBankRule, useCreateBankRule, type BankRule } from './bank-queries';
import { useVoucherNumbering, useSaveVoucherNumbering } from './accounting-phase1-queries';
import css from './SettlementSetup.module.css';
import { PageHeader } from '../../components/Layout';

export const SettlementSetup = () => {
  const [editing, setEditing] = useState<string | null>(null);
  const q = useSettlementMaintenance();
  const data = q.data;

  const companies = data?.companies ?? [];
  const merchants = data?.merchants ?? [];
  const banks = data?.banks ?? [];
  const open = merchants.find((m) => m.code === editing) ?? null;

  if (open) return <MerchantForm merchant={open} onDone={() => setEditing(null)} />;

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Reconciliation setup" />

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={softText}>
          Tick what each company uses. The report layout is taught once and shared by all of them.
        </span>
        <span style={{ flex: 1 }} />
        <Link to="/scm/merchant-recon" style={{ ...btn(), textDecoration: 'none' }}>
          <ArrowLeft {...ICON} /> Merchant reconciliation
        </Link>
      </div>

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}

      {companies.length > 0 && (
        <>
          <MerchantMatrix companies={companies} merchants={merchants} banks={banks} onEdit={setEditing} />
          <BankMatrix companies={companies} banks={banks} />
        </>
      )}

      <DefaultBankCard />
      <NumberingCard />
      <BankRulesCard />
    </div>
  );
};

/* ── Bank recognition rules — how a statement credit is known to be a payout
   (2026-09-02). Seed-only since layer 4; now the owner fixes a reworded bank
   narration himself. GLOBAL like the report layouts — a payout reads the same
   in every company's statement. The server compiles every regex at write time
   and its refusal sentence is shown verbatim; switching a rule off keeps the
   row (nothing vanishes). */
const BankRulesCard = () => {
  const rulesQ = useBankRules();
  const save = useSaveBankRule();
  const createM = useCreateBankRule();
  const [drafts, setDrafts] = useState<Record<number, Partial<BankRule> | undefined>>({});
  const [note, setNote] = useState<string | null>(null);
  const [newRule, setNewRule] = useState<{ acquirerCode: string; pattern: string }>({ acquirerCode: '', pattern: '' });

  const rules = rulesQ.data?.rules ?? [];
  const acquirers = [...new Set(rules.map((r) => r.acquirer_code))];

  const rowValue = (r: BankRule): BankRule => ({ ...r, ...(drafts[r.id] ?? ({} as Partial<BankRule>)) });
  const edit = (id: number, patch: Partial<BankRule>) =>
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));

  return (
    <section className={css.card}>
      <div className={css.cardHead}>
        <span className={css.cardTitle}>Bank recognition rules</span>
        <span className={css.hint}>How a statement credit is known to be an acquirer&rsquo;s payout. Shared by every company; a broken pattern is refused, not saved.</span>
      </div>
      <div className={css.scroll}>
        <table className={css.grid}>
          <thead>
            <tr>
              <th className={css.head}>Acquirer</th>
              <th className={css.head}>Pattern (regex, case-insensitive)</th>
              <th className={css.head}>Looks in</th>
              <th className={css.head}>Order</th>
              <th className={css.head}>Active</th>
              <th className={css.head} />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const v = rowValue(r);
              const dirty = drafts[r.id] != null && Object.keys(drafts[r.id]!).length > 0;
              return (
                <tr key={r.id} className={css.row}>
                  <td className={css.label}><b>{r.acquirer_code}</b></td>
                  <td style={{ padding: '4px 8px' }}>
                    <input
                      aria-label={`Pattern for ${r.acquirer_code} rule ${r.id}`}
                      value={v.pattern}
                      onChange={(e) => edit(r.id, { pattern: e.target.value })}
                      style={{ width: '100%', minWidth: 220, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)', padding: '4px 8px' }}
                    />
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <select value={v.match_field} onChange={(e) => edit(r.id, { match_field: e.target.value as BankRule['match_field'] })} style={{ fontSize: 'var(--fs-12)', padding: '4px 6px' }}>
                      <option value="both">both</option>
                      <option value="description">description</option>
                      <option value="reference">reference</option>
                    </select>
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <input type="number" value={v.sort_order}
                      onChange={(e) => edit(r.id, { sort_order: Number(e.target.value) })}
                      style={{ width: 64, fontSize: 'var(--fs-12)', padding: '4px 6px' }} />
                  </td>
                  <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                    <input type="checkbox" checked={v.is_active}
                      aria-label={`${r.acquirer_code} rule ${r.id} active`}
                      onChange={(e) => edit(r.id, { is_active: e.target.checked })}
                      style={{ width: 16, height: 16, accentColor: 'var(--c-orange)' }} />
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <button type="button" style={btn(dirty, save.isPending)} disabled={!dirty || save.isPending}
                      onClick={() => {
                        const d = drafts[r.id]!;
                        save.mutate({
                          id: r.id,
                          ...(d.pattern !== undefined ? { pattern: d.pattern } : {}),
                          ...(d.match_field !== undefined ? { matchField: d.match_field } : {}),
                          ...(d.sort_order !== undefined ? { sortOrder: d.sort_order } : {}),
                          ...(d.is_active !== undefined ? { isActive: d.is_active } : {}),
                        }, {
                          onSuccess: () => { setDrafts((prev) => { const { [r.id]: _gone, ...rest } = prev; return rest; }); setNote(null); },
                          onError: (e) => setNote(refusalText(e, 'Rule not saved.')),
                        });
                      }}>
                      Save
                    </button>
                  </td>
                </tr>
              );
            })}
            {/* Add a rule — the acquirer and the pattern are the essentials;
                everything else starts at its default and is edited above. */}
            <tr className={css.row}>
              <td className={css.label}>
                <select aria-label="New rule acquirer" value={newRule.acquirerCode}
                  onChange={(e) => setNewRule((p) => ({ ...p, acquirerCode: e.target.value }))}
                  style={{ fontSize: 'var(--fs-12)', padding: '4px 6px' }}>
                  <option value="">+ add…</option>
                  {acquirers.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </td>
              <td style={{ padding: '4px 8px' }} colSpan={4}>
                <input aria-label="New rule pattern" placeholder="e.g. PBB-PBCS"
                  value={newRule.pattern}
                  onChange={(e) => setNewRule((p) => ({ ...p, pattern: e.target.value }))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)', padding: '4px 8px' }} />
              </td>
              <td style={{ padding: '4px 8px' }}>
                <button type="button" style={btn(!!newRule.acquirerCode && !!newRule.pattern.trim(), createM.isPending)}
                  disabled={!newRule.acquirerCode || !newRule.pattern.trim() || createM.isPending}
                  onClick={() => createM.mutate({ acquirerCode: newRule.acquirerCode, pattern: newRule.pattern.trim() }, {
                    onSuccess: () => { setNewRule({ acquirerCode: '', pattern: '' }); setNote(null); },
                    onError: (e) => setNote(refusalText(e, 'Rule not added.')),
                  })}>
                  Add
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {note && <div style={{ color: danger, fontSize: 'var(--fs-12)', padding: 'var(--space-2) var(--space-3)' }}>{note}</div>}
    </section>
  );
};

/* ── The company's default bank (BANK_DEFAULT) ──────────────────────────────
   The owner's own lever (2026-08-30: 默认银行我可以自己maintenance): where a
   transfer payment lands, and what the PV / AP Payment "Paid From" pre-fills.
   Per company — switch companies in the top bar to set the other one's. Only
   money accounts are offered, and the server refuses anything else anyway. */
/* ── Voucher numbering (GL redesign item 8a) — the owner's own levers ──────
   One letter per bank (Maybank M → the 2990-MPV-YYMM series; a new bank is a
   letter typed HERE, never a deploy) and the suffix width (3 → -001, up to
   5). The PV series (8b), the OR channels (9) and transfers (10) all read
   the same letters, so Maybank is M everywhere or nowhere. */
const NumberingCard = () => {
  const q = useVoucherNumbering();
  const save = useSaveVoucherNumbering();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [digits, setDigits] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const rows = q.data?.accounts ?? [];
  const shownDigits = digits ?? q.data?.digits ?? 3;
  // Index reads widened by hand — noUncheckedIndexedAccess is off project-wide.
  const typed = (code: string): string | undefined => draft[code] as string | undefined;
  const letterOf = (code: string, saved: string | null): string => typed(code) ?? saved ?? '';
  const dirtyLetters = rows
    .filter((a) => (typed(a.accountCode) ?? '') !== '' && (typed(a.accountCode) ?? '').toUpperCase() !== (a.letter ?? ''))
    .map((a) => ({ accountCode: a.accountCode, letter: (typed(a.accountCode) ?? '').toUpperCase() }));
  const dirty = dirtyLetters.length > 0 || (digits != null && digits !== (q.data?.digits ?? 3));

  return (
    <section className={css.card}>
      <div style={{ padding: 'var(--space-3)' }} className="space-y-2">
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ fontSize: 'var(--fs-14)' }}>Voucher numbering (this company)</b>
          <span style={softText}>每家银行一个字母 (Maybank M → 2990-MPV-2609-001);位数你自己定</span>
          <span style={{ flex: 1 }} />
          <span style={softText}>Digits</span>
          <select aria-label="Voucher number digits" value={shownDigits}
            onChange={(e) => { setDigits(Number(e.target.value)); setNote(null); }}
            style={{ padding: '6px 10px', fontSize: 'var(--fs-13)' }}>
            {[3, 4, 5].map((d) => <option key={d} value={d}>{d} — {'0'.repeat(d - 1)}1</option>)}
          </select>
          <button type="button" style={btn(dirty, save.isPending)} disabled={!dirty || save.isPending}
            onClick={() => save.mutate(
              { ...(digits != null ? { digits } : {}), ...(dirtyLetters.length ? { letters: dirtyLetters } : {}) },
              {
                onSuccess: () => { setNote('Saved — new vouchers use these series.'); setDraft({}); setDigits(null); },
                onError: (e) => setNote(e instanceof Error ? e.message : 'Not saved.'),
              },
            )}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          {rows.map((a) => (
            <label key={a.accountCode} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 'var(--fs-13)' }}>
              <span style={softText}>{a.accountCode} · {a.accountName}</span>
              <input
                aria-label={`Letter for ${a.accountCode}`}
                value={letterOf(a.accountCode, a.letter)}
                onChange={(e) => { setDraft((d) => ({ ...d, [a.accountCode]: e.target.value })); setNote(null); }}
                maxLength={3}
                placeholder="—"
                style={{ width: 48, padding: '4px 6px', fontSize: 'var(--fs-13)', textTransform: 'uppercase', border: '1px solid var(--c-line, rgba(34,31,32,0.2))', borderRadius: 'var(--radius-sm, 6px)' }}
              />
            </label>
          ))}
          {rows.length === 0 && <span style={softText}>{q.isLoading ? 'Loading…' : 'No money accounts in this chart yet.'}</span>}
        </div>
        {note && <div style={softText}>{note}</div>}
      </div>
    </section>
  );
};

const DefaultBankCard = () => {
  const rolesQ = useAccountRoles();
  const accountsQ = useAccounts();
  const save = useSaveBankDefault();
  const [choice, setChoice] = useState<string>('');
  const [note, setNote] = useState<string | null>(null);

  const money = (accountsQ.data?.accounts ?? []).filter((a) => a.is_active && a.acc_money === true);
  const current = rolesQ.data?.roles.BANK_DEFAULT ?? '';
  const value = choice || current;
  const dirty = !!choice && choice !== current;

  return (
    <section className={css.card}>
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap', padding: 'var(--space-3)' }}>
        <b style={{ fontSize: 'var(--fs-14)' }}>Default bank (this company)</b>
        <span style={softText}>pre-fills every voucher&rsquo;s Paid From; transfer payments land here</span>
        <span style={{ flex: 1 }} />
        <select
          aria-label="Default bank account"
          value={value}
          onChange={(e) => { setChoice(e.target.value); setNote(null); }}
          style={{ padding: '6px 10px', fontSize: 'var(--fs-13)', minWidth: 260 }}
          disabled={rolesQ.isLoading || accountsQ.isLoading}
        >
          {!value && <option value="">{rolesQ.isLoading ? 'Loading…' : '— pick a bank / cash account —'}</option>}
          {money.map((a) => (
            <option key={a.account_code} value={a.account_code}>{a.account_code} · {a.account_name}</option>
          ))}
        </select>
        <button
          type="button"
          style={btn(dirty, save.isPending)}
          disabled={!dirty || save.isPending}
          onClick={() => {
            save.mutate(choice, {
              onSuccess: () => { setNote('Saved — vouchers now pre-fill this bank.'); setChoice(''); },
              onError: (e) => setNote(e instanceof Error ? e.message : 'Not saved.'),
            });
          }}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {note && <div style={{ ...softText, padding: '0 var(--space-3) var(--space-3)' }}>{note}</div>}
    </section>
  );
};

/* ── Merchants down the side, companies across the top ────────────────────── */

const MerchantMatrix = ({ companies, merchants, banks, onEdit }: {
  companies: MaintenanceCompany[]; merchants: MaintenanceMerchant[]; banks: MaintenanceBank[];
  onEdit: (code: string) => void;
}) => {
  const save = useSaveMaintenanceMerchant();

  return (
    <section className={css.card}>
      <div className={css.cardHead}>
        <span className={css.cardTitle}>Merchants</span>
        <span className={css.hint}>Tick the companies that use each one, and where its money lands.</span>
      </div>
      <div className={css.scroll}>
        <table className={css.grid}>
          <thead>
            <tr>
              <th className={css.groupHead} colSpan={2} />
              <th className={css.groupHead} colSpan={companies.length}>Companies</th>
            </tr>
            <tr>
              <th className={css.head}>Merchant</th>
              <th className={css.head}>Report layout</th>
              {companies.map((co) => (
                <th key={co.id} className={css.headCompany}>
                  <div className={css.companyName}>{co.name}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {merchants.map((m) => (
              <tr key={m.code} className={css.row}>
                <td className={css.label}>
                  <div className={css.name}>{m.display_name}</div>
                  {m.code !== m.display_name && <div className={css.sub}>{m.code}</div>}
                </td>
                {/* OUTSIDE the company columns, because it belongs to no company. */}
                <td className={css.shared}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className={css.pill}>shared by every company</span>
                    <button type="button" style={{ ...btn(), padding: '2px 10px' }} onClick={() => onEdit(m.code)}>
                      Change
                    </button>
                  </div>
                  <div className={m.ready ? css.sub : undefined} style={m.ready ? undefined : { fontSize: 'var(--fs-12)', color: danger }}>
                    {m.ready
                      ? `${m.statement_format} · ${m.autoMatchable ? 'matches by reference' : 'by hand, always'}`
                      : 'not taught yet'}
                  </div>
                </td>
                {companies.map((co) => {
                  const at = m.byCompany[String(co.id)] ?? { enabled: false, linked: false, bankAccountCode: null };
                  /* Only banks THIS company has can receive THIS company's money. */
                  const usable = banks.filter((b) => b.byCompany[String(co.id)]?.enabled);
                  return (
                    <td key={co.id} className={css.cellCompany}>
                      <div className={css.cellInner}>
                        <input type="checkbox" className={css.tick} checked={at.enabled}
                          aria-label={`${m.code} for ${co.name}`}
                          onChange={(e) => save.mutate({ companyId: co.id, code: m.code, enabled: e.target.checked })} />
                        {at.enabled && (
                          <>
                            <select className={css.bankPick}
                              aria-label={`${m.code} bank for ${co.name}`} value={at.bankAccountCode ?? ''}
                              onChange={(e) => save.mutate({ companyId: co.id, code: m.code, bankAccountCode: e.target.value || null })}>
                              <option value="">money lands in…</option>
                              {usable.map((b) => (
                                <option key={b.account_code} value={b.account_code}>{b.account_name}</option>
                              ))}
                            </select>
                            {!at.bankAccountCode && <div className={css.warn}>company default</div>}
                          </>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

/* ── Banks down the side, the same companies across the top ───────────────── */

const BankMatrix = ({ companies, banks }: { companies: MaintenanceCompany[]; banks: MaintenanceBank[] }) => {
  const save = useSaveMaintenanceBank();

  return (
    <section className={css.card}>
      <div className={css.cardHead}>
        <span className={css.cardTitle}>Banks</span>
        <span className={css.hint}>Tick the companies that bank with each account.</span>
      </div>
      <div className={css.scroll}>
        <table className={css.grid}>
          <thead>
            <tr>
              <th className={css.groupHead} colSpan={1} />
              <th className={css.groupHead} colSpan={companies.length}>Companies</th>
            </tr>
            <tr>
              <th className={css.head}>Account</th>
              {companies.map((co) => (
                <th key={co.id} className={css.headCompany}>
                  <div className={css.companyName}>{co.name}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {banks.map((b) => (
              <tr key={b.account_code} className={css.row}>
                <td className={css.label}>
                  <div className={css.name}>{b.account_name}</div>
                  <div className={css.sub}>{b.account_code}</div>
                </td>
                {companies.map((co) => {
                  const at = b.byCompany[String(co.id)] ?? { inChart: false, enabled: false, usedBy: [] };
                  /* A code this company simply does not carry is not a box it
                     could tick — say so rather than offer a lie. */
                  if (!at.inChart) {
                    return <td key={co.id} className={css.cellCompany}><span className={css.absent}>not in its chart</span></td>;
                  }
                  return (
                    <td key={co.id} className={css.cellCompany}>
                      <div className={css.cellInner}>
                        <input type="checkbox" className={css.tick} checked={at.enabled}
                          aria-label={`${b.account_code} for ${co.name}`}
                          onChange={(e) => save.mutate({ companyId: co.id, accountCode: b.account_code, enabled: e.target.checked })} />
                        {at.usedBy.length > 0 && (
                          <div className={css.users}>
                            {at.usedBy.map((code) => <span key={code} className={css.userChip}>{code}</span>)}
                          </div>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {save.isError && (
        <div className={css.error}>
          <AlertTriangle {...ICON} />
          <span>{refusalText(save.error, 'That bank was not changed.')}</span>
        </div>
      )}
      <div className={css.footNote}>
        The accounts come from the chart of accounts, which is maintained centrally. Unticking one a merchant still
        pays into is refused — point the merchant somewhere else first.
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
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Reconciliation setup" />

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
        <button type="button" style={btn()} onClick={onDone}><ArrowLeft {...ICON} /> All merchants</button>
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
    </div>
  );
};

export default SettlementSetup;
