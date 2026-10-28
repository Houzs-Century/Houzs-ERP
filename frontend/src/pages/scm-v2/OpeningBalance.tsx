// ----------------------------------------------------------------------------
// OpeningBalance — Finance › Setup › Opening Balance (owner 2026-10-28:
// 「然后确定一下我是会有一个opening balance maintainence 表是吗？」 — yes; and
// 「这个你帮我导入哦」: the import fills it, this page keeps it until he calls the
// old book's last day final and locks it). AutoCount's own Opening Balance
// screen, in the ERP:
//   • the check — the clearing account reads nil when the opening balances;
//   • Accounts — every account at its opening balance (the OPENING journal);
//   • Creditors / Other debtors — the opening papers, party by party;
//   • Stock — the opening stock per bucket, what the statements open on.
// Every save re-posts on the server (backend/src/scm/routes/accounting-opening.ts);
// a locked opening refuses them all.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lock, LockOpen, Plus, Trash2 } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  OPENING_BUCKETS, useCancelOpeningPaper, useCreateOpeningPaper, useLockOpening, useOpeningBalance, useSaveOpeningAccounts, useSaveOpeningStock,
  useUpdateOpeningPaper, type OpeningAccount, type OpeningBucket, type OpeningPaper, type OpeningPaperKind, type OpeningParty,
} from '../../vendor/scm/lib/opening-balance-queries';
import { useSuppliers } from '../../vendor/scm/lib/suppliers-queries';
import { useOtherDebtors } from '../../vendor/scm/lib/accounting-queries';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { DateField } from '../../vendor/scm/components/DateField';
import { Modal } from '../../vendor/scm/components/Modal';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { fmtDateOrDash, fmtSen } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';

type Tab = 'accounts' | 'creditors' | 'debtors' | 'stock';
const TABS: Array<[Tab, string]> = [['accounts', 'Accounts · 户口'], ['creditors', 'Creditors · 供应商'], ['debtors', 'Other debtors · 其他欠款人'], ['stock', 'Stock · 库存']];

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)' };
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const th: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'left', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em',
  textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'middle', borderBottom: '1px solid var(--border-weak, #efede6)' };
const tabBtn = (on: boolean): React.CSSProperties => ({
  padding: '6px 12px', fontSize: 'var(--fs-13)', cursor: 'pointer', border: 'none',
  background: on ? 'var(--c-ink)' : 'transparent', color: on ? 'var(--c-cream)' : 'var(--c-ink)',
});
const good = 'var(--c-success, #2f6b2f)';
const bad = 'var(--c-danger, #a5321f)';

const Stat = ({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) => (
  <div className={styles.card} style={{ padding: 'var(--space-3, 12px) var(--space-4, 16px)', minWidth: 0 }}>
    <div style={soft}>{label}</div>
    <div style={{ fontSize: 'var(--fs-20, 20px)', fontWeight: 650, fontVariantNumeric: 'tabular-nums', color: tone }}>{value}</div>
    {sub ? <div style={soft}>{sub}</div> : null}
  </div>
);

export const OpeningBalance = () => {
  const q = useOpeningBalance();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'accounts') as Tab;
  const setTab = (t: Tab) => { const next = new URLSearchParams(params); next.set('tab', t); setParams(next, { replace: true }); };
  const lock = useLockOpening();
  const [confirm, setConfirm] = useState<null | 'lock' | 'unlock'>(null);

  const d = q.data && q.data.booksStart ? q.data : null;
  const header = (
    <PageHeader
      eyebrow="Setup"
      title="Opening Balance · 开账余额"
      actions={d ? (d.locked
        ? <Button variant="secondary" size="sm" onClick={() => setConfirm('unlock')}><LockOpen size={16} strokeWidth={1.75} /> Unlock · 解锁</Button>
        : <Button variant="primary" size="sm" disabled={d.check.clearingSen !== 0} title={d.check.clearingSen !== 0 ? 'The opening must balance before it is locked.' : undefined} onClick={() => setConfirm('lock')}>
            <Lock size={16} strokeWidth={1.75} /> Lock · 锁定
          </Button>) : undefined}
    />
  );
  if (q.isLoading) return <div className="space-y-4">{header}<section className={styles.card}><div className={styles.cardBody} style={soft}>Loading the opening…</div></section></div>;
  if (q.isError) return <div className="space-y-4">{header}<section className={styles.card}><div className={styles.cardBody} style={{ color: bad }}>The opening could not be loaded — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</div></section></div>;
  if (!d) return <div className="space-y-4">{header}<section className={styles.card}><div className={styles.cardBody} style={soft}>This company has no opening yet — its books have no start day.</div></section></div>;

  const locked = d.locked != null;
  const owe = (ps: OpeningParty[]) => ps.reduce((s, p) => s + p.netSen, 0);
  const papers = (ps: OpeningParty[]) => ps.reduce((s, p) => s + p.papers.length, 0);
  return (
    <div className="space-y-4">
      {header}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-4, 16px)' }}>
        <Stat label="Books start · 账本开始" value={fmtDateOrDash(d.booksStart)} sub={<>Opening dated {fmtDateOrDash(d.openingDate)}{d.journal ? <> · {d.journal.jeNo}</> : null}</>} />
        <Stat
          label="Opening difference · 开账差额"
          value={fmtSen(d.check.clearingSen)}
          tone={d.check.clearingSen === 0 ? good : bad}
          sub={d.check.clearingSen === 0 ? '✓ Balanced — 平' : `✗ ${d.check.clearingCode} must read nil`}
        />
        <Stat label="Creditors · 供应商" value={fmtSen(owe(d.creditors))} sub={`${d.creditors.length} suppliers · ${papers(d.creditors)} papers`} />
        <Stat label="Other debtors · 其他欠款人" value={fmtSen(owe(d.debtors))} sub={`${d.debtors.length} debtors · ${papers(d.debtors)} papers`} />
        <Stat label="Opening stock · 库存" value={fmtSen(d.stock.totalSen)} sub={locked ? <>Locked by {d.locked?.by ?? '—'} · 已锁定</> : 'Open — 可修改'} />
      </div>

      <section className={styles.card}>
        <div className={styles.cardHeader} style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
          <div role="tablist" aria-label="Opening balance" style={{ display: 'inline-flex', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6, overflow: 'hidden', flexWrap: 'wrap' }}>
            {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} style={tabBtn(tab === k)} onClick={() => setTab(k)}>{label}</button>)}
          </div>
          <span style={soft}>{d.check.clearingCode} is the other side of every opening paper; it balances itself.</span>
        </div>
        <div className={styles.cardBody} style={{ overflowX: 'auto' }}>
          {tab === 'accounts' && <AccountsTab accounts={d.accounts} locked={locked} />}
          {tab === 'creditors' && <PartiesTab side="creditors" parties={d.creditors} locked={locked} openingDate={d.openingDate} />}
          {tab === 'debtors' && <PartiesTab side="debtors" parties={d.debtors} locked={locked} openingDate={d.openingDate} />}
          {tab === 'stock' && <StockTab stock={d.stock} locked={locked} />}
        </div>
      </section>

      {confirm && (
        <Modal title={confirm === 'lock' ? 'Lock the opening · 锁定开账' : 'Unlock the opening · 解锁'} onClose={() => setConfirm(null)} width="min(520px, 100%)">
          <div className="space-y-4">
            <p>{confirm === 'lock'
              ? `Lock the opening at ${fmtDateOrDash(d.openingDate)}? Nothing on this page can change until it is unlocked.`
              : 'Unlock the opening? Its accounts, papers and stock can be changed again.'}</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="secondary" size="sm" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button variant="primary" size="sm" disabled={lock.isPending} onClick={() => lock.mutate(confirm, { onSuccess: () => setConfirm(null) })}>
                {confirm === 'lock' ? 'Lock · 锁定' : 'Unlock · 解锁'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

/* ── Accounts ─────────────────────────────────────────────────────────────── */

type DraftLine = { code: string; name: string; drSen: number; crSen: number };

const AccountsTab = ({ accounts, locked }: { accounts: OpeningAccount[]; locked: boolean }) => {
  const save = useSaveOpeningAccounts();
  const [draft, setDraft] = useState<DraftLine[] | null>(null);
  const [newCode, setNewCode] = useState('');
  const rows: DraftLine[] = draft ?? accounts.map((a) => ({ code: a.code, name: a.name, drSen: a.drSen, crSen: a.crSen }));
  const dr = rows.reduce((s, r) => s + r.drSen, 0);
  const cr = rows.reduce((s, r) => s + r.crSen, 0);
  const set = (i: number, patch: Partial<DraftLine>) => setDraft(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-4">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={soft}>Every account at its opening balance — the creditors, other debtors and stock are on their own tabs.</span>
        {!locked && (draft
          ? <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" size="sm" onClick={() => setDraft(null)}>Cancel</Button>
              <Button variant="primary" size="sm" disabled={save.isPending}
                onClick={() => save.mutate(rows.filter((r) => r.drSen > 0 || r.crSen > 0).map(({ code, drSen, crSen }) => ({ code, drSen, crSen })), { onSuccess: () => setDraft(null) })}>
                Save · 保存
              </Button>
            </div>
          : <Button variant="secondary" size="sm" onClick={() => setDraft(rows)}>Edit · 修改</Button>)}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
        <thead><tr><th style={th}>Account</th><th style={th}>Name</th><th style={{ ...th, textAlign: 'right' }}>Debit · 借</th><th style={{ ...th, textAlign: 'right' }}>Credit · 贷</th>{draft ? <th style={th} /> : null}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.code}>
              <td style={{ ...td, ...mono }}>{r.code}</td>
              <td style={td}>{r.name}</td>
              <td style={{ ...td, ...num }}>{draft ? <MoneyInput valueSen={r.drSen} onCommit={(v) => set(i, { drSen: v ?? 0, crSen: v ? 0 : r.crSen })} /> : (r.drSen ? fmtSen(r.drSen) : '')}</td>
              <td style={{ ...td, ...num }}>{draft ? <MoneyInput valueSen={r.crSen} onCommit={(v) => set(i, { crSen: v ?? 0, drSen: v ? 0 : r.drSen })} /> : (r.crSen ? fmtSen(r.crSen) : '')}</td>
              {draft ? <td style={td}><button type="button" aria-label={`Remove ${r.code}`} style={{ border: 'none', background: 'none', cursor: 'pointer' }} onClick={() => setDraft(rows.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td> : null}
            </tr>
          ))}
          {draft && (
            <tr>
              <td style={td} colSpan={2}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="Account code, e.g. 310-0010" aria-label="New account code" style={{ ...mono, padding: '4px 6px', width: 200 }} />
                  <Button variant="secondary" size="sm" disabled={!newCode.trim() || rows.some((r) => r.code === newCode.trim())}
                    onClick={() => { setDraft([...rows, { code: newCode.trim(), name: '(new line)', drSen: 0, crSen: 0 }]); setNewCode(''); }}>
                    <Plus size={14} /> Add line
                  </Button>
                </span>
              </td>
              <td style={td} colSpan={3} />
            </tr>
          )}
          <tr>
            <td style={{ ...td, fontWeight: 600 }} colSpan={2}>Total · 合计</td>
            <td style={{ ...td, ...num, fontWeight: 600 }}>{fmtSen(dr)}</td>
            <td style={{ ...td, ...num, fontWeight: 600 }}>{fmtSen(cr)}</td>
            {draft ? <td style={td} /> : null}
          </tr>
        </tbody>
      </table>
      <div style={soft}>Debit less credit here, {fmtSen(dr - cr)}, is what the creditors, other debtors and stock stand against — the clearing balances it.</div>
    </div>
  );
};

/* ── Creditors / Other debtors ────────────────────────────────────────────── */

const KIND_WORD: Record<OpeningPaperKind, string> = { API: 'Bill · 欠款单', SCN: 'Credit · 抵扣', ODB: 'Bill · 欠款单', ODR: 'Credit · 抵扣' };

const PartiesTab = ({ side, parties, locked, openingDate }: { side: 'creditors' | 'debtors'; parties: OpeningParty[]; locked: boolean; openingDate: string }) => {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const party = parties.find((p) => p.partyId === open) ?? null;
  const columns = useMemo<Column<OpeningParty>[]>(() => [
    { key: 'code', label: side === 'creditors' ? 'Code' : 'Debtor', render: (r) => (side === 'creditors' ? <span style={mono}>{r.code ?? '—'}</span> : r.name), getValue: (r) => (side === 'creditors' ? r.code ?? '' : r.name) },
    ...(side === 'creditors' ? [
      { key: 'name', label: 'Name', render: (r: OpeningParty) => r.name, getValue: (r: OpeningParty) => r.name },
      { key: 'control', label: 'Control', render: (r: OpeningParty) => <span style={mono}>{r.control ?? '—'}</span>, getValue: (r: OpeningParty) => r.control ?? '' },
    ] as Column<OpeningParty>[] : []),
    { key: 'papers', label: 'Papers', align: 'right', render: (r) => r.papers.length, getValue: (r) => r.papers.length },
    { key: 'owing', label: 'Bills', align: 'right', render: (r) => fmtSen(r.owingSen), getValue: (r) => r.owingSen, exportValue: (r) => r.owingSen / 100, exportFormat: 'money', total: (rs) => fmtSen(rs.reduce((s, r) => s + r.owingSen, 0)) },
    { key: 'credit', label: 'Credits', align: 'right', render: (r) => (r.creditSen ? fmtSen(r.creditSen) : <span style={soft}>—</span>), getValue: (r) => r.creditSen, exportValue: (r) => r.creditSen / 100, exportFormat: 'money', total: (rs) => fmtSen(rs.reduce((s, r) => s + r.creditSen, 0)) },
    { key: 'net', label: side === 'creditors' ? 'We owe · 欠他' : 'Owes us · 欠我们', align: 'right', render: (r) => <span style={{ fontWeight: 600 }}>{fmtSen(r.netSen)}</span>, getValue: (r) => r.netSen, exportValue: (r) => r.netSen / 100, exportFormat: 'money', total: (rs) => fmtSen(rs.reduce((s, r) => s + r.netSen, 0)) },
    {
      key: 'settled', label: 'Settled since · 已冲', align: 'right',
      render: (r) => { const s = r.papers.reduce((t, p) => t + p.settledSen, 0); return s ? fmtSen(s) : <span style={soft}>—</span>; },
      getValue: (r) => r.papers.reduce((t, p) => t + p.settledSen, 0),
    },
  ], [side]);
  return (
    <div className="space-y-4">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={soft}>{side === 'creditors' ? 'Each supplier by its opening bills and credits — AutoCount\'s creditor aging at the opening day.' : 'Each other debtor by its opening bills and credits.'} Click a row for its papers.</span>
        {!locked && <Button variant="secondary" size="sm" onClick={() => setAdding(true)}><Plus size={14} /> Add a paper</Button>}
      </div>
      <DataTable<OpeningParty>
        tableId={`opening-${side}`}
        exportName={`opening-${side}`}
        exportXlsx
        columns={columns}
        rows={parties}
        emptyLabel={side === 'creditors' ? 'No opening creditor.' : 'No opening other debtor.'}
        getRowKey={(r) => r.partyId}
        onRowClick={(r) => setOpen(r.partyId)}
      />
      {party && <PapersModal party={party} locked={locked} openingDate={openingDate} onClose={() => setOpen(null)} />}
      {adding && <AddPaperModal side={side} openingDate={openingDate} onClose={() => setAdding(false)} />}
    </div>
  );
};

const PapersModal = ({ party, locked, openingDate, onClose }: { party: OpeningParty; locked: boolean; openingDate: string; onClose: () => void }) => {
  const update = useUpdateOpeningPaper();
  const cancel = useCancelOpeningPaper();
  const [editing, setEditing] = useState<OpeningPaper | null>(null);
  return (
    <Modal title={`${party.code ? `${party.code} · ` : ''}${party.name}`} onClose={onClose} width="min(980px, 100%)">
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
          <thead><tr>{['Paper', 'Kind', 'Date', 'Reference', 'Note', 'Amount', 'Settled', ''].map((h, i) => <th key={h || i} style={{ ...th, textAlign: i >= 5 && i <= 6 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
          <tbody>
            {party.papers.map((p) => (
              <tr key={p.id}>
                <td style={{ ...td, ...mono }}>{p.no}</td>
                <td style={td}>{KIND_WORD[p.kind]}</td>
                <td style={td}>{fmtDateOrDash(p.date)}</td>
                <td style={td}>{p.ref ?? <span style={soft}>—</span>}</td>
                <td style={{ ...td, ...soft, maxWidth: 280 }}>{p.note ?? ''}</td>
                <td style={{ ...td, ...num }}>{fmtSen(p.amountSen)}</td>
                <td style={{ ...td, ...num }}>{p.settledSen ? fmtSen(p.settledSen) : <span style={soft}>—</span>}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {!locked && (
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <Button variant="secondary" size="sm" onClick={() => setEditing(p)}>Edit</Button>
                      <Button variant="secondary" size="sm" disabled={p.settledSen > 0 || cancel.isPending} title={p.settledSen > 0 ? 'Money has been settled against it.' : undefined}
                        onClick={() => cancel.mutate({ kind: p.kind, id: p.id })}>Cancel</Button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <PaperForm
          title={`Edit ${editing.no}`}
          openingDate={openingDate}
          initial={{ date: editing.date, ref: editing.ref ?? '', amountSen: editing.amountSen }}
          withRef={editing.kind === 'API' || editing.kind === 'SCN'}
          floorSen={editing.settledSen}
          pending={update.isPending}
          onCancel={() => setEditing(null)}
          onSave={(v) => update.mutate({ kind: editing.kind, id: editing.id, date: v.date, ref: v.ref || null, amountSen: v.amountSen }, { onSuccess: () => setEditing(null) })}
        />
      )}
    </Modal>
  );
};

type PaperValues = { date: string; ref: string; amountSen: number };

const PaperForm = ({ title, openingDate, initial, withRef, floorSen = 0, pending, onCancel, onSave, children }: {
  title: string; openingDate: string; initial: PaperValues; withRef: boolean; floorSen?: number; pending: boolean;
  onCancel: () => void; onSave: (v: PaperValues) => void; children?: React.ReactNode;
}) => {
  const [v, setV] = useState<PaperValues>(initial);
  const why = !v.date ? 'Pick a date.' : v.date > openingDate ? `An opening paper is dated ${fmtDateOrDash(openingDate)} or before.`
    : v.amountSen <= 0 ? 'Enter an amount.' : v.amountSen < floorSen ? `${fmtSen(floorSen)} is already settled against it.` : null;
  return (
    <Modal title={title} onClose={onCancel} width="min(560px, 100%)">
      <div className="space-y-4">
        {children}
        <label style={{ display: 'block' }}><div style={soft}>Date · 日期</div><DateField value={v.date} onChange={(date) => setV({ ...v, date })} max={openingDate} aria-label="Paper date" /></label>
        {withRef && <label style={{ display: 'block' }}><div style={soft}>Reference · 发票号</div><input value={v.ref} onChange={(e) => setV({ ...v, ref: e.target.value })} aria-label="Reference" style={{ padding: '4px 6px', width: '100%' }} /></label>}
        <label style={{ display: 'block' }}><div style={soft}>Amount · 金额</div><MoneyInput valueSen={v.amountSen} onCommit={(sen) => setV({ ...v, amountSen: sen ?? 0 })} /></label>
        {why && <div style={{ ...soft, color: bad }}>{why}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={why != null || pending} onClick={() => onSave(v)}>Save · 保存</Button>
        </div>
      </div>
    </Modal>
  );
};

const AddPaperModal = ({ side, openingDate, onClose }: { side: 'creditors' | 'debtors'; openingDate: string; onClose: () => void }) => {
  const create = useCreateOpeningPaper();
  const suppliers = useSuppliers();
  const debtors = useOtherDebtors();
  const [kind, setKind] = useState<OpeningPaperKind>(side === 'creditors' ? 'API' : 'ODB');
  const [partyId, setPartyId] = useState('');
  const options = side === 'creditors'
    ? (suppliers.data ?? []).map((s) => ({ id: String(s.id), label: `${s.code} · ${s.name}` }))
    : (debtors.data?.debtors ?? []).map((x) => ({ id: String(x.id), label: x.name }));
  const kinds: OpeningPaperKind[] = side === 'creditors' ? ['API', 'SCN'] : ['ODB', 'ODR'];
  return (
    <PaperForm
      title={side === 'creditors' ? 'Add an opening paper · 供应商' : 'Add an opening paper · 其他欠款人'}
      openingDate={openingDate}
      initial={{ date: openingDate, ref: '', amountSen: 0 }}
      withRef={side === 'creditors'}
      pending={create.isPending}
      onCancel={onClose}
      onSave={(v) => { if (partyId) create.mutate({ kind, partyId, date: v.date, ref: v.ref || null, amountSen: v.amountSen }, { onSuccess: onClose }); }}
    >
      <div style={{ display: 'flex', gap: 6 }}>
        {kinds.map((k) => <button key={k} type="button" aria-pressed={kind === k} style={{ ...tabBtn(kind === k), borderRadius: 6, border: '1px solid var(--border-weak, #e3e1da)' }} onClick={() => setKind(k)}>{KIND_WORD[k]}</button>)}
      </div>
      <label style={{ display: 'block' }}>
        <div style={soft}>{side === 'creditors' ? 'Supplier · 供应商' : 'Other debtor · 其他欠款人'}</div>
        <select value={partyId} onChange={(e) => setPartyId(e.target.value)} aria-label="Party" style={{ padding: '4px 6px', width: '100%' }}>
          <option value="">— pick —</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      {!partyId && <div style={soft}>Pick who the paper is for.</div>}
    </PaperForm>
  );
};

/* ── Stock ────────────────────────────────────────────────────────────────── */

const StockTab = ({ stock, locked }: { stock: { buckets: Partial<Record<OpeningBucket, number>>; totalSen: number; codes: Record<OpeningBucket, string> }; locked: boolean }) => {
  const save = useSaveOpeningStock();
  const [draft, setDraft] = useState<Partial<Record<OpeningBucket, number>> | null>(null);
  const v = draft ?? stock.buckets;
  const total = OPENING_BUCKETS.reduce((s, [b]) => s + (v[b] ?? 0), 0);
  return (
    <div className="space-y-4">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={soft}>The stock the books opened with, per bucket — the first month&apos;s P&amp;L opens on it; from then on the closing stock is the stock engine&apos;s.</span>
        {!locked && (draft
          ? <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" size="sm" onClick={() => setDraft(null)}>Cancel</Button>
              <Button variant="primary" size="sm" disabled={save.isPending} onClick={() => save.mutate(v, { onSuccess: () => setDraft(null) })}>Save · 保存</Button>
            </div>
          : <Button variant="secondary" size="sm" onClick={() => setDraft({ ...stock.buckets })}>Edit · 修改</Button>)}
      </div>
      <table style={{ width: '100%', maxWidth: 640, borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
        <thead><tr><th style={th}>Bucket</th><th style={th}>Account</th><th style={{ ...th, textAlign: 'right' }}>Opening stock</th></tr></thead>
        <tbody>
          {OPENING_BUCKETS.map(([b, label]) => (
            <tr key={b}>
              <td style={td}>{label}</td>
              <td style={{ ...td, ...mono }}>{stock.codes[b]}</td>
              <td style={{ ...td, ...num }}>{draft ? <MoneyInput valueSen={v[b] ?? 0} onCommit={(sen) => setDraft({ ...v, [b]: sen ?? 0 })} /> : fmtSen(v[b] ?? 0)}</td>
            </tr>
          ))}
          <tr><td style={{ ...td, fontWeight: 600 }} colSpan={2}>Total · 合计</td><td style={{ ...td, ...num, fontWeight: 600 }}>{fmtSen(total)}</td></tr>
        </tbody>
      </table>
    </div>
  );
};
