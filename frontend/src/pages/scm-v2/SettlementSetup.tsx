// ----------------------------------------------------------------------------
// RECON SETUP — ONE maintenance page, every company at once, in the owner's
// Claude Design redesign (Finance-1a-Setup, batch 6 §6.3).
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
//
// The redesign keeps every call: the sections in the design's order (Merchants,
// Banks beside Voucher numbering and Default bank, Bank statements, Bank
// recognition rules), the merchant's layout and a statement setup in centred
// modals. A rule is never deleted — Remove switches it off (owner question g4).
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, MoreHorizontal, Plus, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useSettlementMaintenance, useSaveMaintenanceMerchant, useSaveMaintenanceBank,
  useSaveAcquirerSetup, useRematch,
  type MaintenanceMerchant, type MaintenanceBank, type MaintenanceCompany, type MaintenanceData } from './settlement-queries';
import { ICON, refusalText } from './settlement-ui';
import { useAccounts, useAccountRoles, useSaveBankDefault } from '../../vendor/scm/lib/accounting-queries';
import { useBankRules, useSaveBankRule, useCreateBankRule, useBankConfigs, useSaveBankConfig, type BankRule, type BankConfig } from './bank-queries';
import { useVoucherNumbering, useSaveVoucherNumbering } from './accounting-phase1-queries';
import { NumberInput } from '../../vendor/scm/components/NumberInput';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useToastOptional } from '../../hooks/useToast';
import { getActiveCompanyId } from '../../lib/activeCompany';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { Field, PopMenu, SetupModal, Skeleton, Switch, Tag, type Tone } from './finance/SetupParts';
import sp from './finance/SetupParts.module.css';
import css from './SettlementSetup.module.css';

export const SettlementSetup = () => {
  const navigate = useNavigate();
  const [editing, setEditing] = useState<string | null>(null);
  /* What the last merchant save did to the reports already uploaded. */
  const [notice, setNotice] = useState<string | null>(null);
  const q = useSettlementMaintenance();
  const data = q.data;

  const companies = data?.companies ?? [];
  const merchants = data?.merchants ?? [];
  const banks = data?.banks ?? [];
  const open = merchants.find((m) => m.code === editing) ?? null;
  const activeId = getActiveCompanyId();
  const thisCompany = companies.find((co) => co.id === activeId)?.name ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance · Setup"
        title="Recon setup"
        description="Merchants, banks, statements and voucher numbers"
        actions={(
          <Button variant="secondary" size="sm" onClick={() => navigate('/scm/merchant-recon')}>
            <ArrowLeft {...ICON} /> Merchant reports
          </Button>
        )}
      />

      <div className={sp.page}>
        {notice && (
          <div className={sp.note} role="status">
            <CheckCircle2 size={14} />
            <span className={sp.grow}>{notice}</span>
            <button type="button" className={sp.iconBtn} aria-label="Close the note" onClick={() => setNotice(null)}><X size={13} /></button>
          </div>
        )}

        {q.isLoading && <section className={sp.card}><Skeleton rows={6} label="Loading the merchants and banks" /></section>}
        {q.isError && (
          <div className={sp.problem}>The merchants and banks could not be loaded — {refusalText(q.error, 'try again.')}</div>
        )}

        {companies.length > 0 && (
          <MerchantMatrix companies={companies} merchants={merchants} banks={banks} clearings={data?.clearings ?? {}}
            feeAccounts={data?.feeAccounts ?? {}} onEdit={setEditing} />
        )}

        <div className={css.pair}>
          {companies.length > 0 ? <BankMatrix companies={companies} banks={banks} /> : <div />}
          {/* Per-company settings: this company's numbering and default bank —
              switch companies in the top bar for the other one. */}
          <div className={css.stack}>
            <NumberingCard company={thisCompany} />
            <DefaultBankCard />
          </div>
        </div>

        <BankStatementsCard />
        <BankRulesCard />
      </div>

      {open && (
        <MerchantForm merchant={open} companies={companies} onDone={(said) => { setEditing(null); if (said) setNotice(said); }} />
      )}
    </div>
  );
};

/* ── Merchants down the side, companies across the top ────────────────────── */

/** A fee method's chip and its words (the server holds the vocabulary). */
const feeChip = (method: string | null): [string, string] => {
  switch (method) {
    case 'stated': return ['Fee per line', 'fee stated per line'];
    case 'gross-minus-net': return ['Gross − net', 'fee = gross minus net'];
    case 'prorated-summary': return ['Fee per file', 'one fee total for the statement'];
    default: return ['Fee ?', 'fee not known'];
  }
};

/** The shared half of a merchant as the design's chips: file, reference, fee, drift. */
const layoutChips = (m: MaintenanceMerchant): Array<{ t: string; tone: Tone; tip: string }> => [
  { t: m.statement_format ?? 'File ?', tone: 'calm', tip: 'File type' },
  m.has_unique_ref === true
    ? { t: 'Unique ref', tone: 'calm', tip: 'The reference matches the sale' }
    : m.has_unique_ref === false
      ? { t: 'Ref not unique', tone: 'warn', tip: 'Each line is picked by hand' }
      : { t: 'Ref ?', tone: 'calm', tip: 'Unique reference not known' },
  { t: feeChip(m.fee_method)[0], tone: 'calm', tip: feeChip(m.fee_method)[1] },
  { t: `±${m.date_tolerance_days} days`, tone: 'calm', tip: 'Date tolerance' },
];

const MerchantMatrix = ({ companies, merchants, banks, clearings, feeAccounts, onEdit }: {
  companies: MaintenanceCompany[]; merchants: MaintenanceMerchant[]; banks: MaintenanceBank[];
  /** Each company's clearing accounts (326-/327-) — the picker under the payout bank. */
  clearings: NonNullable<MaintenanceData['clearings']>;
  feeAccounts: NonNullable<MaintenanceData['feeAccounts']>;
  onEdit: (code: string) => void;
}) => {
  const save = useSaveMaintenanceMerchant();
  const toast = useToastOptional();

  return (
    <section className={sp.card} aria-label="Merchants">
      <div className={css.head}>
        <span className={css.title}>Merchants</span>
        <span className={sp.cardSub}>File layout shared · accounts per company</span>
      </div>
      <div className={sp.scroll}>
        <table className={`${sp.table} ${css.merchants}`}>
          <thead>
            <tr>
              <th>Merchant</th>
              <th>File layout</th>
              {companies.map((co) => (
                <th key={co.id}>{co.code} <span className={css.coName}>{co.name}</span></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {merchants.map((m) => {
              const heads = Object.values(m.column_map ?? {}).filter(Boolean);
              return (
                <tr key={m.code} className={css.topRow}>
                  <td>
                    <span className={css.rowName}>{m.code}</span>
                    {m.display_name !== m.code && <span className={css.rowSub}>{m.display_name}</span>}
                    {(m.so_names ?? []).length > 0 && <span className={css.rowSub}>also keyed as {(m.so_names ?? []).join(', ')}</span>}
                  </td>
                  {/* OUTSIDE the company columns, because it belongs to no company. */}
                  <td>
                    <span className={css.chips}>
                      {layoutChips(m).map((k) => <Tag key={k.tip} tone={k.tone} title={k.tip}>{k.t}</Tag>)}
                      {!m.ready && <Tag tone="late" dot>Not taught yet</Tag>}
                    </span>
                    <button type="button" className={`${sp.link} ${css.editLink}`} onClick={() => onEdit(m.code)}
                      title={heads.length > 0 ? `Headings: ${heads.join(', ')}` : 'No headings yet'}>
                      Edit
                    </button>
                  </td>
                  {companies.map((co) => {
                    const at = m.byCompany[String(co.id)] ?? { enabled: false, linked: false, bankAccountCode: null };
                    /* Only banks THIS company has can receive THIS company's money. */
                    const usable = banks.filter((b) => b.byCompany[String(co.id)]?.enabled);
                    const coClearings = clearings[String(co.id)] ?? [];
                    const coFees = feeAccounts[String(co.id)] ?? [];
                    return (
                      <td key={co.id} className={css.coCell}>
                        <label className={css.used}>
                          <input type="checkbox" className={css.tick} checked={at.enabled}
                            aria-label={`${m.code} for ${co.name}`}
                            onChange={(e) => {
                              const on = e.target.checked;
                              save.mutate({ companyId: co.id, code: m.code, enabled: on }, {
                                onSuccess: () => toast?.success(`${m.code} turned ${on ? 'on' : 'off'} for ${co.name}`),
                              });
                            }} />
                          {at.enabled ? 'Used' : 'Not used'}
                        </label>
                        {at.enabled && (
                          <span className={css.pickers}>
                            <label className={css.pickRow}>
                              <span className={css.pickLabel}>Pays into</span>
                              <select className={`${sp.select} ${sp.compact}`}
                                aria-label={`${m.code} bank for ${co.name}`} value={at.bankAccountCode ?? ''}
                                onChange={(e) => save.mutate({ companyId: co.id, code: m.code, bankAccountCode: e.target.value || null })}>
                                <option value="">company default</option>
                                {usable.map((b) => <option key={b.account_code} value={b.account_code}>{b.account_name}</option>)}
                              </select>
                            </label>
                            {/* The clearing account — where this machine's card money
                                sits until the payout (owner 2026-09-07: one per bank,
                                so the board says what each still owes). Offered only
                                when the server lists the company's clearing codes. */}
                            {coClearings.length > 0 && (
                              <label className={css.pickRow}>
                                <span className={css.pickLabel}>Clearing</span>
                                <select className={`${sp.select} ${sp.compact}`}
                                  aria-label={`${m.code} clearing for ${co.name}`} value={at.transitAccountCode ?? '326-0000'}
                                  onChange={(e) => save.mutate({ companyId: co.id, code: m.code, transitAccountCode: e.target.value })}>
                                  {coClearings.map((a) => <option key={a.account_code} value={a.account_code}>{a.account_name}</option>)}
                                </select>
                              </label>
                            )}
                            {/* WHERE THE FEE GOES. This had to be a migration
                                once already: the fee account was seeded at
                                930-0000, the AutoCount chart deactivated that
                                code, and every settlement confirm in both
                                companies refused — with nothing on any screen
                                able to repoint it (docs/bugs/0762). The list is
                                the company's ACTIVE EXPENSE LEAVES, filtered by
                                the server to the same properties the posting
                                gate checks. */}
                            {coFees.length > 0 && (
                              <label className={css.pickRow}>
                                <span className={css.pickLabel}>Fee to</span>
                                <select className={`${sp.select} ${sp.compact}`}
                                  aria-label={`${m.code} fee account for ${co.name}`} value={at.feeAccountCode ?? ''}
                                  onChange={(e) => save.mutate({ companyId: co.id, code: m.code, feeAccountCode: e.target.value })}>
                                  <option value="">fee goes to…</option>
                                  {coFees.map((a) => <option key={a.account_code} value={a.account_code}>{a.account_name}</option>)}
                                </select>
                              </label>
                            )}
                            {/* A fee account this company's chart no longer
                                offers is named rather than shown as a blank
                                select — that silence is exactly how 930-0000
                                went unnoticed for six days. */}
                            {at.feeAccountCode && coFees.length > 0 && !coFees.some((a) => a.account_code === at.feeAccountCode) && (
                              <span className={css.warn}>fee → {at.feeAccountCode}, which this chart cannot post to</span>
                            )}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {merchants.length === 0 && (
              <tr><td colSpan={2 + companies.length} className={sp.empty}>No merchant in the setup yet.</td></tr>
            )}
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
    <section className={sp.card} aria-label="Banks">
      <div className={css.head}>
        <span className={css.title}>Banks</span>
        <span className={sp.cardSub}>Tick the companies that bank with each account</span>
      </div>
      <div className={sp.scroll}>
        <table className={sp.table}>
          <thead>
            <tr>
              <th>Account</th>
              {companies.map((co) => <th key={co.id} className={css.mid}>{co.code}</th>)}
            </tr>
          </thead>
          <tbody>
            {banks.map((b) => (
              <tr key={b.account_code}>
                <td>
                  <span className={css.bankName}>{b.account_name}</span>
                  <span className={css.rowSub}>{b.account_code}</span>
                </td>
                {companies.map((co) => {
                  const at = b.byCompany[String(co.id)] ?? { inChart: false, enabled: false, usedBy: [] };
                  /* A code this company simply does not carry is not a box it
                     could tick — say so rather than offer a lie. */
                  if (!at.inChart) {
                    return <td key={co.id} className={css.mid}><span className={css.absent}>not in its chart</span></td>;
                  }
                  return (
                    <td key={co.id} className={css.mid}>
                      <input type="checkbox" className={css.tick} checked={at.enabled}
                        aria-label={`${b.account_code} for ${co.name}`}
                        onChange={(e) => save.mutate({ companyId: co.id, accountCode: b.account_code, enabled: e.target.checked })} />
                      {at.usedBy.length > 0 && (
                        <span className={css.users} title="The merchants paying into it">
                          {at.usedBy.map((code) => <Tag key={code} tone="calm">{code}</Tag>)}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {banks.length === 0 && (
              <tr><td colSpan={1 + companies.length} className={sp.empty}>No money account in any company’s chart yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {save.isError && (
        <div className={css.refusal}>
          <AlertTriangle size={14} />
          <span>{refusalText(save.error, 'That bank was not changed.')}</span>
        </div>
      )}
      <div className={sp.cardFoot}>
        The accounts come from the chart of accounts, which is maintained centrally. Unticking one a merchant still pays
        into is refused — point the merchant somewhere else first.
      </div>
    </section>
  );
};

/* ── Voucher numbering (GL redesign item 8a) — the owner's own levers ──────
   One letter per bank (Maybank M → the 2990-MPV-YYMM series; a new bank is a
   letter typed HERE, never a deploy) and the suffix width (3 → -001, up to
   5). The PV series (8b), the OR channels (9) and transfers (10) all read
   the same letters, so Maybank is M everywhere or nowhere. */
const NumberingCard = ({ company }: { company: string | null }) => {
  const q = useVoucherNumbering();
  const save = useSaveVoucherNumbering();
  const toast = useToastOptional();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [digits, setDigits] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const rows = q.data?.accounts ?? [];
  const shownDigits = digits ?? q.data?.digits ?? 3;
  // Index reads widened by hand — noUncheckedIndexedAccess is off project-wide.
  const typed = (code: string): string | undefined => draft[code] as string | undefined;
  const letterOf = (code: string, saved: string | null): string => typed(code) ?? saved ?? '';
  const dirtyLetters = rows
    .filter((a) => a.fixedCash !== true)
    .filter((a) => (typed(a.accountCode) ?? '') !== '' && (typed(a.accountCode) ?? '').toUpperCase() !== (a.letter ?? ''))
    .map((a) => ({ accountCode: a.accountCode, letter: (typed(a.accountCode) ?? '').toUpperCase() }));
  const dirty = dirtyLetters.length > 0 || (digits != null && digits !== (q.data?.digits ?? 3));
  const firstBank = rows.find((a) => a.fixedCash !== true && letterOf(a.accountCode, a.letter) !== '');
  const firstLetter = firstBank ? letterOf(firstBank.accountCode, firstBank.letter).toUpperCase() : 'M';

  const submit = () => {
    /* Two banks on one letter would share a number series. */
    const letters = rows.filter((a) => a.fixedCash !== true).map((a) => letterOf(a.accountCode, a.letter).toUpperCase()).filter(Boolean);
    if (new Set(letters).size !== letters.length) { setNote('Each money account needs its own letter.'); return; }
    save.mutate(
      { ...(digits != null ? { digits } : {}), ...(dirtyLetters.length ? { letters: dirtyLetters } : {}) },
      {
        onSuccess: () => {
          setNote(null); setDraft({}); setDigits(null);
          toast?.success(`Voucher numbering saved · next vouchers use ${shownDigits} digits`);
        },
        onError: (e) => setNote(e instanceof Error ? e.message : 'Not saved.'),
      },
    );
  };

  return (
    <section className={css.smallCard} aria-label="Voucher numbering">
      <div className={css.smallHead}>
        <span className={css.title}>Voucher numbering</span>
        {company && <span className={sp.cardSub}>{company}</span>}
      </div>
      <div className={css.digitsRow}>
        Digits
        <select className={`${sp.select} ${sp.compact}`} aria-label="Voucher number digits" value={shownDigits}
          onChange={(e) => { setDigits(Number(e.target.value)); setNote(null); }}>
          {[3, 4, 5].map((d) => <option key={d} value={d}>{d} · {'0'.repeat(d - 1)}1</option>)}
        </select>
        <span className={sp.muted}>e.g. {firstLetter}PV-YYMM-{'1'.padStart(shownDigits, '0')}</span>
      </div>
      <div className={css.letters}>
        {rows.map((a) => (
          <label key={a.accountCode} className={css.letterRow}>
            <span className={sp.muted}>{a.accountCode}</span>
            <span className={css.letterName}>{a.accountName}</span>
            {a.fixedCash === true ? (
              /* The drawer: C on both papers (CPV / COR), minted off
                 roles.CASH — nothing to type, nothing the Save sends. */
              <input className={`${sp.input} ${css.letterBox}`} value="C" readOnly aria-label={`Letter for ${a.accountCode}`}
                title="The cash series is fixed at C — CPV for payments, COR for receipts" />
            ) : (
              <input
                className={`${sp.input} ${css.letterBox}`}
                aria-label={`Letter for ${a.accountCode}`}
                value={letterOf(a.accountCode, a.letter)}
                onChange={(e) => { setDraft((d) => ({ ...d, [a.accountCode]: e.target.value })); setNote(null); }}
                maxLength={3}
                placeholder="—"
              />
            )}
          </label>
        ))}
        {rows.length === 0 && <span className={sp.hint}>{q.isLoading ? 'Loading…' : 'No money accounts in this chart yet.'}</span>}
      </div>
      <div className={css.smallFoot}>
        <span className={sp.hint}>One letter per bank — Maybank M → 2990-MPV-2609-001; the cash drawer is always C.</span>
        <button type="button" className={sp.btnSolid} disabled={!dirty || save.isPending} onClick={submit}>
          {save.isPending ? 'Saving…' : 'Save numbering'}
        </button>
      </div>
      {note && <div className={css.warn}>{note}</div>}
    </section>
  );
};

/* ── The company's default bank (BANK_DEFAULT) ──────────────────────────────
   The owner's own lever (2026-08-30: 默认银行我可以自己maintenance): where a
   transfer payment lands, and what the PV / AP Payment "Paid From" pre-fills.
   Per company — switch companies in the top bar to set the other one's. Only
   money accounts are offered, and the server refuses anything else anyway. */
const DefaultBankCard = () => {
  const rolesQ = useAccountRoles();
  const accountsQ = useAccounts();
  const save = useSaveBankDefault();
  const toast = useToastOptional();
  const [choice, setChoice] = useState<string>('');
  const [note, setNote] = useState<string | null>(null);

  const money = (accountsQ.data?.accounts ?? []).filter((a) => a.is_active && a.acc_money === true);
  const current = rolesQ.data?.roles.BANK_DEFAULT ?? '';
  const value = choice || current;
  const dirty = !!choice && choice !== current;

  return (
    <section className={css.smallCard} aria-label="Default bank">
      <div className={css.defaultRow}>
        <span className={css.title}>Default bank</span>
        <span className={`${sp.cardSub} ${sp.grow}`}>When a merchant names none</span>
        <select className={`${sp.select} ${sp.compact}`} aria-label="Default bank account" value={value}
          onChange={(e) => { setChoice(e.target.value); setNote(null); }}
          disabled={rolesQ.isLoading || accountsQ.isLoading}>
          {!value && <option value="">{rolesQ.isLoading ? 'Loading…' : '— pick a bank / cash account —'}</option>}
          {money.map((a) => <option key={a.account_code} value={a.account_code}>{a.account_name}</option>)}
        </select>
        {dirty && (
          <button type="button" className={`${sp.btnPrimary} ${sp.small}`} disabled={save.isPending}
            onClick={() => save.mutate(choice, {
              onSuccess: () => { setChoice(''); toast?.success(`Default bank set to ${choice}`); },
              onError: (e) => setNote(e instanceof Error ? e.message : 'Not saved.'),
            })}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
      <div className={sp.hint}>Pre-fills every voucher’s Paid from; transfer payments land here.</div>
      {note && <div className={css.warn}>{note}</div>}
    </section>
  );
};

/* ── Bank statements — which accounts take one, and how each file reads
   (owner 2026-09-08: Bank Recon said no account was set up and nothing on
   any screen could set one up; and 别卡死读 column, 我怕未来 bank 可能换 format).
   Per company — the company this session works in — because the same bank
   pays different companies into different accounts. Every heading role takes
   SEVERAL names, comma-separated; a blank role falls back to the reader's
   built-in names, shown beside it. */
const HEADING_ROLES = [
  { key: 'date', label: 'Date headings' },
  { key: 'description', label: 'Description headings' },
  { key: 'reference', label: 'Reference headings (joined)' },
  { key: 'credit', label: 'Money-in headings' },
  { key: 'debit', label: 'Money-out headings' },
  { key: 'amount', label: 'Single amount heading' },
  { key: 'indicator', label: 'CR/DR heading' },
  { key: 'balance', label: 'Balance headings' },
] as const;
type HeadingKey = typeof HEADING_ROLES[number]['key'];
type ConfigForm = { accountCode: string; bankCode: string; accountNo: string; statementFormat: string; delimiter: string; amountFormat: string; creditIndicator: string } & Record<HeadingKey, string>;
const EMPTY_CONFIG: ConfigForm = {
  accountCode: '', bankCode: '', accountNo: '', statementFormat: 'CSV', delimiter: '', amountFormat: 'decimal', creditIndicator: 'CR',
  date: '', description: '', reference: '', credit: '', debit: '', amount: '', indicator: '', balance: '',
};
const joinHeadings = (h: string | string[] | undefined): string => (h == null ? '' : Array.isArray(h) ? h.join(', ') : h);
const splitHeadings = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);
const delimiterWords = (d: string | null): string => (d === '\t' || d === 'tab' ? 'tab' : d === '|' ? 'pipe |' : d === ';' ? 'semicolon ;' : 'comma');
const amountWords = (f: string): string => (f === 'integer-sen' ? 'integer sen' : '1,234.56');

const BankStatementsCard = () => {
  const cfgQ = useBankConfigs();
  const save = useSaveBankConfig();
  const accountsQ = useAccounts();
  const toast = useToastOptional();
  const money = (accountsQ.data?.accounts ?? []).filter((a) => a.acc_money === true && a.is_active);
  const nameOf = (code: string): string => (accountsQ.data?.accounts ?? []).find((a) => a.account_code === code)?.account_name ?? '';
  const [form, setForm] = useState<(ConfigForm & { editing: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ row: BankConfig; x: number; y: number } | null>(null);
  const configs = cfgQ.data?.configs ?? [];
  const defaults = cfgQ.data?.defaultHeadings ?? {};
  const set = (patch: Partial<ConfigForm>) => { setForm((f) => (f ? { ...f, ...patch } : f)); setError(null); };

  const edit = (c: BankConfig) => {
    setError(null);
    setForm({
      editing: true,
      accountCode: c.account_code, bankCode: c.bank_code, accountNo: c.account_no ?? '', statementFormat: c.statement_format,
      delimiter: c.delimiter === '\t' ? 'tab' : (c.delimiter ?? ''), amountFormat: c.amount_format, creditIndicator: c.credit_indicator,
      date: joinHeadings(c.column_map.date), description: joinHeadings(c.column_map.description), reference: joinHeadings(c.column_map.reference),
      credit: joinHeadings(c.column_map.credit), debit: joinHeadings(c.column_map.debit), amount: joinHeadings(c.column_map.amount),
      indicator: joinHeadings(c.column_map.indicator), balance: joinHeadings(c.column_map.balance),
    });
  };

  const submit = () => {
    if (!form) return;
    if (!form.accountCode || !form.bankCode.trim()) { setError('Pick the account and name its bank.'); return; }
    const columnMap: Record<string, string[]> = {};
    for (const r of HEADING_ROLES) { const list = splitHeadings(form[r.key]); if (list.length > 0) columnMap[r.key] = list; }
    const code = form.accountCode;
    save.mutate({
      accountCode: form.accountCode, bankCode: form.bankCode, accountNo: form.accountNo, statementFormat: form.statementFormat,
      delimiter: form.delimiter, amountFormat: form.amountFormat, creditIndicator: form.creditIndicator, isActive: true, columnMap,
    }, {
      onSuccess: () => { setForm(null); toast?.success(`${code} saved · upload its statements on Bank statements`); },
      onError: (e) => setError(refusalText(e, 'That account was not saved.')),
    });
  };

  const columns: Column<BankConfig>[] = [
    { key: 'account', label: 'Account', render: (c) => <span className={sp.muted}>{c.account_code}</span>, getValue: (c) => c.account_code },
    { key: 'name', label: 'Name', render: (c) => nameOf(c.account_code), getValue: (c) => nameOf(c.account_code) },
    {
      key: 'bank', label: 'Bank',
      render: (c) => <span className={css.bankCell}>{c.bank_code}{!c.is_active && <Tag tone="calm">Off</Tag>}</span>,
      getValue: (c) => c.bank_code,
    },
    { key: 'no', label: 'Account no.', render: (c) => <span className={sp.muted}>{c.account_no ?? '—'}</span>, getValue: (c) => c.account_no ?? '' },
    {
      key: 'file', label: 'File',
      render: (c) => <span className={sp.muted}>{c.statement_format} · {delimiterWords(c.delimiter)} · {amountWords(c.amount_format)}</span>,
      getValue: (c) => `${c.statement_format} · ${delimiterWords(c.delimiter)} · ${amountWords(c.amount_format)}`,
    },
    {
      key: 'heads', label: 'Headings',
      render: (c) => {
        const money2 = c.column_map.credit && c.column_map.debit
          ? `${joinHeadings(c.column_map.credit)} / ${joinHeadings(c.column_map.debit)}` : joinHeadings(c.column_map.amount);
        const said = [joinHeadings(c.column_map.date), money2, joinHeadings(c.column_map.balance)].filter(Boolean).join(' · ');
        return <span className={sp.muted}>{said || 'built-in names'}</span>;
      },
      getValue: (c) => joinHeadings(c.column_map.date),
    },
    {
      key: 'acts', label: '', align: 'right', disableSort: true, filterable: false,
      render: (c) => (
        <span className={sp.acts}>
          <button type="button" className={sp.more} aria-label={`More for ${c.account_code}`} title="Edit"
            onClick={(e) => { e.stopPropagation(); setMenu({ row: c, x: e.clientX, y: e.clientY }); }}>
            <MoreHorizontal size={14} />
          </button>
        </span>
      ),
    },
  ];

  return (
    <section className={css.flatCard} aria-label="Bank statements">
      <div className={css.flatHead}>
        <span className={css.title}>Bank statements</span>
        <span className={sp.cardSub}>Which of this company’s accounts take a statement file, and how each file reads</span>
        <span className={sp.grow} />
        <button type="button" className={sp.btn} onClick={() => { setError(null); setForm({ ...EMPTY_CONFIG, editing: false }); }}>
          <Plus size={14} /> Add account
        </button>
      </div>
      <DataTable<BankConfig>
        tableId="recon-statements"
        exportName="recon-statements"
        columns={columns}
        rows={cfgQ.isLoading ? null : configs}
        loading={cfgQ.isLoading}
        error={cfgQ.isError ? `The statement setups did not load — ${refusalText(cfgQ.error, 'try again.')}` : null}
        emptyLabel="No account takes a statement yet — Bank statements cannot read a file until one does."
        getRowKey={(c) => c.id}
        onRowDoubleClick={edit}
        contextMenu={(c) => [{ label: 'Edit', onClick: () => edit(c) }]}
        freezeHeight="off"
      />
      {menu && (
        <PopMenu x={menu.x} y={menu.y} label={`${menu.row.account_code} menu`} onClose={() => setMenu(null)}
          items={[{ label: 'Edit', onClick: () => edit(menu.row) }]} />
      )}
      {form && (
        <SetupModal
          wide
          title={form.editing ? `Statement · ${form.accountCode}` : 'Add a statement account'}
          sub="Headings, never positions: name every caption the bank has used, comma-separated."
          okLabel="Save"
          busyLabel="Saving…"
          busy={save.isPending}
          error={error}
          onOk={submit}
          onCancel={() => setForm(null)}
        >
          <Field label="Account">
            <select className={sp.select} aria-label="Statement account" value={form.accountCode} disabled={form.editing}
              onChange={(e) => set({ accountCode: e.target.value })}>
              <option value="">— pick the bank account —</option>
              {money.map((a) => <option key={a.account_code} value={a.account_code}>{a.account_code} · {a.account_name}</option>)}
            </select>
          </Field>
          <Field label="Bank" w="22%">
            <input className={sp.input} aria-label="Bank" value={form.bankCode} placeholder="HLB / MBB / PBB…" onChange={(e) => set({ bankCode: e.target.value })} />
          </Field>
          <Field label="Account number" w="26%">
            <input className={sp.input} aria-label="Account number" value={form.accountNo} placeholder="the file must mention it" onChange={(e) => set({ accountNo: e.target.value })} />
          </Field>
          <Field label="File" w="22%">
            <select className={sp.select} aria-label="File format" value={form.statementFormat} onChange={(e) => set({ statementFormat: e.target.value })}>
              <option value="CSV">CSV</option><option value="TXT">TXT</option>
            </select>
          </Field>
          <Field label="Delimiter" w="22%">
            <select className={sp.select} aria-label="Delimiter" value={form.delimiter} onChange={(e) => set({ delimiter: e.target.value })}>
              <option value="">comma</option><option value="|">pipe |</option><option value="tab">tab</option><option value=";">semicolon ;</option>
            </select>
          </Field>
          <Field label="Amount format" w="26%">
            <select className={sp.select} aria-label="Amount format" value={form.amountFormat} onChange={(e) => set({ amountFormat: e.target.value })}>
              <option value="decimal">1,234.56</option><option value="integer-sen">integer sen · 000000123456</option>
            </select>
          </Field>
          <Field label="Credit indicator" w="22%">
            <input className={sp.input} aria-label="Credit indicator" value={form.creditIndicator} onChange={(e) => set({ creditIndicator: e.target.value })} />
          </Field>
          {HEADING_ROLES.map((r) => (
            <Field key={r.key} label={r.label}>
              <input className={sp.input} aria-label={r.label} value={form[r.key]}
                onChange={(e) => set({ [r.key]: e.target.value } as Partial<ConfigForm>)}
                placeholder={(defaults[r.key] ?? []).slice(0, 3).join(', ') || '—'} />
            </Field>
          ))}
          <div className={`${sp.hint} ${css.fullRow}`}>
            A blank heading uses the reader’s built-in names (shown greyed). Save, then upload on Bank statements.
          </div>
        </SetupModal>
      )}
    </section>
  );
};

/* ── Bank recognition rules — how a statement credit is known to be a payout
   (2026-09-02). Seed-only since layer 4; now the owner fixes a reworded bank
   narration himself. GLOBAL like the report layouts — a payout reads the same
   in every company's statement. The server compiles every regex at write time
   and its refusal sentence is shown verbatim. Nothing is deleted: Remove
   switches a rule off and the row stays (owner question g4). */
const badPattern = (p: string): boolean => {
  if (!p.trim()) return true;
  try { new RegExp(p, 'i'); return false; } catch { return true; }
};
const BAD_PATTERN = 'That pattern is not a valid regular expression, so it was not saved.';

const BankRulesCard = () => {
  const rulesQ = useBankRules();
  const save = useSaveBankRule();
  const createM = useCreateBankRule();
  const askConfirm = useConfirm();
  const toast = useToastOptional();
  const [drafts, setDrafts] = useState<Record<number, Partial<BankRule> | undefined>>({});
  const [note, setNote] = useState<string | null>(null);
  const [newRule, setNewRule] = useState<{ acquirerCode: string; pattern: string }>({ acquirerCode: '', pattern: '' });

  const rules = rulesQ.data?.rules ?? [];
  const acquirers = [...new Set(rules.map((r) => r.acquirer_code))];

  const rowValue = (r: BankRule): BankRule => ({ ...r, ...(drafts[r.id] ?? ({} as Partial<BankRule>)) });
  const edit = (id: number, patch: Partial<BankRule>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));
    setNote(null);
  };
  const dropDraft = (id: number) => setDrafts((prev) => { const { [id]: _gone, ...rest } = prev; return rest; });
  const switchTo = (r: BankRule, on: boolean) => save.mutate({ id: r.id, isActive: on }, {
    onSuccess: () => toast?.success(`${r.acquirer_code} rule switched ${on ? 'on' : 'off'} for every company`),
    onError: (e) => setNote(refusalText(e, 'Rule not saved.')),
  });
  const switchOff = async (r: BankRule) => {
    const ok = await askConfirm({
      title: `Remove the ${r.acquirer_code} rule?`,
      body: `Statement credits matching “${r.pattern}” are no longer recognised as ${r.acquirer_code} payouts. Every company shares this rule. It is switched off, not deleted — its switch brings it back.`,
      confirmLabel: 'Switch off',
      danger: true,
    });
    if (ok) switchTo(r, false);
  };

  return (
    <section className={css.flatCard} aria-label="Bank recognition rules">
      <div className={css.flatHead}>
        <span className={css.title}>Bank recognition rules</span>
        <span className={sp.cardSub}>Spots card payouts on bank statements · shared</span>
      </div>
      <div className={sp.scroll}>
        <table className={`${sp.table} ${css.rules}`}>
          <thead>
            <tr>
              <th>Acquirer</th>
              <th>Pattern · regex, any case</th>
              <th>Looks in</th>
              <th>Order</th>
              <th>Active</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => {
              const v = rowValue(r);
              const d = drafts[r.id];
              const dirty = d != null && Object.keys(d).length > 0;
              return (
                <tr key={r.id} className={r.is_active ? undefined : css.offRule}>
                  <td className={css.acq}>{r.acquirer_code}</td>
                  <td>
                    <input
                      className={`${sp.input} ${sp.compact} ${css.pattern} ${badPattern(v.pattern) ? sp.inputBad : ''}`}
                      aria-label={`Pattern for ${r.acquirer_code} rule ${r.id}`}
                      value={v.pattern}
                      onChange={(e) => edit(r.id, { pattern: e.target.value })}
                    />
                  </td>
                  <td>
                    <select className={`${sp.select} ${sp.compact}`} aria-label={`Looks in for ${r.acquirer_code} rule ${r.id}`} value={v.match_field}
                      onChange={(e) => edit(r.id, { match_field: e.target.value as BankRule['match_field'] })}>
                      <option value="both">both</option>
                      <option value="description">description</option>
                      <option value="reference">reference</option>
                    </select>
                  </td>
                  <td>
                    {/* A number, as today: the list reads by acquirer, the
                        matcher reads every rule by this order. */}
                    <NumberInput
                      className={`${sp.input} ${sp.compact} ${css.order}`}
                      aria-label={`Order for ${r.acquirer_code} rule ${r.id}`}
                      value={v.sort_order}
                      sign="unsigned"
                      decimal={false}
                      onValueChange={(n) => edit(r.id, { sort_order: n ?? 0 })} />
                  </td>
                  <td>
                    <Switch on={r.is_active} label={`${r.acquirer_code} rule ${r.id} active`} disabled={save.isPending}
                      onClick={() => switchTo(r, !r.is_active)} />
                  </td>
                  <td className={css.ruleActs}>
                    <span className={sp.acts}>
                      {dirty && (
                        <>
                          <button type="button" className={css.undo} onClick={() => dropDraft(r.id)}>Undo</button>
                          <button type="button" className={`${sp.btnPrimary} ${sp.small}`} disabled={save.isPending}
                            onClick={() => {
                              if (d.pattern !== undefined && badPattern(d.pattern)) { setNote(BAD_PATTERN); return; }
                              save.mutate({
                                id: r.id,
                                ...(d.pattern !== undefined ? { pattern: d.pattern } : {}),
                                ...(d.match_field !== undefined ? { matchField: d.match_field } : {}),
                                ...(d.sort_order !== undefined ? { sortOrder: d.sort_order } : {}),
                              }, {
                                onSuccess: () => { dropDraft(r.id); setNote(null); toast?.success(`${r.acquirer_code} rule saved for every company`); },
                                onError: (e) => setNote(refusalText(e, 'Rule not saved.')),
                              });
                            }}>
                            Save
                          </button>
                        </>
                      )}
                      <button type="button" className={`${sp.iconBtn} ${r.is_active ? sp.iconDanger : sp.iconOff}`}
                        aria-label={`Remove the ${r.acquirer_code} rule ${r.id}`}
                        title={r.is_active ? 'Remove the rule — it is switched off, not deleted' : 'Switched off · its switch brings it back'}
                        disabled={!r.is_active || save.isPending}
                        onClick={() => void switchOff(r)}>
                        <X size={13} />
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
            {rules.length === 0 && (
              <tr><td colSpan={6} className={sp.empty}>{rulesQ.isLoading ? 'Loading the rules…' : 'No recognition rule yet.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Add a rule — the acquirer and the pattern are the essentials;
          everything else starts at its default and is edited above. */}
      <div className={css.addRule}>
        <select className={`${sp.select} ${sp.compact}`} aria-label="New rule acquirer" value={newRule.acquirerCode}
          onChange={(e) => { setNewRule((p) => ({ ...p, acquirerCode: e.target.value })); setNote(null); }}>
          <option value="">Acquirer</option>
          {acquirers.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <input className={`${sp.input} ${sp.compact} ${css.newPattern}`} aria-label="New rule pattern" placeholder="e.g. PBB-PBCS"
          value={newRule.pattern}
          onChange={(e) => { setNewRule((p) => ({ ...p, pattern: e.target.value })); setNote(null); }} />
        <button type="button" className={`${sp.btnPrimary} ${sp.small}`}
          disabled={!newRule.acquirerCode || !newRule.pattern.trim() || createM.isPending}
          onClick={() => {
            if (badPattern(newRule.pattern)) { setNote(BAD_PATTERN); return; }
            const acq = newRule.acquirerCode;
            createM.mutate({ acquirerCode: acq, pattern: newRule.pattern.trim() }, {
              onSuccess: () => { setNewRule({ acquirerCode: '', pattern: '' }); setNote(null); toast?.success(`${acq} rule added for every company`); },
              onError: (e) => setNote(refusalText(e, 'Rule not added.')),
            });
          }}>
          Add rule
        </button>
        {note && <span className={css.warn}>{note}</span>}
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

/** "Pinelabs, pine labs ,," → ["Pinelabs", "pine labs"] — the names as typed,
    blanks dropped. The server trims, de-duplicates and refuses a name another
    merchant already answers to. */
const namesOf = (text: string): string[] => text.split(',').map((s) => s.trim()).filter(Boolean);

const MerchantForm = ({ merchant, companies, onDone }: {
  merchant: MaintenanceMerchant;
  companies: MaintenanceCompany[];
  /** Back to the page, with what the save did to the reports already uploaded. */
  onDone: (said?: string) => void;
}) => {
  const save = useSaveAcquirerSetup();
  const rematch = useRematch();
  const toast = useToastOptional();
  const [matching, setMatching] = useState(false);
  const [form, setForm] = useState({
    statementFormat: merchant.statement_format ?? '',
    hasUniqueRef: merchant.has_unique_ref == null ? '' : String(merchant.has_unique_ref),
    feeMethod: merchant.fee_method ?? '',
    dateToleranceDays: String(merchant.date_tolerance_days),
    soNames: (merchant.so_names ?? []).join(', '),
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

  /* Each company that uses this merchant, one after another — the rule is
     shared, the reports are each company's own. */
  const matchAgain = async () => {
    setMatching(true);
    const said: string[] = [];
    for (const co of companies.filter((c) => merchant.byCompany[String(c.id)]?.enabled)) {
      try {
        const r = await rematch.mutateAsync({ companyId: co.id, acquirerCode: merchant.code });
        said.push(r.lines === 0
          ? `${co.name}: no open lines`
          : `${co.name}: ${r.matched} line${r.matched === 1 ? '' : 's'} matched by reference, ready to confirm`
            + (r.newlyMatched > 0 ? ` (${r.newlyMatched} new)` : ''));
      } catch (e) {
        said.push(`${co.name}: not matched again — ${refusalText(e, 'try saving again')}`);
      }
    }
    setMatching(false);
    toast?.success(`${merchant.code} layout saved · every company reads its files this way · matched again`);
    onDone(`${merchant.display_name} saved.${said.length > 0 ? ` Reports matched again — ${said.join('; ')}.` : ''}`);
  };

  const submit = () => {
    if (!/^\d+$/.test(form.dateToleranceDays.trim())) { setMapError('Date tolerance is a whole number of days.'); return; }
    const missing = requiredHeadings.filter((k) => !String(headings[k] ?? '').trim());
    if (missing.length > 0) {
      setMapError(`Fill in the ${missing.map((k) => HEADING_FIELDS.find((f) => f.key === k)?.label.replace(' heading', '')).join(', ')} heading${missing.length > 1 ? 's' : ''} — a report cannot be read without ${missing.length > 1 ? 'them' : 'it'}.`);
      return;
    }
    setMapError('');
    const soNames = namesOf(form.soNames);
    const hasUniqueRef = form.hasUniqueRef === '' ? null : form.hasUniqueRef === 'true';
    const dateToleranceDays = Number(form.dateToleranceDays) || 0;
    /* What decides a match: the names, the drift, the unique reference. When
       one of them changes, the reports already uploaded are matched again
       under the new rule (owner 2026-10-21: 已经上传的报告也重新对一次). */
    const ruleChanged = soNames.join('\n').toUpperCase() !== (merchant.so_names ?? []).join('\n').toUpperCase()
      || dateToleranceDays !== merchant.date_tolerance_days
      || hasUniqueRef !== merchant.has_unique_ref;
    save.mutate({
      code: merchant.code,
      statementFormat: form.statementFormat || null,
      hasUniqueRef,
      feeMethod: form.feeMethod || null,
      dateToleranceDays,
      soNames,
      columnMap: Object.fromEntries(
        Object.entries(headings).map(([k, v]) => [k, String(v).trim()]).filter(([, v]) => v !== ''),
      ),
    }, {
      onSuccess: () => {
        if (ruleChanged) { void matchAgain(); return; }
        toast?.success(`${merchant.code} layout saved · every company reads its files this way`);
        onDone();
      },
    });
  };

  return (
    <SetupModal
      wide
      title={`${merchant.code} · how the file reads`}
      sub={`Shared by every company. Name the heading the file uses for each figure. Every company reads ${merchant.display_name}’s file this way.`}
      okLabel="Save"
      busyLabel={matching ? 'Matching the reports again…' : 'Saving…'}
      busy={save.isPending || matching}
      error={mapError || null}
      onOk={submit}
      onCancel={() => onDone()}
    >
      <Field label="File" w="23%">
        <select className={sp.select} value={form.statementFormat} aria-label={`${merchant.code} statement format`}
          onChange={(e) => setForm({ ...form, statementFormat: e.target.value })}>
          <option value="">not known</option><option value="CSV">CSV</option>
          <option value="XLSX">XLSX</option><option value="PDF">PDF</option>
        </select>
      </Field>
      <Field label="Unique reference" w="23%">
        <select className={sp.select} value={form.hasUniqueRef} aria-label={`${merchant.code} unique reference`}
          onChange={(e) => setForm({ ...form, hasUniqueRef: e.target.value })}>
          <option value="">not known</option><option value="true">yes</option><option value="false">no</option>
        </select>
      </Field>
      <Field label="Fee shown as" w="32%">
        <select className={sp.select} value={form.feeMethod} aria-label={`${merchant.code} fee method`}
          onChange={(e) => setForm({ ...form, feeMethod: e.target.value })}>
          <option value="">not known</option>
          <option value="stated">stated per line</option>
          <option value="gross-minus-net">gross minus net</option>
          <option value="prorated-summary">one total for the statement</option>
        </select>
      </Field>
      <Field label="Date tolerance (days)" w="14%">
        <input className={sp.input} value={form.dateToleranceDays} aria-label={`${merchant.code} date tolerance`} inputMode="numeric"
          onChange={(e) => setForm({ ...form, dateToleranceDays: e.target.value })} />
      </Field>
      {form.hasUniqueRef === 'false' && (
        <div className={`${sp.note} ${sp.noteWarn} ${css.fullRow}`}>
          <AlertTriangle size={14} />
          <span>Without a unique reference nothing from {merchant.code} can be confirmed automatically — every line will be matched by hand.</span>
        </div>
      )}
      {HEADING_FIELDS.map((f) => {
        const required = requiredHeadings.includes(f.key);
        return (
          <Field key={f.key} label={`${f.label}${required ? ' *' : ''}`}>
            <input
              className={required && !headings[f.key] ? `${sp.input} ${sp.inputBad}` : sp.input}
              value={headings[f.key] ?? ''} placeholder={f.hint}
              aria-label={`${merchant.code} ${f.label}`}
              onChange={(e) => setHeadings({ ...headings, [f.key]: e.target.value })}
            />
          </Field>
        );
      })}
      {/* Owner 2026-10-21: 「Pinelabs=AEON，Public=PBB」 — the sales team picks
          the terminal's or the bank's everyday name on a payment, and a sale
          keyed that way must still be this merchant's. */}
      <Field label="Also keyed on Sales Orders as" w="100%"
        hint={`The names the sales team picks for ${merchant.display_name} on a payment, separated by commas. A payment keyed under one of them counts as ${merchant.display_name}’s. Saving matches the reports already uploaded again.`}>
        <input className={sp.input} value={form.soNames} placeholder="e.g. Pinelabs"
          aria-label={`${merchant.code} also keyed as`}
          onChange={(e) => setForm({ ...form, soNames: e.target.value })} />
      </Field>
    </SetupModal>
  );
};

export default SettlementSetup;
