// ----------------------------------------------------------------------------
// TodoCalendar — the To do's Calendar view (the owner's Claude Design redesign,
// Finance-1a-To-do, batch 2): what falls on each day of the month — payments
// due, money due in, routines, tasks, uploads gone late — with the chosen day's
// list and the next 7 days. A task or routine is dragged to another day to move
// it this time only; a bill or invoice keeps its own document's date.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Paperclip } from 'lucide-react';
import { fmtDate, fmtSen } from '../../../vendor/shared/format';
import styles from './TodoCalendar.module.css';
import { useMarkTask, useTodoCalendar, type CalEvent, type CalKind } from './finance-todo-queries';
import { usePlanBill } from '../../../vendor/scm/lib/ap-invoice-queries';
import { useToastOptional } from '../../../hooks/useToast';
import { planMovedText } from '../BillPlanDialog';

const KIND_CLASS: Record<CalKind, string> = {
  pay: styles.kindPay, in: styles.kindIn, routine: styles.kindRoutine, task: styles.kindTask, late: styles.kindLate,
};
const LEGEND: Array<[CalKind, string]> = [['pay', 'Payment due'], ['in', 'Money due in'], ['routine', 'Routine'], ['task', 'Task'], ['late', 'Overdue']];
const SHOWN_PER_DAY = 3;

const dayNo = (ymd: string): number => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
const ymdOf = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);
const shiftMonth = (ym: string, by: number): string => {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const monthTitle = (ym: string): string =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-MY', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const weekdayOf = (ymd: string): string => new Date(`${ymd}T00:00:00Z`).toLocaleString('en-MY', { weekday: 'short', timeZone: 'UTC' });

/** Mon … Sun, as the date library names them (2 Nov 2026 was a Monday). */
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => weekdayOf(ymdOf(dayNo('2026-11-02') + i)));

/** The month's grid, Monday first, whole weeks. */
function gridDays(month: string): string[] {
  const first = `${month}-01`;
  const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = dayNo(first) - lead;
  const last = dayNo(`${shiftMonth(month, 1)}-01`) - 1;
  const weeks = Math.ceil((last - start + 1) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => ymdOf(start + i));
}

/** What an item's button says and does — or nothing. */
function useItemAction() {
  const mark = useMarkTask();
  const navigate = useNavigate();
  return (e: CalEvent): { label: string; run: () => void } | null => {
    const t = e.task;
    if (t) {
      if (e.done) return { label: 'Reopen', run: () => mark.mutate({ id: t.id, kind: 'reopen', occursOn: t.occursOn }) };
      if (t.kind === 'task') return t.mine ? { label: 'Mark done', run: () => mark.mutate({ id: t.id, kind: 'done', occursOn: t.occursOn }) } : null;
      if (t.action === 'voucher') {
        return { label: 'Make voucher', run: () => mark.mutate({ id: t.id, kind: 'done', occursOn: t.occursOn }, { onSuccess: () => navigate('/scm/payment-vouchers/new') }) };
      }
      return e.to ? { label: t.action === 'checklist' ? 'Open checklist' : 'Open', run: () => navigate(e.to ?? '/') } : null;
    }
    if (!e.to) return null;
    const to = e.to;
    return { label: e.kind === 'late' ? 'Upload' : 'Open', run: () => navigate(to) };
  };
}

export function TodoCalendar({ today, onOpenTask }: {
  today: string;
  onOpenTask: (t: { id: string; occursOn: string; due: string }) => void;
}) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<CalEvent | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const q = useTodoCalendar(month);
  const mark = useMarkTask();
  const actionOf = useItemAction();
  /* A bill dragged to another day moves its planned payment date (step 7). */
  const plan = usePlanBill();
  const toast = useToastOptional();
  const sel = selected ?? (month === today.slice(0, 7) ? today : `${month}-01`);
  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of q.data?.events ?? []) m.set(e.day, [...(m.get(e.day) ?? []), e]);
    return m;
  }, [q.data]);
  const days = gridDays(month);
  const selItems = byDay.get(sel) ?? [];
  const canDrag = (e: CalEvent): boolean => (!!e.bill && !e.done) || (!!e.task && !e.done && (e.task.kind === 'routine' || e.task.mine));
  const drop = (day: string) => {
    const e = dragging;
    setDragging(null);
    setOver(null);
    if (!e || day === e.day) return;
    const bill = e.bill;
    if (bill) {
      /* The planned day moves; the supplier's due date stays (the design's toast). */
      if (day < today) { toast?.error('A bill cannot be planned on a past day.'); return; }
      plan.mutate({ kind: bill.kind, id: bill.id, plannedOn: day }, {
        onSuccess: () => toast?.success(planMovedText(bill.no, day, bill.due)),
        onError: (err) => toast?.error(err instanceof Error ? err.message : 'The planned date was not saved.'),
      });
      return;
    }
    if (!e.task) return;
    mark.mutate({ id: e.task.id, kind: 'move', occursOn: e.task.occursOn, to: day });
  };
  const go = (by: number) => { setMonth(shiftMonth(month, by)); setSelected(null); };

  return (
    <div className={styles.wrap}>
      <div className={styles.calCard}>
        <div className={styles.calHead}>
          <button type="button" className={styles.nav} onClick={() => go(-1)} aria-label="Previous month"><ChevronLeft size={14} /></button>
          <span className={styles.calTitle}>{monthTitle(month)}</span>
          <button type="button" className={styles.nav} onClick={() => go(1)} aria-label="Next month"><ChevronRight size={14} /></button>
          <span className={styles.grow} />
          <div className={styles.legend}>
            {LEGEND.map(([k, l]) => <span key={k} className={styles.legendItem}><span className={`${styles.dot} ${KIND_CLASS[k]}`} />{l}</span>)}
          </div>
        </div>
        {q.isError && <div className={styles.problem}>The calendar could not be read — {q.error instanceof Error ? q.error.message : 'try again'}.</div>}
        {q.data && q.data.problems.length > 0 && <div className={styles.problem}>Some of it could not be read, so it is not shown: {q.data.problems.join(' · ')}.</div>}
        <div className={styles.weekdays}>{WEEKDAYS.map((w) => <span key={w}>{w}</span>)}</div>
        <div className={styles.grid} aria-busy={q.isLoading} onDragLeave={() => setOver(null)}>
          {days.map((d) => {
            const items = byDay.get(d) ?? [];
            const inMonth = d.slice(0, 7) === month;
            return (
              <div key={d} role="button" tabIndex={0} aria-label={fmtDate(d)} aria-pressed={d === sel}
                className={`${styles.cell} ${inMonth ? '' : styles.cellOut} ${d === sel ? styles.cellSel : ''} ${d === today ? styles.cellToday : ''} ${over === d ? styles.cellOver : ''}`}
                onClick={() => setSelected(d)} onKeyDown={(ev) => { if (ev.key === 'Enter') setSelected(d); }}
                onDragOver={(ev) => { if (dragging) { ev.preventDefault(); setOver(d); } }}
                onDrop={(ev) => { ev.preventDefault(); drop(d); }}>
                <span className={styles.num}>{Number(d.slice(8, 10))}</span>
                {items.slice(0, SHOWN_PER_DAY).map((e) => (
                  <span key={e.key} className={`${styles.chip} ${KIND_CLASS[e.kind]} ${e.done ? styles.chipDone : ''} ${dragging?.key === e.key ? styles.chipDragging : ''}`}
                    title={`${e.label}${e.detail ? ` — ${e.detail}` : ''}${e.amountSen ? ` — ${fmtSen(e.amountSen)}` : ''}${canDrag(e) ? (e.bill ? ' · drag to another day to plan its payment there' : ' · drag to another day to move it this time only') : ''}`}
                    draggable={canDrag(e)} onDragStart={(ev) => { ev.dataTransfer.effectAllowed = 'move'; setDragging(e); }} onDragEnd={() => { setDragging(null); setOver(null); }}>
                    <span className={styles.chipDot} />{e.short}
                  </span>
                ))}
                {items.length > SHOWN_PER_DAY && <span className={styles.more}>+{items.length - SHOWN_PER_DAY} more</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.side}>
        <div className={styles.dayCard} aria-label="Chosen day">
          <div className={styles.dayHead}>
            <span className={styles.dayTitle}>{weekdayOf(sel)} {fmtDate(sel)}</span>
            <span className={styles.daySub}>{sel === today ? 'today' : selItems.length ? `${selItems.length} item${selItems.length > 1 ? 's' : ''}` : ''}</span>
          </div>
          {selItems.map((e) => {
            const a = actionOf(e);
            return (
              <div key={e.key} className={styles.item} draggable={canDrag(e)}
                onDragStart={(ev) => { ev.dataTransfer.effectAllowed = 'move'; setDragging(e); }} onDragEnd={() => { setDragging(null); setOver(null); }}>
                <span className={`${styles.dot} ${KIND_CLASS[e.kind]}`} />
                <div className={styles.itemMain}>
                  {e.task
                    ? <button type="button" className={`${styles.itemLabel} ${styles.itemLabelLink} ${e.done ? styles.itemDone : ''}`}
                        onClick={() => { const t = e.task; if (t) onOpenTask({ id: t.id, occursOn: t.occursOn, due: e.day }); }}>{e.label}</button>
                    : <span className={`${styles.itemLabel} ${e.done ? styles.itemDone : ''}`}>{e.label}</span>}
                  <div className={styles.itemDetail}>{e.detail}</div>
                  {e.task?.link && <Link to={e.task.link.to} className={styles.linkChip}><Paperclip size={12} />{e.task.link.no}</Link>}
                  {a && <button type="button" className={styles.itemAction} onClick={a.run} disabled={mark.isPending}>{a.label}</button>}
                </div>
                <span className={`${styles.itemAmount} ${e.kind === 'in' ? styles.amountIn : ''}`}>{e.amountSen ? fmtSen(e.amountSen) : ''}</span>
              </div>
            );
          })}
          {selItems.length === 0 && <div className={styles.empty}>{sel === today ? 'Nothing falls due today. Open work stays in the List.' : 'Nothing on this day.'}</div>}
        </div>
        <div className={styles.dayCard} aria-label="Next 7 days">
          <div className={styles.nextTitle}>Next 7 days</div>
          {(q.data?.next7 ?? []).map((n) => (
            <div key={n.kind} className={styles.nextRow}>
              <span className={`${styles.dot} ${KIND_CLASS[n.kind]}`} />
              <span className={styles.nextLabel}>{n.label}</span>
              <span className={styles.nextCount}>{n.count}</span>
              <span className={styles.nextAmount}>{n.amountSen ? fmtSen(n.amountSen) : ''}</span>
            </div>
          ))}
          {q.data && q.data.next7.length === 0 && <div className={styles.empty}>Nothing due in the next 7 days.</div>}
        </div>
      </div>
    </div>
  );
}
