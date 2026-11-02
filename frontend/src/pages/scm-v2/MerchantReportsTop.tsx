// ----------------------------------------------------------------------------
// MerchantReportsTop — the top of Merchant reports (the owner's Claude Design
// redesign, batch 3): a card per acquirer — what is left to decide on its
// reports and where it stands — and, for the chosen one, its reports by the
// day customers swiped: open work first, then the latest, with every report a
// click away under "All reports". The cards come from the data — every active
// acquirer and any with reports — never from a fixed list.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { fmtDate } from '../../vendor/shared/format';
import styles from './MerchantReports.module.css';
import type { AcquirerSetup, SettlementBatch } from './settlement-queries';

const toDecide = (b: SettlementBatch): number => (b.to_choose_count ?? 0) + (b.no_record_count ?? 0);
const toConfirm = (b: SettlementBatch): number => b.to_confirm_count ?? 0;
const isOpen = (b: SettlementBatch): boolean => (b.open_count ?? 0) > 0;

/** The swipe days a report covers, as the design names them. */
export const swipeLabel = (b: SettlementBatch): string => {
  const from = b.period_from ?? b.period_to;
  const to = b.period_to ?? b.period_from;
  if (!from || !to) return b.file_name;
  return from === to ? fmtDate(to) : `${fmtDate(from)} – ${fmtDate(to)}`;
};

/** A report's pill: what is left on it, else whether its money is in. */
export function reportPill(b: SettlementBatch): { text: string; tone: 'info' | 'warn' | 'calm' } {
  if (toConfirm(b) > 0) return { text: `${toConfirm(b)} to confirm`, tone: 'info' };
  if (toDecide(b) > 0) return { text: `${toDecide(b)} to decide`, tone: 'warn' };
  return { text: b.received_on ? 'Paid out' : 'Confirmed', tone: 'calm' };
}

export type AcquirerCard = { code: string; name: string; toDecide: number; status: { text: string; tone: 'late' | 'info' | 'warn' | 'ok' } };

/** One card per acquirer: every active one set up here, and any with reports. */
export function acquirerCards(setup: AcquirerSetup[], batches: SettlementBatch[], missingDay: Record<string, string>): AcquirerCard[] {
  const codes = [...new Set([...setup.filter((a) => a.is_active).map((a) => a.code), ...batches.map((b) => b.acquirer_code)])];
  return codes.map((code) => {
    const mine = batches.filter((b) => b.acquirer_code === code);
    const confirm = mine.reduce((n, b) => n + toConfirm(b), 0);
    const decide = mine.reduce((n, b) => n + toDecide(b), 0);
    const name = setup.find((a) => a.code === code)?.display_name ?? code;
    const missing = missingDay[code];
    const status: AcquirerCard['status'] = missing ? { text: `${fmtDate(missing)} report missing`, tone: 'late' }
      : confirm > 0 ? { text: `${confirm} line${confirm > 1 ? 's' : ''} ready to confirm`, tone: 'info' }
        : decide > 0 ? { text: `${decide} line${decide > 1 ? 's' : ''} to decide`, tone: 'warn' }
          : { text: 'Up to date', tone: 'ok' };
    return { code, name, toDecide: confirm + decide, status };
  });
}

/** The report chips for one acquirer: open work first (oldest first), then the latest; at most `max`. */
export function stripReports(batches: SettlementBatch[], max: number): SettlementBatch[] {
  const byDay = (b: SettlementBatch) => b.period_to ?? b.period_from ?? b.created_at;
  const open = batches.filter(isOpen).sort((a, b) => byDay(a).localeCompare(byDay(b)));
  const done = batches.filter((b) => !isOpen(b)).sort((a, b) => byDay(b).localeCompare(byDay(a)));
  return [...open, ...done].slice(0, max);
}

const TONE: Record<string, string> = {
  late: styles.toneLate, info: styles.toneInfo, warn: styles.toneWarn, ok: styles.toneOk, calm: styles.toneCalm,
};

export function AcquirerCards({ cards, selected, onSelect }: { cards: AcquirerCard[]; selected: string | null; onSelect: (code: string) => void }) {
  return (
    <div className={styles.cards} role="group" aria-label="Acquirers">
      {cards.map((c) => (
        <button key={c.code} type="button" className={`${styles.card} ${selected === c.code ? styles.cardOn : ''}`} aria-pressed={selected === c.code} onClick={() => onSelect(c.code)}>
          <span className={styles.cardHead}><span className={styles.codeChip}>{c.code}</span><span className={styles.cardName}>{c.name}</span></span>
          <span className={`${styles.count} ${c.toDecide === 0 ? styles.countZero : ''}`}>{c.toDecide}</span>
          <span className={styles.countLabel}>to decide</span>
          <span className={styles.status}><span className={`${styles.dot} ${TONE[c.status.tone]}`} />{c.status.text}</span>
        </button>
      ))}
    </div>
  );
}

function AllReports({ batches, onOpen }: { batches: SettlementBatch[]; onOpen: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'all' | 'todo' | 'done'>('all');
  const term = q.trim().toLowerCase();
  const shown = batches
    .filter((b) => (mode === 'all' ? true : mode === 'todo' ? isOpen(b) : !isOpen(b)))
    .filter((b) => !term || swipeLabel(b).toLowerCase().includes(term) || b.file_name.toLowerCase().includes(term))
    .sort((a, b) => (b.period_to ?? b.created_at).localeCompare(a.period_to ?? a.created_at));
  const months = new Map<string, SettlementBatch[]>();
  for (const b of shown) {
    const m = new Date(`${(b.period_to ?? b.created_at).slice(0, 7)}-01T00:00:00Z`).toLocaleString('en-MY', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    months.set(m, [...(months.get(m) ?? []), b]);
  }
  const counts = { all: batches.length, todo: batches.filter(isOpen).length, done: batches.filter((b) => !isOpen(b)).length };
  return (
    <div className={styles.popover} role="dialog" aria-label="All reports">
      <div className={styles.search}><Search size={13} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a swipe date, e.g. 10/14" aria-label="Find a report" /></div>
      <div className={styles.modes}>
        {(['all', 'todo', 'done'] as const).map((m) => (
          <button key={m} type="button" className={`${styles.mode} ${mode === m ? styles.modeOn : ''}`} aria-pressed={mode === m} onClick={() => setMode(m)}>
            {m === 'all' ? 'All' : m === 'todo' ? 'To do' : 'Done'} {counts[m]}
          </button>
        ))}
      </div>
      <div className={styles.popList}>
        {[...months].map(([m, bs]) => (
          <div key={m}>
            <div className={styles.monthHead}>{m}</div>
            {bs.map((b) => {
              const p = reportPill(b);
              return (
                <button key={b.id} type="button" className={styles.popRow} onClick={() => onOpen(b.id)}>
                  <span className={styles.popDay}>{swipeLabel(b)}</span>
                  <span className={styles.popSub}>{b.row_count} lines · {b.file_name}</span>
                  <span className={`${styles.pill} ${TONE[p.tone]}`}>{p.text}</span>
                </button>
              );
            })}
          </div>
        ))}
        {batches.length === 0 && <div className={styles.muted}>No reports uploaded yet.</div>}
        {batches.length > 0 && shown.length === 0 && <div className={styles.muted}>No report for that swipe date.</div>}
      </div>
    </div>
  );
}

export function ReportStrip({ code, batches, openId, missingDay, onOpen, extra }: {
  code: string; batches: SettlementBatch[]; openId: number | null; missingDay: string | null;
  onOpen: (id: number) => void; extra?: React.ReactNode;
}) {
  const [allOpen, setAllOpen] = useState(false);
  const chips = useMemo(() => stripReports(batches, code === 'PBB' ? 2 : 3), [batches, code]);
  const hidden = batches.filter(isOpen).filter((b) => !chips.includes(b)).length;
  return (
    <div className={styles.strip} aria-label={`${code} reports`}>
      <span className={styles.stripLabel}>{code} reports <span className={styles.muted}>by the date customers swiped</span></span>
      {missingDay && (
        <span className={styles.chip} title="Not uploaded yet">
          {fmtDate(missingDay)} <span className={`${styles.pill} ${styles.toneLate}`}><span className={`${styles.dot} ${styles.toneLate}`} />Missing</span>
        </span>
      )}
      {chips.map((b) => {
        const p = reportPill(b);
        return (
          <button key={b.id} type="button" className={`${styles.chip} ${openId === b.id ? styles.chipOn : ''}`} aria-pressed={openId === b.id}
            title={`${b.row_count} lines · RM ${(b.gross_sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })}`} onClick={() => onOpen(b.id)}>
            {swipeLabel(b)} <span className={`${styles.pill} ${TONE[p.tone]}`}>{p.text}</span>
          </button>
        );
      })}
      <span className={styles.popWrap}>
        <button type="button" className={styles.chip} aria-expanded={allOpen} onClick={() => setAllOpen(!allOpen)}>
          All reports {batches.length}{hidden > 0 && <span className={`${styles.pill} ${styles.toneWarn}`}>+{hidden} to do</span>}
        </button>
        {allOpen && <AllReports batches={batches} onOpen={(id) => { setAllOpen(false); onOpen(id); }} />}
      </span>
      <span className={styles.grow} />
      {extra}
    </div>
  );
}
