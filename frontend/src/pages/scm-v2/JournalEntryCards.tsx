// ----------------------------------------------------------------------------
// JournalEntryCards — a journal entry opened, and a manual journal drafted
// (moved out of Accounting.tsx on 2026-09-15, docs/bugs/0920, when the owner
// opened his June salary journal: manual journal 数字，account name 都没有，然后
// 没有办法 copy). Two things a person needs of an entry: to READ it — every
// line names its account by code on one line and by name on the next, the
// convention for everything that shows an account from here on (owner: code
// 一行，name 一行，接下来有显示资料的都是这样的) — and to COPY it: a manual journal
// keyed every month (salary, rent) opens the draft form with its lines
// already there, dated today, for the month's figures to be edited and the
// draft posted. Copy never posts; it drafts.
//
// And to EDIT it (owner 2026-09-15, on a posted one: 我无法 edit): the same
// form, opened on the entry's own date, lines and narration. Saving a posted
// entry reverses it on its own day and posts the corrected entry under a new
// number — one step, the server's (PUT /journal-entries/:id); a draft is
// rewritten in place. Unlike Copy, an edit keeps the party on each line.
//
// In the owner's redesign (batch 6 §2.3 a4–a5) both are the BODY of a right
// drawer (books/JournalDrawer): the card's facts, its lines with a total, and
// Post · Edit · Copy · Reverse on a MANUAL journal only — a document's entry
// opens its document instead (owner question g3; nothing new posts). The form
// saves a draft or saves and posts — the create, then today's post call.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Info, Plus, X } from 'lucide-react';
import {
  useCreateJournalEntry, usePostJournalEntry, useAccounts, leafAccounts,
  type JournalEntry, type JournalEntryLine, type JeLineIn,
} from '../../vendor/scm/lib/accounting-queries';
import { useEditJournalEntry, useJournalEntryCard, useReverseJournalEntry, type JournalDocument } from './accounting-phase1-queries';
import { fmtDate, fmtDateTime } from '../../vendor/shared/format';
import { fmtLedger, fmtSide } from '../../vendor/scm/lib/ledger-queries';
import { byText } from '../../vendor/scm/lib/sort-options';
import { DateField } from '../../vendor/scm/components/DateField';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { financeDocHref } from './finance/FinanceDocLink';
import { isManualSource, sourceLabel } from './books/journal-sources';
import s from './books/Books.module.css';

/* JE status — REVERSED wins over POSTED, then DRAFT. The stored words, for the
   CSV and the search; the card and the grid print jeStatusTag's. */
export const jeStatus = (r: JournalEntry): string =>
  r.reversed ? 'REVERSED' : r.posted ? 'POSTED' : 'DRAFT';

export type StatusTone = 'late' | 'warn' | 'info' | 'calm';
/** The status as a tag: Posted calm, Draft warn, Reversed late. */
export function jeStatusTag(r: Pick<JournalEntry, 'reversed' | 'posted'>): { label: string; tone: StatusTone } {
  if (r.reversed) return { label: 'Reversed', tone: 'late' };
  if (r.posted) return { label: 'Posted', tone: 'calm' };
  return { label: 'Draft', tone: 'warn' };
}
export const toneClass = (tone: StatusTone): string =>
  (tone === 'late' ? s.toneLate : tone === 'warn' ? s.toneWarn : tone === 'info' ? s.toneInfo : s.toneCalm);

/* RM string → integer sen; null when the input is not money. */
export const rmToSen = (raw: string): number | null => {
  const t = raw.trim().replace(/,/g, '');
  if (!t) return 0;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
};
/** Sen → the RM the form's boxes hold ("19206.98"); nothing for nothing. */
export const senToRm = (sen: number): string => (sen > 0 ? (sen / 100).toFixed(2) : '');

export type DraftLine = {
  accountCode: string; debit: string; credit: string; notes: string;
  /* Carried by an EDIT only — the form has no party boxes, and a copy drops
     the party on purpose; an edit must not lose it. */
  partyType?: string | null; partyCode?: string | null; partyName?: string | null;
};
const EMPTY_LINE: DraftLine = { accountCode: '', debit: '', credit: '', notes: '' };

/** What a copy carries into the draft form: the narration and the lines,
    never the date (a copy is a new month's) nor the party (the person on a
    salary line changes with the month, the account does not). */
export type DraftSeed = { narration: string; lines: DraftLine[] };

export const seedFromEntry = (je: JournalEntry, lines: JournalEntryLine[]): DraftSeed => ({
  narration: je.narration ?? '',
  lines: lines.map((l) => ({ accountCode: l.account_code, debit: senToRm(l.debit_sen), credit: senToRm(l.credit_sen), notes: l.notes ?? '' })),
});

/** What an EDIT opens the form with: the entry itself (its number decides the
    title, its date the date box, posted decides what Save does) and its lines
    with their parties kept. */
export type EditSeed = DraftSeed & { id: string; jeNo: string; posted: boolean; entryDate: string };

export const editSeedFromEntry = (je: JournalEntry, lines: JournalEntryLine[]): EditSeed => ({
  id: je.id,
  jeNo: je.je_no,
  posted: je.posted,
  entryDate: String(je.entry_date).slice(0, 10),
  narration: je.narration ?? '',
  lines: lines.map((l) => ({
    accountCode: l.account_code, debit: senToRm(l.debit_sen), credit: senToRm(l.credit_sen), notes: l.notes ?? '',
    partyType: l.party_type, partyCode: l.party_code, partyName: l.party_name,
  })),
});

/** Code on one line, name on the next — how an account reads on every screen
    from 2026-09-15 on (owner: code 一行，name 一行). */
export const AccountCell = ({ code, name }: { code: string; name: string | null | undefined }) => (
  <span style={{ display: 'inline-block', lineHeight: 1.25 }}>
    <span>{code}</span>
    {name && <><br /><span style={{ fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #555)' }}>{name}</span></>}
  </span>
);

/** Where an entry's document opens — the money-out three through their one home. */
export function journalDocumentHref(d: JournalDocument): string {
  switch (d.kind) {
    case 'SI': return `/scm/sales-invoices/${encodeURIComponent(d.id)}`;
    case 'SO': return `/scm/sales-orders/${encodeURIComponent(d.id)}`;
    case 'NOTE': return `/scm/credit-notes/${encodeURIComponent(d.id)}`;
    case 'SUPPLIER_NOTE': return `/scm/supplier-notes/${encodeURIComponent(d.id)}`;
    default: return financeDocHref(d.kind, d.id);
  }
}

/** What the drawer's head carries for an entry the list already read. */
export type EntryRefs = { journal?: string | null; doc?: string | null; doc2?: string | null; who?: string | null };

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ minWidth: 0 }}>
    <div className={s.factLabel}>{label}</div>
    <div className={s.factValue}>{children}</div>
  </div>
);

export type JeCardProps = {
  id: string;
  onClose: () => void;
  onCopy?: (seed: DraftSeed, from: string) => void;
  onEdit?: (seed: EditSeed) => void;
  /** An account clicked: open it in the General ledger. */
  onOpenAccount?: (code: string, entryDate: string) => void;
  /** A document clicked: open it in its own tab. */
  onOpenDocument?: (path: string) => void;
  onToast?: (text: string) => void;
  /** What the list already knows of the entry: its journal and references. */
  refs?: EntryRefs | null;
};

export const JeDetailCard = ({ id, onClose, onCopy, onEdit, onOpenAccount, onOpenDocument, onToast, refs }: JeCardProps) => {
  const q = useJournalEntryCard(id);
  const postM = usePostJournalEntry();
  const reverseM = useReverseJournalEntry();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const je = q.data?.journalEntry;
  const lines = q.data?.lines ?? [];
  const doc = q.data?.document ?? null;
  const nameOf = useMemo(() => new Map((accounts.data?.accounts ?? []).map((a) => [a.account_code, a.account_name])), [accounts.data]);
  const totals = useMemo(() => lines.reduce((t, l) => ({ dr: t.dr + l.debit_sen, cr: t.cr + l.credit_sen }), { dr: 0, cr: 0 }), [lines]);

  const head = (title: React.ReactNode, sub: string | null) => (
    <div className={s.dHead}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className={s.dTitleRow}>{title}</div>
        {sub && <div className={s.dSub}>{sub}</div>}
      </div>
      <button type="button" className={s.dClose} onClick={onClose} title="Close" aria-label="Close"><X size={14} /></button>
    </div>
  );

  if (!je) {
    return (
      <div className={s.drawer}>
        {head(<span className={s.dTitle}>Journal entry</span>, null)}
        <div className={s.dBody}>
          <div className={q.isError ? s.problem : s.hint}>
            {q.isLoading ? 'Loading the entry…' : q.isError ? 'The entry did not load — close it and open it again.' : 'Entry not found.'}
          </div>
        </div>
      </div>
    );
  }

  const manual = isManualSource(je.source_type);
  const contra = /_REVERSAL$/.test(je.source_type);
  const tag = jeStatusTag(je);
  const canPost = manual && !je.posted && !je.reversed;
  const canEdit = manual && !je.reversed && Boolean(onEdit) && lines.length > 0;
  const canCopy = manual && Boolean(onCopy) && lines.length > 0;
  const canReverse = manual && je.posted && !je.reversed;
  const settled = () => { void qc.invalidateQueries({ queryKey: ['finance-todo'] }); };

  const note = je.reversed
    ? 'Reversed: a contra entry moved the same amounts back. Both stay listed, and neither moves a balance.'
    : contra
      ? 'This entry reverses another. The pair stays listed and moves no balance.'
      : !je.posted
        ? 'A draft moves no balance until it is posted.'
        : null;
  const foot = !manual
    ? 'Written by its document — a correction is made there.'
    : je.reversed
      ? 'Reversed entries stay as history. Copy starts a new draft from this one.'
      : je.posted
        ? 'Edit reverses this entry on its own day and posts the corrected one under a new number.'
        : 'Post writes this draft to the ledger.';

  return (
    <div className={s.drawer}>
      {head(
        <>
          <span className={s.dTitle}>{je.je_no}</span>
          <span className={`${s.tag} ${toneClass(tag.tone)}`}>{tag.label}</span>
          {contra && <span className={`${s.tag} ${s.toneCalm}`}>contra</span>}
        </>,
        je.narration ?? refs?.who ?? null,
      )}
      <div className={s.dBody}>
        <div className={s.facts}>
          <Fact label="Date">{fmtDate(je.entry_date)}</Fact>
          {refs?.journal && <Fact label="Journal">{refs.journal}</Fact>}
          <Fact label="Source">{sourceLabel(je.source_type)}</Fact>
          {doc ? (
            <Fact label="Document">
              <button type="button" className={s.docLink} title={`Open ${doc.number} in a new tab`}
                onClick={() => onOpenDocument?.(journalDocumentHref(doc))}>{doc.number}</button>
            </Fact>
          ) : refs?.doc ? <Fact label="Ref. 1">{refs.doc}</Fact> : null}
          {refs?.doc2 && <Fact label="Ref. 2">{refs.doc2}</Fact>}
          {refs?.who && refs.who !== je.narration && <Fact label="Party">{refs.who}</Fact>}
          {je.posted_at && <Fact label="Posted on">{fmtDateTime(je.posted_at)}</Fact>}
        </div>
        {note && <div className={`${s.note} ${s.noteInfo}`}><Info size={14} aria-hidden /><span>{note}</span></div>}
        {q.data?.documentError && <div className={s.hint}>Its document could not be read: {q.data.documentError}</div>}

        <div className={s.lines} role="table" aria-label="Lines">
          <div className={s.linesHead} role="row">
            <span>Account</span><span>Party</span><span>Note</span><span className={s.right}>Debit</span><span className={s.right}>Credit</span>
          </div>
          {lines.map((l) => (
            <div key={l.id} className={s.linesRow} role="row" data-line={l.line_no}>
              <button type="button" className={s.acct} title="Open in General ledger" onClick={() => onOpenAccount?.(l.account_code, String(je.entry_date).slice(0, 10))}>
                <AccountCell code={l.account_code} name={nameOf.get(l.account_code)} />
              </button>
              <span className={`${s.cell} ${s.muted}`}>{l.party_name ?? l.party_code ?? ''}</span>
              <span className={`${s.cell} ${s.muted}`}>{l.notes ?? ''}</span>
              <span className={s.num}>{fmtSide(l.debit_sen)}</span>
              <span className={s.num}>{fmtSide(l.credit_sen)}</span>
            </div>
          ))}
          <div className={s.linesTotal} role="row">
            <span>Total</span><span /><span /><span className={s.num}>{fmtLedger(totals.dr)}</span><span className={s.num}>{fmtLedger(totals.cr)}</span>
          </div>
        </div>
        <div className={s.hint}>Click an account to open it in the General ledger.</div>
      </div>
      <div className={s.dFoot}>
        <span className={s.dFootText}>{foot}</span>
        {canPost && (
          <button type="button" className={`${s.btnSolid} ${s.dBtn}`} disabled={postM.isPending}
            onClick={() => postM.mutate(id, { onSuccess: () => { settled(); onToast?.(`Posted ${je.je_no}`); } })}>
            {postM.isPending ? 'Posting…' : 'Post'}
          </button>
        )}
        {/* A manual journal not yet reversed opens in the form on its own date
            and lines (owner: 我无法 edit) — a posted one is reversed and
            re-posted by the save, a draft rewritten. */}
        {canEdit && <button type="button" className={`${s.btn} ${s.dBtn}`} onClick={() => onEdit?.(editSeedFromEntry(je, lines))}>Edit</button>}
        {/* A manual journal keyed every month is copied into a new draft —
            its lines, notes and narration — dated today (owner: 没有办法 copy). */}
        {canCopy && <button type="button" className={`${s.btn} ${s.dBtn}`} onClick={() => onCopy?.(seedFromEntry(je, lines), je.je_no)}>Copy</button>}
        {canReverse && (
          <button type="button" className={`${s.btn} ${s.dBtn}`} disabled={reverseM.isPending} title="Posts a contra entry that moves the same amounts back"
            onClick={() => reverseM.mutate(id, { onSuccess: (r) => { settled(); onToast?.(`Reversed ${je.je_no}${r.jeNo ? ` · contra ${r.jeNo}` : ''}`); } })}>
            {reverseM.isPending ? 'Reversing…' : 'Reverse'}
          </button>
        )}
        {!manual && doc && (
          <button type="button" className={`${s.btnPrimary} ${s.dBtn}`} onClick={() => onOpenDocument?.(journalDocumentHref(doc))}>
            Open {doc.number}
          </button>
        )}
      </div>
    </div>
  );
};

/** A bank line recorded as a journal (Bank statements › No entry found; owner
    2026-11-03 on d10, 「这样需要」 — the journal, not a receipt): its day and the
    bank's own leg are fixed — Dr the bank for money in, Cr it for money out,
    to the sen — and the person picks the other account(s). `check` is asked
    before anything is written (a locked month, a line no longer open, or an
    entry that fits it now refuses with its sentence); `settle` matches the
    line to the posted entry with today's match call — null once it is
    matched, or the sentence saying why the line was left as it is; a refused
    match rejects. */
export type BankLineRecord = {
  lineNo: number;
  /** The line's day (ISO): the entry posts on it. */
  bookedOn: string;
  /** Signed: positive is money in. */
  amountSen: number;
  /** The bank account the money moved on — its ledger code. */
  accountCode: string;
  description: string;
  reference: string | null;
  check: () => Promise<string | null>;
  settle: (jeNo: string) => Promise<string | null>;
};

/** The bank's leg of a recorded line, as the form shows it (fixed). */
export const bankLegOf = (r: Pick<BankLineRecord, 'amountSen' | 'accountCode' | 'lineNo'>): DraftLine => ({
  accountCode: r.accountCode,
  debit: r.amountSen > 0 ? senToRm(r.amountSen) : '',
  credit: r.amountSen < 0 ? senToRm(-r.amountSen) : '',
  notes: `Bank line ${r.lineNo}`,
});
/** The other side, ready for its account: the same amount the other way. */
const otherLegOf = (r: Pick<BankLineRecord, 'amountSen'>): DraftLine => ({
  accountCode: '',
  debit: r.amountSen < 0 ? senToRm(-r.amountSen) : '',
  credit: r.amountSen > 0 ? senToRm(r.amountSen) : '',
  notes: '',
});

/* One form for a new journal, a copy and an edit. `editing` names the entry
   being edited: Save then goes to PUT /journal-entries/:id — a posted entry
   is reversed and the corrected one posted in the same step, a draft is
   rewritten in place — and the date box opens on the entry's own day. Save &
   post on a new journal (or a draft) is the create (or the rewrite) and then
   today's post call; a refused post leaves the draft standing, the server's
   sentence on screen, and the drawer open on the draft. */
export type JournalFormProps = {
  initial?: DraftSeed | null;
  editing?: EditSeed | null;
  /** The entry a copy was made from, named in the banner. */
  copiedFrom?: string | null;
  onCancel: () => void;
  /** Saved (or posted): the drawer turns to the saved entry's card. */
  onSaved: (id: string) => void;
  onToast?: (text: string) => void;
  /** Recording a bank line instead of a free journal: see BankLineRecord. */
  record?: BankLineRecord | null;
};

const todayMyt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
/** A reason as a sentence of its own: ends with its stop. */
const asSentence = (t: string): string => (/[.!?]$/.test(t) ? t : `${t}.`);

export const NewJournalForm = ({ initial, editing, copiedFrom, onCancel, onSaved, onToast, record = null }: JournalFormProps) => {
  const accounts = useAccounts();
  const createM = useCreateJournalEntry();
  const editM = useEditJournalEntry();
  const postM = usePostJournalEntry();
  const qc = useQueryClient();
  const [entryDate, setEntryDate] = useState(() => record?.bookedOn ?? editing?.entryDate ?? todayMyt());
  const [narration, setNarration] = useState(() => (record
    ? [record.reference, record.description].filter((t): t is string => !!t && t.trim() !== '').join(' · ')
    : initial?.narration ?? ''));
  /* A recorded bank line keeps the bank's leg apart, fixed; these are the lines the person keys. */
  const [lines, setLines] = useState<DraftLine[]>(() => (record
    ? [otherLegOf(record)]
    : initial && initial.lines.length > 0 ? initial.lines.map((l) => ({ ...l })) : [{ ...EMPTY_LINE }, { ...EMPTY_LINE }]));
  const bankLeg = record ? bankLegOf(record) : null;
  const allLines = bankLeg ? [bankLeg, ...lines] : lines;
  /* Recording: the draft and the post this form has made, kept across presses —
     a second press never creates or posts a second journal, it finishes the
     first (posts the draft, or only asks the match again). */
  const made = useRef<{ id: string; jeNo: string; posted: boolean } | null>(null);
  const busy = useRef(false);
  const [postedNo, setPostedNo] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [step, setStep] = useState<'checking' | 'matching' | null>(null);

  const all = accounts.data?.accounts ?? [];
  // Postable = active and not a header (retired children count, docs/bugs/0693)
  // — the engine's own rule from its one screen-side home, applied here so the
  // picker cannot offer an account the post will refuse.
  const postable = useMemo(() => leafAccounts(all), [all]);
  /* Typed to, not scrolled through (owner 2026-09-15: 无法快速打关键字眼找
     account): every word typed must match the code or the name. */
  /* A recorded bank line's own account is its fixed leg, never the other side:
     a second line on it would move the bank by other than the line's amount. */
  const fixedBank = record?.accountCode ?? null;
  const options = useMemo(
    () => [...postable].filter((a) => a.account_code !== fixedBank)
      .sort((a, b) => byText(a.account_code, b.account_code)).map((a) => ({ value: a.account_code, label: `${a.account_code} — ${a.account_name}` })),
    [postable, fixedBank],
  );

  const totals = useMemo(() => {
    let dr = 0; let cr = 0; let bad = false;
    for (const l of allLines) {
      const d = rmToSen(l.debit); const c = rmToSen(l.credit);
      if (d == null || c == null) { bad = true; continue; }
      dr += d; cr += c;
      if (d > 0 && c > 0) bad = true;
    }
    return { dr, cr, bad };
  }, [allLines]);

  const balanced = !totals.bad && totals.dr === totals.cr && totals.dr > 0;
  const canSave = balanced && /^\d{4}-\d{2}-\d{2}$/.test(entryDate)
    && allLines.every((l) => l.accountCode || (!l.debit && !l.credit));
  const state = totals.bad
    ? { label: 'Check the amounts', tone: 'late' as const }
    : balanced
      ? { label: 'Balanced', tone: 'info' as const }
      : { label: totals.dr === 0 && totals.cr === 0 ? 'Not balanced' : `Out by ${fmtLedger(Math.abs(totals.dr - totals.cr))}`, tone: 'late' as const };

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const pending = createM.isPending || editM.isPending || postM.isPending || step != null;
  const body = () => ({
    entryDate,
    narration: narration.trim() || null,
    lines: allLines
      .filter((l) => l.accountCode)
      .map((l): JeLineIn => ({
        accountCode: l.accountCode,
        debitSen: rmToSen(l.debit) ?? 0,
        creditSen: rmToSen(l.credit) ?? 0,
        notes: l.notes.trim() || null,
        ...(l.partyType || l.partyCode || l.partyName
          ? { partyType: l.partyType ?? null, partyCode: l.partyCode ?? null, partyName: l.partyName ?? null }
          : {}),
      })),
  });

  /* Each hook's own dialog says why a step was refused; the form stays put. */
  const save = async (andPost: boolean) => {
    let saved: JournalEntry;
    try {
      saved = editing
        ? (await editM.mutateAsync({ id: editing.id, ...body() })).journalEntry
        : (await createM.mutateAsync(body())).journalEntry;
    } catch { return; }
    void qc.invalidateQueries({ queryKey: ['finance-todo'] });
    if (editing?.posted) { onToast?.(`Saved and posted ${saved.je_no} · ${editing.jeNo} reversed`); onSaved(saved.id); return; }
    if (!andPost) { onToast?.(`Draft saved · ${saved.je_no}`); onSaved(saved.id); return; }
    try {
      await postM.mutateAsync(saved.id);
      onToast?.(`Posted ${saved.je_no}`);
    } catch { /* the draft stands; its card shows it */ }
    onSaved(saved.id);
  };

  /* Recording a bank line: ask first, then the draft and today's post, then
     today's match — each step at most once. A refused post leaves the draft
     standing (a second press posts that same draft); a refused match after the
     post is said plainly and leaves the line to match by hand. */
  const recordAndMatch = async () => {
    if (!record || busy.current) return;
    busy.current = true;
    setProblem(null);
    try {
      let entry = made.current;
      if (!entry?.posted) {
        setStep('checking');
        const refusal = await record.check()
          .catch((e: unknown) => `The bank line could not be checked, so nothing was written: ${asSentence((e instanceof Error ? e.message.trim() : '') || 'the month did not answer')} Try again.`);
        setStep(null);
        if (refusal) { setProblem(refusal); return; }
        try {
          const saved = entry
            ? (await editM.mutateAsync({ id: entry.id, ...body() })).journalEntry
            : (await createM.mutateAsync(body())).journalEntry;
          entry = { id: saved.id, jeNo: saved.je_no, posted: false };
          made.current = entry;
        } catch { return; }
        try {
          const done = (await postM.mutateAsync(entry.id)).journalEntry;
          entry = { ...entry, jeNo: done.je_no || entry.jeNo, posted: true };
          made.current = entry;
          setPostedNo(entry.jeNo);
          void qc.invalidateQueries({ queryKey: ['finance-todo'] });
        } catch {
          setProblem(`${entry.jeNo} is saved as a draft but was not posted. Press Save & post again to post it — no second journal is made.`);
          return;
        }
      }
      setStep('matching');
      let leftAlone: string | null;
      try {
        leftAlone = await record.settle(entry.jeNo);
      } catch (e) {
        setProblem(`Posted ${entry.jeNo}, but the bank line was not matched: ${asSentence((e instanceof Error ? e.message.trim() : '') || 'the match was refused')} The line stays open — match it to ${entry.jeNo} by hand, or press Match again.`);
        return;
      } finally {
        setStep(null);
      }
      if (leftAlone) { setProblem(`Posted ${entry.jeNo}, but ${leftAlone}`); return; }
      onToast?.(`Posted ${entry.jeNo} · matched to bank line ${record.lineNo}`);
      onSaved(entry.id);
    } finally {
      busy.current = false;
    }
  };

  const banner = record
    ? null
    : editing
    ? editing.posted
      ? 'This entry is posted — saving reverses it on its own day and posts the corrected entry under a new number.'
      : 'This entry is a draft — saving rewrites it in place.'
    : initial
      ? `Copied${copiedFrom ? ` from ${copiedFrom}` : ''} — check the date, the figures and the notes before saving.`
      : null;

  return (
    <div className={s.drawer}>
      <div className={s.dHead}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={s.dTitleRow}><span className={s.dTitle}>{record ? 'Record journal' : editing ? `Edit ${editing.jeNo}` : 'New manual journal'}</span></div>
          <div className={s.dSub}>
            {record
              ? `Bank line ${record.lineNo} · ${fmtDate(record.bookedOn)} · ${record.amountSen > 0 ? 'In' : 'Out'} ${fmtLedger(Math.abs(record.amountSen))} — matched to the line once it is posted`
              : editing ? 'A manual journal' : 'A draft until it is posted. Debits must equal credits.'}
          </div>
        </div>
        <button type="button" className={s.dClose} onClick={onCancel} title="Close" aria-label="Close"><X size={14} /></button>
      </div>
      <div className={s.dBody}>
        {banner && <div className={`${s.note} ${s.noteWarn}`}><Info size={14} aria-hidden /><span>{banner}</span></div>}
        {problem && <div className={`${s.note} ${s.noteWarn}`} role="alert"><Info size={14} aria-hidden /><span>{problem}</span></div>}
        <fieldset disabled={postedNo != null} style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: 'contents' }}>
        <div className={s.formTop}>
          <label className={s.field}>
            <span className={s.fieldLabel}>Date</span>
            {record
              ? <span className={s.input} aria-label="Date" style={{ display: 'flex', alignItems: 'center' }}>{fmtDate(entryDate)}</span>
              : <DateField className={s.input} fullWidth value={entryDate} onChange={(iso) => setEntryDate(iso)} aria-label="Date" />}
            <span className={s.fieldHint}>{record ? 'The bank line’s day' : editing?.posted ? 'The corrected entry’s day' : 'The day it posts on'}</span>
          </label>
          <label className={s.field}>
            <span className={s.fieldLabel}>Narration</span>
            <input data-upper className={s.input} placeholder="What is this entry?" aria-label="Narration"
              value={narration} onChange={(e) => setNarration(e.target.value)} />
          </label>
        </div>

        <div className={s.formGrid}>
          <div className={s.formHead}>
            <span>Account</span><span className={s.right}>Debit (RM)</span><span className={s.right}>Credit (RM)</span><span>Line note</span><span />
          </div>
          {/* The bank's own leg: the account the money moved on and the line's amount, to the sen — fixed, so the match fits. */}
          {bankLeg && (
            <div data-grid-row className={s.formRow} aria-label="The bank's leg">
              <span className={s.input} title="The bank account this line moved on" style={{ display: 'flex', alignItems: 'center', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {bankLeg.accountCode}{(() => { const name = all.find((a) => a.account_code === bankLeg.accountCode)?.account_name; return name ? ` — ${name}` : ''; })()}
              </span>
              <span className={`${s.input} ${s.amount}`} aria-label="Bank debit" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>{bankLeg.debit}</span>
              <span className={`${s.input} ${s.amount}`} aria-label="Bank credit" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>{bankLeg.credit}</span>
              <span className={s.input} style={{ display: 'flex', alignItems: 'center' }}>{bankLeg.notes}</span>
              <span />
            </div>
          )}
          {lines.map((l, i) => {
            const drBad = rmToSen(l.debit) == null;
            const crBad = rmToSen(l.credit) == null;
            return (
              <div data-grid-row key={i} className={s.formRow}>
                {/* The account fills its column, the widest on the line (owner
                    2026-09-18: JE 显示 hide 掉名字了 — the box clipped the name). */}
                <SearchCombo fill className={s.input} options={options} value={l.accountCode} onChange={(code) => setLine(i, { accountCode: code })}
                  placeholder="Type a code or a name" aria-label={`Line ${i + 1} account`} />
                <input className={`${s.input} ${s.amount} ${drBad ? s.inputBad : ''}`} placeholder="0.00" inputMode="decimal" aria-label={`Line ${i + 1} debit`}
                  value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} />
                <input className={`${s.input} ${s.amount} ${crBad ? s.inputBad : ''}`} placeholder="0.00" inputMode="decimal" aria-label={`Line ${i + 1} credit`}
                  value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} />
                <input data-upper className={s.input} placeholder="Optional" aria-label={`Line ${i + 1} note`}
                  value={l.notes} onChange={(e) => setLine(i, { notes: e.target.value })} />
                <button type="button" className={s.remove} title="Remove line" aria-label={`Remove line ${i + 1}`} disabled={lines.length <= (record ? 1 : 2)}
                  onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <X size={13} />
                </button>
              </div>
            );
          })}
          <div className={s.formFoot}>
            <span><button type="button" className={s.addLine} onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}><Plus size={13} />Add line</button></span>
            <span className={s.formTotal}>{fmtLedger(totals.dr)}</span>
            <span className={s.formTotal}>{fmtLedger(totals.cr)}</span>
            <span><span className={`${s.tag} ${toneClass(state.tone)}`}>{state.label}</span></span>
            <span />
          </div>
        </div>
        </fieldset>
      </div>
      {record ? (
        <div className={s.dFoot}>
          <span className={s.dFootText}>
            {postedNo ? `${postedNo} is posted — Match again asks the match only.` : 'Save & post writes it to the ledger and matches the bank line to it.'}
          </span>
          {/* Not while a step is running: a Cancel then would not stop the post it seems to stop. */}
          <button type="button" className={`${s.btn} ${s.dBtn}`} disabled={pending} onClick={onCancel}>{postedNo ? 'Close' : 'Cancel'}</button>
          <button type="button" className={`${s.btnSolid} ${s.dBtn}`} disabled={(!canSave && !postedNo) || pending} onClick={() => { void recordAndMatch(); }}>
            {step === 'checking' ? 'Checking…' : step === 'matching' ? 'Matching…' : postM.isPending ? 'Posting…' : createM.isPending || editM.isPending ? 'Saving…' : postedNo ? 'Match again' : 'Save & post'}
          </button>
        </div>
      ) : (
      <div className={s.dFoot}>
        <span className={s.dFootText}>{editing?.posted ? 'Saving posts the corrected entry at once.' : 'Save draft keeps it unposted; Save & post writes it to the ledger.'}</span>
        <button type="button" className={`${s.btn} ${s.dBtn}`} onClick={onCancel}>Cancel</button>
        {!editing?.posted && (
          <button type="button" className={`${s.btnPrimary} ${s.dBtn}`} disabled={!canSave || pending} onClick={() => { void save(false); }}>
            {createM.isPending || editM.isPending ? 'Saving…' : 'Save draft'}
          </button>
        )}
        <button type="button" className={`${s.btnSolid} ${s.dBtn}`} disabled={!canSave || pending} onClick={() => { void save(true); }}>
          {postM.isPending ? 'Posting…' : 'Save & post'}
        </button>
      </div>
      )}
    </div>
  );
};
