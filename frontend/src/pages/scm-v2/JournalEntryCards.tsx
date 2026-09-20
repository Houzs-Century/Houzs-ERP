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
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import {
  useJournalEntryDetail, useCreateJournalEntry, usePostJournalEntry, useAccounts, leafAccounts,
  type JournalEntry, type JournalEntryLine, type JeLineIn,
} from '../../vendor/scm/lib/accounting-queries';
import { useEditJournalEntry, useReverseJournalEntry } from './accounting-phase1-queries';
import { fmtSen, fmtDateOrDash } from '../../vendor/shared/format';
import { byText } from '../../vendor/scm/lib/sort-options';
import { DateField } from '../../vendor/scm/components/DateField';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import styles from './Suppliers.module.css';

const fmt = (sen: number | null | undefined) => fmtSen(sen);

/* Small shared form styling for the phase-1 cards. */
export const cardStyle: React.CSSProperties = {
  padding: 'var(--space-4)',
  background: 'var(--c-cream)',
  border: '1px solid var(--c-line, rgba(34,31,32,0.12))',
  borderRadius: 'var(--radius-md)',
};
export const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  borderRadius: 'var(--radius-sm, 6px)',
  fontSize: 'var(--fs-13)',
  background: 'white',
};
export const btnStyle = (primary?: boolean): React.CSSProperties => ({
  padding: '6px 14px',
  border: '1px solid var(--c-ink)',
  borderRadius: 'var(--radius-md)',
  background: primary ? 'var(--c-ink)' : 'transparent',
  color: primary ? 'var(--c-cream)' : 'var(--c-ink)',
  fontSize: 'var(--fs-13)',
  fontWeight: 600,
  cursor: 'pointer',
});

/* JE status label — REVERSED wins over POSTED, then DRAFT. */
export const jeStatus = (r: JournalEntry): string =>
  r.reversed ? 'REVERSED' : r.posted ? 'POSTED' : 'DRAFT';

/* RM string → integer sen; null when the input is not money. */
export const rmToSen = (raw: string): number | null => {
  const t = raw.trim();
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

/* One form for a new journal, a copy and an edit. `editing` names the entry
   being edited: Save then goes to PUT /journal-entries/:id — a posted entry
   is reversed and the corrected one posted in the same step, a draft is
   rewritten in place — and the date box opens on the entry's own day. */
export const NewJournalForm = ({ onDone, initial, editing }: { onDone: () => void; initial?: DraftSeed | null; editing?: EditSeed | null }) => {
  const accounts = useAccounts();
  const createM = useCreateJournalEntry();
  const editM = useEditJournalEntry();
  const [entryDate, setEntryDate] = useState(() => editing?.entryDate ?? new Date().toISOString().slice(0, 10));
  const [narration, setNarration] = useState(initial?.narration ?? '');
  const [lines, setLines] = useState<DraftLine[]>(initial && initial.lines.length > 0 ? initial.lines.map((l) => ({ ...l })) : [{ ...EMPTY_LINE }, { ...EMPTY_LINE }]);

  const all = accounts.data?.accounts ?? [];
  // Postable = active and not a header (retired children count, docs/bugs/0693)
  // — the engine's own rule from its one screen-side home, applied here so the
  // picker cannot offer an account the post will refuse.
  const postable = useMemo(() => leafAccounts(all), [all]);
  /* Typed to, not scrolled through (owner 2026-09-15: 无法快速打关键字眼找
     account): every word typed must match the code or the name. */
  const options = useMemo(
    () => [...postable].sort((a, b) => byText(a.account_code, b.account_code)).map((a) => ({ value: a.account_code, label: `${a.account_code} — ${a.account_name}` })),
    [postable],
  );

  const totals = useMemo(() => {
    let dr = 0; let cr = 0; let bad = false;
    for (const l of lines) {
      const d = rmToSen(l.debit); const c = rmToSen(l.credit);
      if (d == null || c == null) { bad = true; continue; }
      dr += d; cr += c;
      if (d > 0 && c > 0) bad = true;
    }
    return { dr, cr, bad };
  }, [lines]);

  const canSave = !totals.bad && totals.dr === totals.cr && totals.dr > 0
    && lines.every((l) => l.accountCode || (!l.debit && !l.credit));

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const pending = createM.isPending || editM.isPending;
  const submit = () => {
    const body = {
      entryDate,
      narration: narration.trim() || null,
      lines: lines
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
    };
    if (editing) editM.mutate({ id: editing.id, ...body }, { onSuccess: onDone });
    else createM.mutate(body, { onSuccess: onDone });
  };

  return (
    <div style={cardStyle} className="space-y-3">
      <div style={{ fontWeight: 700 }}>
        {editing ? (
          <>
            Edit {editing.jeNo}
            <span style={{ fontWeight: 400, fontSize: 'var(--fs-13)', color: 'var(--c-ink-soft, #555)' }}>
              {editing.posted
                ? ' · posted — saving reverses it on its own day and posts the corrected entry under a new number'
                : ' · draft — saving rewrites it in place'}
            </span>
          </>
        ) : (
          <>
            New manual journal (draft — posting is a separate step)
            {initial && <span style={{ fontWeight: 400, fontSize: 'var(--fs-13)', color: 'var(--c-ink-soft, #555)' }}> · copied — check the date, the figures and the notes before saving</span>}
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <DateField style={fieldStyle} value={entryDate} onChange={(iso) => setEntryDate(iso)}/>
        <input style={{ ...fieldStyle, flex: 1, minWidth: 240 }} placeholder="Narration (what is this entry?)"
          value={narration} onChange={(e) => setNarration(e.target.value)} />
      </div>

      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          {/* The account fills its column, and the column is the widest on the line
              (owner 2026-09-18: JE 显示 hide 掉名字了 — the box clipped the name). */}
          <span style={{ minWidth: 300, flex: 2 }}>
            <SearchCombo fill options={options} value={l.accountCode} onChange={(code) => setLine(i, { accountCode: code })}
              placeholder="Type a code or a name…" aria-label={`Line ${i + 1} account`} />
          </span>
          <input style={{ ...fieldStyle, width: 120 }} placeholder="Debit RM" inputMode="decimal" aria-label={`Line ${i + 1} debit`}
            value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} />
          <input style={{ ...fieldStyle, width: 120 }} placeholder="Credit RM" inputMode="decimal" aria-label={`Line ${i + 1} credit`}
            value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} />
          <input style={{ ...fieldStyle, flex: 1, minWidth: 160 }} placeholder="Line note" aria-label={`Line ${i + 1} note`}
            value={l.notes} onChange={(e) => setLine(i, { notes: e.target.value })} />
          {lines.length > 2 && (
            <button type="button" style={btnStyle()} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={btnStyle()} onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}>Add line</button>
        <span style={{ fontSize: 'var(--fs-13)' }}>
          Dr {fmt(totals.dr)} · Cr {fmt(totals.cr)} ·{' '}
          {totals.dr === totals.cr && totals.dr > 0 && !totals.bad
            ? <b style={{ color: 'var(--c-secondary-a, #2F5D4F)' }}>balanced</b>
            : <b style={{ color: 'var(--c-festive-b, #B8331F)' }}>{totals.bad ? 'invalid amounts' : 'not balanced'}</b>}
        </span>
        <button type="button" style={btnStyle(true)} disabled={!canSave || pending} onClick={submit}>
          {pending ? 'Saving…' : editing?.posted ? 'Save & post' : 'Save draft'}
        </button>
      </div>
    </div>
  );
};

export const JeDetailCard = ({ id, onClose, onCopy, onEdit }: { id: string; onClose: () => void; onCopy?: (seed: DraftSeed) => void; onEdit?: (seed: EditSeed) => void }) => {
  const q = useJournalEntryDetail(id);
  const postM = usePostJournalEntry();
  const reverseM = useReverseJournalEntry();
  const accounts = useAccounts();
  const je = q.data?.journalEntry;
  const lines = q.data?.lines ?? [];
  const nameOf = useMemo(() => new Map((accounts.data?.accounts ?? []).map((a) => [a.account_code, a.account_name])), [accounts.data]);

  return (
    <div style={cardStyle} className="space-y-3">
      {!je ? (
        <div style={{ fontSize: 'var(--fs-13)' }}>{q.isLoading ? 'Loading…' : 'Entry not found.'}</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={styles.codeChip}>{je.je_no}</span>
            <span>{fmtDateOrDash(je.entry_date)}</span>
            <span>{je.source_type}{je.source_doc_no ? ` · ${je.source_doc_no}` : ''}</span>
            <span className={`${styles.statusPill} ${je.posted ? styles.statusActive : styles.statusInactive}`}>{jeStatus(je)}</span>
            <span style={{ flex: 1 }} />
            {je.source_type === 'MANUAL' && !je.posted && !je.reversed && (
              <button type="button" style={btnStyle(true)} disabled={postM.isPending}
                onClick={() => postM.mutate(id)}>
                {postM.isPending ? 'Posting…' : 'Post'}
              </button>
            )}
            {/* A manual journal not yet reversed opens in the form on its own
                date and lines (owner: 我无法 edit) — a posted one is reversed
                and re-posted by the save, a draft rewritten. A document's
                entry is corrected through its document; a reversed one is
                history, to copy. */}
            {je.source_type === 'MANUAL' && !je.reversed && onEdit && lines.length > 0 && (
              <button type="button" style={btnStyle()} onClick={() => onEdit(editSeedFromEntry(je, lines))}>Edit</button>
            )}
            {je.source_type === 'MANUAL' && je.posted && !je.reversed && (
              <button type="button" style={btnStyle()} disabled={reverseM.isPending}
                onClick={() => reverseM.mutate(id)}>
                {reverseM.isPending ? 'Reversing…' : 'Reverse'}
              </button>
            )}
            {/* A manual journal keyed every month is copied into a new draft —
                its lines, its notes, its narration — dated today (owner: 没有
                办法 copy). Never a posting: a draft, to edit and post. */}
            {je.source_type === 'MANUAL' && onCopy && lines.length > 0 && (
              <button type="button" style={btnStyle()} onClick={() => onCopy(seedFromEntry(je, lines))}>Copy</button>
            )}
            <button type="button" style={btnStyle()} onClick={onClose}>Close</button>
          </div>
          {je.narration && <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-ink-soft, #555)' }}>{je.narration}</div>}
          <table style={{ width: '100%', fontSize: 'var(--fs-13)', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.12))' }}>
                <th style={{ padding: '4px 8px' }}>#</th>
                <th style={{ padding: '4px 8px' }}>Account</th>
                <th style={{ padding: '4px 8px', textAlign: 'right' }}>Debit</th>
                <th style={{ padding: '4px 8px', textAlign: 'right' }}>Credit</th>
                <th style={{ padding: '4px 8px' }}>Party</th>
                <th style={{ padding: '4px 8px' }}>Note</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} style={{ borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.06))' }}>
                  <td style={{ padding: '4px 8px', verticalAlign: 'top' }}>{l.line_no}</td>
                  <td style={{ padding: '4px 8px' }}><AccountCell code={l.account_code} name={nameOf.get(l.account_code)} /></td>
                  <td style={{ padding: '4px 8px', textAlign: 'right', verticalAlign: 'top' }}>{l.debit_sen > 0 ? fmt(l.debit_sen) : '—'}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right', verticalAlign: 'top' }}>{l.credit_sen > 0 ? fmt(l.credit_sen) : '—'}</td>
                  <td style={{ padding: '4px 8px', verticalAlign: 'top' }}>{l.party_name ?? l.party_code ?? '—'}</td>
                  <td style={{ padding: '4px 8px', verticalAlign: 'top' }}>{l.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
};
