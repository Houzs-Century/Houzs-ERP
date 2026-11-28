// ----------------------------------------------------------------------------
// TradeFinanceDialog — the Cash Flow's trade-finance plan (step 5 of the
// forecast port, owner 2026-11-24 「开始做第 5 步」; D3: no limit, each draw
// repaid about two months after it). Per facility (a liability account named
// TRADE FINANCE): the tenor and the interest per draw (blank = 60 days and the
// recent repayments' rate), what is owed today, and the suppliers it pays.
// Each chosen supplier's dues — a bill the books owe it (blue) or its Forecast
// P&L figure from this month on (beige) — are drawn in their month unless
// unticked; below them the drawdown, the repayment a tenor later, its interest
// and what is owed at each month's end, worked out as you change the plan.
// Forecast only: nothing posts. Save keeps the whole plan.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@2990s/design-system';
import { Modal } from '../../../vendor/scm/components/Modal';
import { useToastOptional } from '../../../hooks/useToast';
import { fmtSenPlain } from '../../../../../shared/src/vendor/shared/format';
import {
  useSaveTradeFinance, useTradeFinance,
  type TfDue, type TfFacility, type TfMonth, type TfOff, type TfPlans, type TradeFinance,
} from '../../../vendor/scm/lib/cash-flow-forecast-queries';
import { monthName } from './statementColumns';
import f from './Forecast.module.css';

const DEFAULT_TENOR_DAYS = 60;

const addMonths = (ym: string, n: number): string => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

export const isTicked = (off: TfOff, ym: string, id: string): boolean => !(off[ym] ?? []).includes(id);

/** One supplier's due in a month, or nothing — a lookup that says either may be absent. */
export const dueOf = (dues: Partial<Record<string, Partial<Record<string, TfDue>>>>, id: string, ym: string): TfDue | null => dues[id]?.[ym] ?? null;

/** The plan with one supplier's month ticked or unticked; a month left with none goes. */
export function toggleTick(off: TfOff, ym: string, id: string): TfOff {
  const list = off[ym] ?? [];
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  const out = { ...off };
  if (next.length > 0) out[ym] = next; else delete out[ym];
  return out;
}

/** Interest per draw as the table shows it: basis points → "0.67". */
export const pctOf = (bp: number): string => (bp / 100).toFixed(2);

/** A typed rate: blank = the default (null), a percentage 0–100 = basis points, anything else = not readable. */
export function readRate(text: string): number | null | undefined {
  const t = text.trim().replace(/%$/, '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : undefined;
}

/** A typed tenor: blank = the default (null), whole days 1–400, anything else = not readable. */
export function readTenor(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 400 ? n : undefined;
}

/** The months as the plan stands: drawn (the chosen suppliers' ticked dues), repaid a tenor later
    (the owed draws too, a past-due one this month), the interest with each repayment, owed at month end. */
export function tfSchedule(o: {
  currentYm: string; months: readonly string[]; tenorDays: number; rateBp: number;
  open: ReadonlyArray<{ date: string; sen: number }>; dues: Record<string, Record<string, TfDue>>; suppliers: readonly string[]; off: TfOff;
}): TfMonth[] {
  const shift = Math.max(0, Math.round(o.tenorDays / 30));
  const repaid = new Map<string, number>();
  const pay = (ym: string, sen: number): void => { repaid.set(ym, (repaid.get(ym) ?? 0) + sen); };
  for (const d of o.open) {
    const due = addMonths(d.date.slice(0, 7), shift);
    pay(due < o.currentYm ? o.currentYm : due, d.sen);
  }
  const drawn = new Map<string, number>();
  for (const id of o.suppliers) {
    for (const [ym, due] of Object.entries(o.dues[id] ?? {})) {
      const sen = due.billSen + due.forecastSen;
      if (sen <= 0 || !isTicked(o.off, ym, id)) continue;
      drawn.set(ym, (drawn.get(ym) ?? 0) + sen);
    }
  }
  for (const [ym, sen] of drawn) pay(addMonths(ym, shift), sen);
  let owed = o.open.reduce((s, d) => s + d.sen, 0);
  return o.months.map((ym) => {
    const drawSen = drawn.get(ym) ?? 0;
    const repaySen = repaid.get(ym) ?? 0;
    owed += drawSen - repaySen;
    return { ym, drawSen, repaySen, interestSen: Math.round((repaySen * o.rateBp) / 10_000), owedSen: owed };
  });
}

const messageOf = (e: unknown): string => {
  const o = (e ?? {}) as { body?: unknown; message?: unknown };
  if (typeof o.body === 'string') {
    try {
      const b = JSON.parse(o.body) as { message?: unknown; error?: unknown };
      if (typeof b.message === 'string' && b.message) return b.message;
      if (typeof b.error === 'string' && b.error) return b.error;
    } catch { }
  }
  return typeof o.message === 'string' && o.message ? o.message : 'The plan was not saved.';
};

const planOf = (data: TradeFinance): TfPlans =>
  Object.fromEntries(data.facilities.map((x) => [x.code, { tenorDays: x.tenorSet, rateBp: x.rateSet, suppliers: x.suppliers, off: x.off }]));

type Plan = TfPlans[string];

function FacilityTable({ data, facility, plan, onPlan, canWrite }: {
  data: TradeFinance; facility: TfFacility; plan: Plan; onPlan: (p: Plan) => void; canWrite: boolean;
}) {
  const [tenorText, setTenorText] = useState(plan.tenorDays == null ? '' : String(plan.tenorDays));
  const [rateText, setRateText] = useState(plan.rateBp == null ? '' : pctOf(plan.rateBp));
  const supplier = useMemo(() => new Map(data.suppliers.map((s) => [s.id, s])), [data.suppliers]);
  const tenorDays = plan.tenorDays ?? DEFAULT_TENOR_DAYS;
  const rateBp = plan.rateBp ?? facility.defaultRateBp;
  const schedule = tfSchedule({ currentYm: data.currentMonth, months: data.shown, tenorDays, rateBp, open: facility.open, dues: facility.dues, suppliers: plan.suppliers, off: plan.off });
  const others = data.suppliers.filter((s) => !plan.suppliers.includes(s.id));
  const nameOf = (id: string): string => supplier.get(id)?.name ?? id;
  const bad = readTenor(tenorText) === undefined || readRate(rateText) === undefined;
  const sumRow = (label: string, pick: (m: TfMonth) => number, strong = false) => (
    <tr className={strong ? f.strongRow : f.row} data-row={label}>
      <td className={f.name}>{label}</td>
      {schedule.map((m) => <td key={m.ym} className={f.cell}>{pick(m) === 0 ? '' : fmtSenPlain(pick(m))}</td>)}
    </tr>
  );
  return (
    <section aria-label={`${facility.code} trade finance`} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', alignItems: 'center' }}>
        <strong>{facility.code} · {facility.name}</strong>
        <label className={f.hint}>
          Tenor{' '}
          <input
            className={`${f.box} ${f.boxOpen}`} style={{ width: 64 }} inputMode="numeric" aria-label={`${facility.code} tenor in days`} readOnly={!canWrite}
            value={tenorText} placeholder={String(DEFAULT_TENOR_DAYS)}
            onChange={(e) => { setTenorText(e.target.value); const v = readTenor(e.target.value); if (v !== undefined) onPlan({ ...plan, tenorDays: v }); }}
          />{' '}days
        </label>
        <label className={f.hint}>
          Interest per draw{' '}
          <input
            className={`${f.box} ${f.boxOpen}`} style={{ width: 64 }} inputMode="decimal" aria-label={`${facility.code} interest per draw`} readOnly={!canWrite}
            value={rateText} placeholder={pctOf(facility.defaultRateBp)}
            onChange={(e) => { setRateText(e.target.value); const v = readRate(e.target.value); if (v !== undefined) onPlan({ ...plan, rateBp: v }); }}
          />{' '}%
        </label>
        <span className={f.hint}>Owed today RM {fmtSenPlain(facility.owedNowSen)}</span>
      </div>
      {bad && <p role="alert" className={f.alert}>The tenor is whole days, 1 to 400; the interest per draw 0% to 100%. Leave either blank for the default.</p>}
      <div className={f.card}>
        <div className={f.scroll}>
          <table className={f.table} aria-label={`${facility.code} trade finance by month`}>
            <thead>
              <tr>
                <th className={`${f.name} ${f.nameHead}`}>Supplier the facility pays</th>
                {data.shown.map((ym) => <th key={ym} className={f.th}>{monthName(`${ym}-01`)}</th>)}
              </tr>
            </thead>
            <tbody>
              {plan.suppliers.length === 0 && (
                <tr className={f.row}><td className={f.name} colSpan={1 + data.shown.length}>No supplier yet: add the ones this facility pays.</td></tr>
              )}
              {plan.suppliers.map((id) => (
                <tr key={id} className={f.row} data-row={`sup:${id}`}>
                  <td className={f.name}>
                    {nameOf(id)}
                    <span className={f.hint}> · {supplier.get(id)?.term ?? 'no term'}</span>
                    {canWrite && (
                      <button
                        type="button" className={f.toggle} style={{ marginLeft: 10 }}
                        onClick={() => onPlan({ ...plan, suppliers: plan.suppliers.filter((x) => x !== id), off: Object.fromEntries(Object.entries(plan.off).map(([ym, list]) => [ym, list.filter((x) => x !== id)]).filter(([, list]) => list.length > 0)) })}
                      >Remove</button>
                    )}
                  </td>
                  {data.shown.map((ym) => {
                    const due = dueOf(facility.dues, id, ym);
                    const sen = due ? due.billSen + due.forecastSen : 0;
                    if (!due || sen <= 0) return <td key={ym} className={f.cell} />;
                    const on = isTicked(plan.off, ym, id);
                    const kind = due.billSen >= due.forecastSen ? f.dueBill : f.dueForecast;
                    return (
                      <td key={ym} className={`${f.cell} ${kind} ${on ? '' : f.dueOff}`}>
                        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: canWrite ? 'pointer' : 'default' }}>
                          <input
                            type="checkbox" checked={on} disabled={!canWrite} aria-label={`${nameOf(id)} ${ym} drawn`}
                            onChange={() => onPlan({ ...plan, off: toggleTick(plan.off, ym, id) })}
                          />
                          {fmtSenPlain(sen)}
                        </label>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {sumRow('Drawdown', (m) => m.drawSen, true)}
              {sumRow('Repayment', (m) => m.repaySen)}
              {sumRow('Interest', (m) => m.interestSen)}
              {sumRow('Owed at month end', (m) => m.owedSen, true)}
            </tbody>
          </table>
        </div>
      </div>
      {canWrite && others.length > 0 && (
        <label className={f.hint}>
          Add a supplier{' '}
          <select
            className={f.select} aria-label={`${facility.code} add a supplier`} value=""
            onChange={(e) => { if (e.target.value) onPlan({ ...plan, suppliers: [...plan.suppliers, e.target.value] }); }}
          >
            <option value="">Choose…</option>
            {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
    </section>
  );
}

export function TradeFinanceDialog({ onClose, canWrite }: { onClose: () => void; canWrite: boolean }) {
  const q = useTradeFinance(true);
  const save = useSaveTradeFinance();
  const toast = useToastOptional();
  const [plans, setPlans] = useState<TfPlans | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (q.data && plans === null) setPlans(planOf(q.data)); }, [q.data, plans]);
  const dirty = q.data != null && plans != null && JSON.stringify(plans) !== JSON.stringify(planOf(q.data));

  const doSave = async () => {
    if (!plans) return;
    setError(null);
    try {
      await save.mutateAsync(plans);
      toast?.success('Trade finance saved · the forecast draws and repays as planned');
      onClose();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <Modal title="Trade finance" onClose={onClose} ariaLabel="Trade finance" width="min(1480px, 100%)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div className={f.note} style={{ padding: 0, borderTop: 0 }}>
          Each draw is repaid a tenor after it with its interest, on the facility and the interest account as the repayment vouchers book them; what is owed today is repaid the same way, a past-due draw this month.
          The facility pays the suppliers you add here: each one&apos;s dues — a bill the books owe it (blue) or its Forecast P&amp;L figure from this month on (beige) — are drawn in their month; untick one the facility will not pay.
          No limit. Forecast only — nothing posts.
        </div>
        {q.isError && <p role="alert" className={f.alert}>The plan did not load. Close it and try again.</p>}
        {!q.data && !q.isError && <p className={f.empty}>Loading…</p>}
        {q.data && plans && (q.data.facilities.length === 0
          ? <p className={f.empty}>No trade-finance account: the chart has no liability account named TRADE FINANCE.</p>
          : q.data.facilities.map((x) => {
            const plan = (plans as Partial<TfPlans>)[x.code];
            return plan ? <FacilityTable key={x.code} data={q.data!} facility={x} plan={plan} canWrite={canWrite} onPlan={(p) => setPlans((all) => (all ? { ...all, [x.code]: p } : all))} /> : null;
          }))}
        {error && <p role="alert" className={f.alert}>{error}</p>}
        {!canWrite && q.data && <p className={f.hint}>You can read this plan; changing it needs the payment vouchers&apos; write permission.</p>}
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
          {dirty && <span className={f.unsaved}>Unsaved changes</span>}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => void doSave()} disabled={!canWrite || !dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
