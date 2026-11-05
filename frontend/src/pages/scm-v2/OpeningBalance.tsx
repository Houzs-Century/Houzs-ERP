// ----------------------------------------------------------------------------
// OpeningBalance — Finance › Setup › Opening balance (owner 2026-10-28:
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
//
// Restyled to the owner's Claude Design Setup pages (batch 6 §6.5): the header,
// the tags and buttons, the four views as a segmented control, the forms and
// the lock in centred modals, English labels. Every save is today's call.
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from 'react';
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
import { fmtDateOrDash, fmtSen, fmtSenPlain } from '../../vendor/shared/format';
import { Field, SetupModal, Skeleton, Tag } from './finance/SetupParts';
import sp from './finance/SetupParts.module.css';
import css from './OpeningBalance.module.css';

type Tab = 'accounts' | 'creditors' | 'debtors' | 'stock';
const TABS: Array<[Tab, string]> = [['accounts', 'Accounts'], ['creditors', 'Creditors'], ['debtors', 'Other debtors'], ['stock', 'Stock']];

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const Stat = ({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'late' }) => (
  <div className={css.stat}>
    <div className={css.statLabel}>{label}</div>
    <div className={tone === 'ok' ? `${css.statValue} ${css.ok}` : tone === 'late' ? `${css.statValue} ${css.late}` : css.statValue}>{value}</div>
    {sub ? <div className={css.statSub}>{sub}</div> : null}
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
      eyebrow="Finance · Setup"
      title="Opening balance"
      actions={d ? (d.locked
        ? <Button variant="secondary" size="sm" onClick={() => setConfirm('unlock')}><LockOpen {...ICON} /> Unlock</Button>
        : <Button variant="primary" size="sm" disabled={d.check.clearingSen !== 0} title={d.check.clearingSen !== 0 ? 'The opening must balance before it is locked.' : undefined} onClick={() => setConfirm('lock')}>
            <Lock {...ICON} /> Lock the opening
          </Button>) : undefined}
    />
  );
  if (q.isLoading) return <div className="space-y-4">{header}<section className={sp.card}><Skeleton rows={6} label="Loading the opening" /></section></div>;
  if (q.isError) return <div className="space-y-4">{header}<div className={sp.problem}>The opening could not be loaded — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</div></div>;
  if (!d) return <div className="space-y-4">{header}<section className={sp.card}><div className={sp.empty}>This company has no opening yet — its books have no start day.</div></section></div>;

  const locked = d.locked != null;
  const owe = (ps: OpeningParty[]) => ps.reduce((s, p) => s + p.netSen, 0);
  const papers = (ps: OpeningParty[]) => ps.reduce((s, p) => s + p.papers.length, 0);
  const balanced = d.check.clearingSen === 0;
  return (
    <div className="space-y-4">
      {header}
      <div className={sp.page}>
        <div className={css.stats}>
          <Stat label="Books start" value={fmtDateOrDash(d.booksStart)} sub={<>Opening dated {fmtDateOrDash(d.openingDate)}{d.journal ? <> · {d.journal.jeNo}</> : null}</>} />
          <Stat
            label="Opening difference"
            value={fmtSen(d.check.clearingSen)}
            tone={balanced ? 'ok' : 'late'}
            sub={balanced ? <Tag tone="info">Balanced</Tag> : <Tag tone="late" dot>{d.check.clearingCode} must read nil</Tag>}
          />
          <Stat label="Creditors" value={fmtSen(owe(d.creditors))} sub={`${d.creditors.length} suppliers · ${papers(d.creditors)} papers`} />
          <Stat label="Other debtors" value={fmtSen(owe(d.debtors))} sub={`${d.debtors.length} debtors · ${papers(d.debtors)} papers`} />
          <Stat label="Opening stock" value={fmtSen(d.stock.totalSen)} sub={locked ? <Tag tone="calm">Locked by {d.locked?.by ?? '—'}</Tag> : <Tag tone="warn">Open · can change</Tag>} />
        </div>

        <section className={sp.card} aria-label="The opening">
          <div className={css.cardHead}>
            {/* The four views of one opening — inner views, not a tab strip. */}
            <div className={css.seg} role="group" aria-label="Opening balance views">
              {TABS.map(([k, label]) => (
                <button key={k} type="button" aria-pressed={tab === k} className={tab === k ? `${css.segBtn} ${css.segOn}` : css.segBtn} onClick={() => setTab(k)}>
                  {label}
                </button>
              ))}
            </div>
            <span className={sp.hint}>{d.check.clearingCode} is the other side of every opening paper; it balances itself.</span>
          </div>
          <div className={css.cardBody}>
            {tab === 'accounts' && <AccountsTab accounts={d.accounts} locked={locked} />}
            {tab === 'creditors' && <PartiesTab side="creditors" parties={d.creditors} locked={locked} openingDate={d.openingDate} />}
            {tab === 'debtors' && <PartiesTab side="debtors" parties={d.debtors} locked={locked} openingDate={d.openingDate} />}
            {tab === 'stock' && <StockTab stock={d.stock} locked={locked} />}
          </div>
        </section>
      </div>

      {confirm && (
        <SetupModal
          title={confirm === 'lock' ? 'Lock the opening' : 'Unlock the opening'}
          sub={confirm === 'lock'
            ? `Lock the opening at ${fmtDateOrDash(d.openingDate)}? Nothing on this page can change until it is unlocked.`
            : 'Unlock the opening? Its accounts, papers and stock can be changed again.'}
          okLabel={confirm === 'lock' ? 'Lock the opening' : 'Unlock'}
          busy={lock.isPending}
          onOk={() => lock.mutate(confirm, { onSuccess: () => setConfirm(null) })}
          onCancel={() => setConfirm(null)}
        >
          {null}
        </SetupModal>
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
    <div className={css.view}>
      <div className={css.viewHead}>
        <span className={sp.hint}>Every account at its opening balance — the creditors, other debtors and stock are on their own views.</span>
        {!locked && (draft
          ? (
            <span className={css.viewActs}>
              <button type="button" className={sp.btn} onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className={sp.btnSolid} disabled={save.isPending}
                onClick={() => save.mutate(rows.filter((r) => r.drSen > 0 || r.crSen > 0).map(({ code, drSen, crSen }) => ({ code, drSen, crSen })), { onSuccess: () => setDraft(null) })}>
                Save
              </button>
            </span>
          )
          : <button type="button" className={sp.btn} onClick={() => setDraft(rows)}>Edit</button>)}
      </div>
      <div className={sp.scroll}>
        <table className={sp.table}>
          <thead><tr><th>Account</th><th>Name</th><th className={sp.num}>Debit</th><th className={sp.num}>Credit</th>{draft ? <th aria-label="remove" /> : null}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.code}>
                <td className={sp.muted}>{r.code}</td>
                <td>{r.name}</td>
                <td className={sp.num}>{draft ? <MoneyInput valueSen={r.drSen} onCommit={(v) => set(i, { drSen: v ?? 0, crSen: v ? 0 : r.crSen })} /> : (r.drSen ? fmtSenPlain(r.drSen) : '')}</td>
                <td className={sp.num}>{draft ? <MoneyInput valueSen={r.crSen} onCommit={(v) => set(i, { crSen: v ?? 0, drSen: v ? 0 : r.drSen })} /> : (r.crSen ? fmtSenPlain(r.crSen) : '')}</td>
                {draft ? (
                  <td className={css.rowAct}>
                    <button type="button" aria-label={`Remove ${r.code}`} title="Remove the line" className={`${sp.iconBtn} ${sp.iconDanger}`} onClick={() => setDraft(rows.filter((_, j) => j !== i))}>
                      <Trash2 size={14} />
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
            {draft && (
              <tr>
                <td colSpan={2}>
                  <span className={css.addLine}>
                    <input className={`${sp.input} ${sp.compact} ${css.codeInput}`} value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="Account code, e.g. 310-0010" aria-label="New account code" />
                    <button type="button" className={`${sp.btn} ${sp.small}`} disabled={!newCode.trim() || rows.some((r) => r.code === newCode.trim())}
                      onClick={() => { setDraft([...rows, { code: newCode.trim(), name: '(new line)', drSen: 0, crSen: 0 }]); setNewCode(''); }}>
                      <Plus size={14} /> Add line
                    </button>
                  </span>
                </td>
                <td colSpan={3} />
              </tr>
            )}
            <tr className={sp.totalRow}>
              <td colSpan={2}>Total</td>
              <td className={sp.num}>{fmtSenPlain(dr)}</td>
              <td className={sp.num}>{fmtSenPlain(cr)}</td>
              {draft ? <td /> : null}
            </tr>
          </tbody>
        </table>
      </div>
      <div className={sp.hint}>Debit less credit here, {fmtSen(dr - cr)}, is what the creditors, other debtors and stock stand against — the clearing balances it.</div>
    </div>
  );
};

/* ── Creditors / Other debtors ────────────────────────────────────────────── */

/* Typed on the kind union, so a kind added there and not here fails to compile. */
const KIND_WORD: Record<OpeningPaperKind, string> = { API: 'Bill', SCN: 'Credit', ODB: 'Bill', ODR: 'Credit' };
const kindWord = (k: OpeningPaperKind): string => KIND_WORD[k];

const PartiesTab = ({ side, parties, locked, openingDate }: { side: 'creditors' | 'debtors'; parties: OpeningParty[]; locked: boolean; openingDate: string }) => {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const party = parties.find((p) => p.partyId === open) ?? null;
  const columns = useMemo<Column<OpeningParty>[]>(() => [
    { key: 'code', label: side === 'creditors' ? 'Code' : 'Debtor', render: (r) => (side === 'creditors' ? <span className={sp.muted}>{r.code ?? '—'}</span> : r.name), getValue: (r) => (side === 'creditors' ? r.code ?? '' : r.name) },
    ...(side === 'creditors' ? [
      { key: 'name', label: 'Name', render: (r: OpeningParty) => r.name, getValue: (r: OpeningParty) => r.name },
      { key: 'control', label: 'Control', render: (r: OpeningParty) => <span className={sp.muted}>{r.control ?? '—'}</span>, getValue: (r: OpeningParty) => r.control ?? '' },
    ] as Column<OpeningParty>[] : []),
    { key: 'papers', label: 'Papers', align: 'right', render: (r) => r.papers.length, getValue: (r) => r.papers.length },
    { key: 'owing', label: 'Bills', align: 'right', render: (r) => fmtSenPlain(r.owingSen), getValue: (r) => r.owingSen, exportValue: (r) => r.owingSen / 100, exportFormat: 'money', total: (rs) => fmtSenPlain(rs.reduce((s, r) => s + r.owingSen, 0)) },
    { key: 'credit', label: 'Credits', align: 'right', render: (r) => (r.creditSen ? fmtSenPlain(r.creditSen) : <span className={sp.muted}>—</span>), getValue: (r) => r.creditSen, exportValue: (r) => r.creditSen / 100, exportFormat: 'money', total: (rs) => fmtSenPlain(rs.reduce((s, r) => s + r.creditSen, 0)) },
    { key: 'net', label: side === 'creditors' ? 'We owe' : 'Owes us', align: 'right', render: (r) => <span className={sp.strong}>{fmtSenPlain(r.netSen)}</span>, getValue: (r) => r.netSen, exportValue: (r) => r.netSen / 100, exportFormat: 'money', total: (rs) => fmtSenPlain(rs.reduce((s, r) => s + r.netSen, 0)) },
    {
      key: 'settled', label: 'Settled since', align: 'right',
      render: (r) => { const s = r.papers.reduce((t, p) => t + p.settledSen, 0); return s ? fmtSenPlain(s) : <span className={sp.muted}>—</span>; },
      getValue: (r) => r.papers.reduce((t, p) => t + p.settledSen, 0),
    },
  ], [side]);
  return (
    <div className={css.view}>
      <div className={css.viewHead}>
        <span className={sp.hint}>{side === 'creditors' ? 'Each supplier by its opening bills and credits — AutoCount\'s creditor aging at the opening day.' : 'Each other debtor by its opening bills and credits.'} Click a row for its papers.</span>
        {!locked && <button type="button" className={sp.btn} onClick={() => setAdding(true)}><Plus size={14} /> Add a paper</button>}
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
      <div className={sp.scroll}>
        <table className={sp.table}>
          <thead>
            <tr>
              <th>Paper</th><th>Kind</th><th>Date</th><th>Reference</th><th>Note</th>
              <th className={sp.num}>Amount</th><th className={sp.num}>Settled</th><th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {party.papers.map((p) => (
              <tr key={p.id}>
                <td className={sp.strong}>{p.no}</td>
                <td><Tag tone={kindWord(p.kind) === 'Credit' ? 'info' : 'calm'}>{kindWord(p.kind)}</Tag></td>
                <td>{fmtDateOrDash(p.date)}</td>
                <td>{p.ref ?? <span className={sp.muted}>—</span>}</td>
                <td className={`${sp.muted} ${css.note}`}>{p.note ?? ''}</td>
                <td className={sp.num}>{fmtSenPlain(p.amountSen)}</td>
                <td className={sp.num}>{p.settledSen ? fmtSenPlain(p.settledSen) : <span className={sp.muted}>—</span>}</td>
                <td className={css.rowAct}>
                  {!locked && (
                    <span className={sp.acts}>
                      <button type="button" className={`${sp.btn} ${sp.small}`} onClick={() => setEditing(p)}>Edit</button>
                      <button type="button" className={`${sp.btn} ${sp.small}`} disabled={p.settledSen > 0 || cancel.isPending} title={p.settledSen > 0 ? 'Money has been settled against it.' : undefined}
                        onClick={() => cancel.mutate({ kind: p.kind, id: p.id })}>Cancel</button>
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

const PaperForm = ({ title, openingDate, initial, withRef, floorSen = 0, blocker = null, pending, onCancel, onSave, children }: {
  title: string; openingDate: string; initial: PaperValues; withRef: boolean; floorSen?: number;
  /** A check the caller owns (who the paper is for) — named before the paper's own. */
  blocker?: string | null;
  pending: boolean;
  onCancel: () => void; onSave: (v: PaperValues) => void; children?: ReactNode;
}) => {
  const [v, setV] = useState<PaperValues>(initial);
  const why = blocker ?? (!v.date ? 'Pick a date.' : v.date > openingDate ? `An opening paper is dated ${fmtDateOrDash(openingDate)} or before.`
    : v.amountSen <= 0 ? 'Enter an amount.' : v.amountSen < floorSen ? `${fmtSen(floorSen)} is already settled against it.` : null);
  return (
    <SetupModal
      title={title}
      okLabel="Save"
      busyLabel="Saving…"
      busy={pending}
      error={why}
      onOk={() => { if (why == null) onSave(v); }}
      onCancel={onCancel}
    >
      {children}
      <Field label="Date" group>
        <DateField value={v.date} onChange={(date) => setV({ ...v, date })} max={openingDate} aria-label="Paper date" />
      </Field>
      {withRef && (
        <Field label="Reference">
          <input className={sp.input} value={v.ref} onChange={(e) => setV({ ...v, ref: e.target.value })} aria-label="Reference" />
        </Field>
      )}
      <Field label="Amount">
        <MoneyInput valueSen={v.amountSen} onCommit={(sen) => setV({ ...v, amountSen: sen ?? 0 })} />
      </Field>
    </SetupModal>
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
      title={side === 'creditors' ? 'Add an opening paper · supplier' : 'Add an opening paper · other debtor'}
      openingDate={openingDate}
      initial={{ date: openingDate, ref: '', amountSen: 0 }}
      withRef={side === 'creditors'}
      blocker={partyId ? null : 'Pick who the paper is for.'}
      pending={create.isPending}
      onCancel={onClose}
      onSave={(v) => { if (partyId) create.mutate({ kind, partyId, date: v.date, ref: v.ref || null, amountSen: v.amountSen }, { onSuccess: onClose }); }}
    >
      <Field label="Kind" w="100%" group>
        <div className={css.seg}>
          {kinds.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? `${css.segBtn} ${css.segOn}` : css.segBtn} onClick={() => setKind(k)}>
              {kindWord(k)}
            </button>
          ))}
        </div>
      </Field>
      <Field label={side === 'creditors' ? 'Supplier' : 'Other debtor'} w="100%">
        <select className={sp.select} value={partyId} onChange={(e) => setPartyId(e.target.value)} aria-label="Party">
          <option value="">— pick —</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </Field>
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
    <div className={css.view}>
      <div className={css.viewHead}>
        <span className={sp.hint}>The stock the books opened with, per bucket — the first month&apos;s P&amp;L opens on it; from then on the closing stock is the stock engine&apos;s.</span>
        {!locked && (draft
          ? (
            <span className={css.viewActs}>
              <button type="button" className={sp.btn} onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className={sp.btnSolid} disabled={save.isPending} onClick={() => save.mutate(v, { onSuccess: () => setDraft(null) })}>Save</button>
            </span>
          )
          : <button type="button" className={sp.btn} onClick={() => setDraft({ ...stock.buckets })}>Edit</button>)}
      </div>
      <div className={`${sp.scroll} ${css.stockTable}`}>
        <table className={sp.table}>
          <thead><tr><th>Bucket</th><th>Account</th><th className={sp.num}>Opening stock</th></tr></thead>
          <tbody>
            {OPENING_BUCKETS.map(([b, label]) => (
              <tr key={b}>
                <td>{label}</td>
                <td className={sp.muted}>{stock.codes[b]}</td>
                <td className={sp.num}>{draft ? <MoneyInput valueSen={v[b] ?? 0} onCommit={(sen) => setDraft({ ...v, [b]: sen ?? 0 })} /> : fmtSenPlain(v[b] ?? 0)}</td>
              </tr>
            ))}
            <tr className={sp.totalRow}><td colSpan={2}>Total</td><td className={sp.num}>{fmtSenPlain(total)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};
