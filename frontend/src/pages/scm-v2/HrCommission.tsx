// ----------------------------------------------------------------------------
// Commission — the payroll report for a date range, grouped by showroom.
//
// Reads GET /api/scm/hr/commission. The MATH is entirely server-side
// (backend/src/scm/shared/hr-commission.ts); this page renders and exports it
// and computes nothing, so the sheet the owner approves and the figure the
// backend froze can never disagree.
//
// It is also where a period is APPROVED. An open period recalculates on every
// load, so editing one rate silently rewrites what every past period pays;
// closing freezes the figures and serves them from the snapshot instead.
// Close and reopen each carry their own backend permission key
// (scm.hr.close / scm.hr.reopen) — deliberately NOT scm.hr.manage, so whoever
// tunes the rates cannot also approve a payroll run against the rates they just
// set. The buttons follow those keys; the server re-checks regardless.
//
// Page shell is Inventory's (PageHeader + space-y-4), not the vendored 2990
// card slab — owner 2026-07-18.
// ----------------------------------------------------------------------------

import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Lock, LockOpen } from 'lucide-react';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { PageHeader } from '../../components/Layout';
import { EmptyState } from '../../components/EmptyState';
import { fmtCenti } from '@2990s/shared';
import { formatDate } from '../../lib/utils';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { usePrompt } from '../../vendor/scm/components/PromptDialog';
import {
  useHrCommission, useHrPayoutPeriods, useCloseHrPayout, useReopenHrPayout,
  type HrCommissionRow,
} from '../../vendor/scm/lib/hr-queries';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

const INPUT_CLASS =
  'rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

/** bps -> a human percent. Display only; the integer bps is never mutated. */
const fmtPct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** First and last day of the current month — the default period. */
const monthRange = () => {
  const now = new Date();
  return {
    from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: isoDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  };
};

export const HrCommission = () => {
  const initial = useMemo(monthRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [applied, setApplied] = useState(initial);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const query = useHrCommission(applied.from, applied.to);
  const data = query.data;

  const periods = useHrPayoutPeriods();
  const closePayout = useCloseHrPayout();
  const reopenPayout = useReopenHrPayout();

  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const notify = useNotify();

  /* Close and reopen are separate backend keys from scm.hr.read/manage, so the
     buttons follow those keys and nothing else. Hiding a control the API would
     refuse is the point: the server is still the authority (it re-checks), this
     only stops the UI from offering an action that cannot succeed. */
  const { can } = useAuth();
  // can() already answers true on the `*` wildcard, so Owner / IT Admin hold
  // both without either key being listed separately.
  const mayClose = can('scm.hr.close');
  const mayReopen = can('scm.hr.reopen');

  const rangeValid = Boolean(from) && Boolean(to) && from <= to;
  const busy = closePayout.isPending || reopenPayout.isPending;

  const onClose = async () => {
    if (!data || data.closed) return;
    const total = data.showrooms.reduce(
      (acc, s) => acc + s.rows.reduce((a, r) => a + r.totalCenti, 0),
      0,
    );
    const people = data.showrooms.reduce((acc, s) => acc + s.rows.length, 0);
    const ok = await askConfirm({
      title: 'Close this commission period?',
      body:
        `${formatDate(data.from)} to ${formatDate(data.to)} — ${people} salespeople, ${fmtCenti(total)} in total.\n\n` +
        'Closing saves these exact figures and stops them recalculating. After this, changing a rate, ' +
        'a tier or an item KPI will not move what this period pays — the saved figures are what the ' +
        'report will show from now on.\n\n' +
        'It can only be undone by reopening the period, which is recorded with your name and a reason.',
      confirmLabel: 'Close period',
      danger: true,
    });
    if (!ok) return;
    try {
      await closePayout.mutateAsync({ from: data.from, to: data.to });
    } catch (e) {
      await notify({ title: 'Could not close the period', body: (e as Error)?.message, tone: 'error' });
    }
  };

  const onReopen = async () => {
    if (!data?.closed) return;
    const ok = await askConfirm({
      title: 'Reopen this closed period?',
      body:
        `${formatDate(data.from)} to ${formatDate(data.to)} was closed at ${fmtCenti(data.closed.totalCenti)}` +
        `${data.closed.closedByName ? ` by ${data.closed.closedByName}` : ''}.\n\n` +
        'Reopening makes it recalculate against the current rates again, so what it pays can change. ' +
        'The figures saved at close are kept and stay readable, and closing it again saves a new revision beside them.',
      confirmLabel: 'Continue',
      danger: true,
    });
    if (!ok) return;
    /* A reason is mandatory server-side AND in the database. Asked for here so
       the refusal never arrives as a validation error after the fact. */
    const reason = await askPrompt({
      title: 'Why is this period being reopened?',
      body: 'This is kept with the period permanently, next to your name.',
      placeholder: 'e.g. SO-2607-018 was missed',
      confirmLabel: 'Reopen period',
      multiline: true,
      validate: (v) => (v.trim().length < 3 ? 'Please give a reason (at least 3 characters).' : null),
    });
    if (reason == null) return;
    try {
      await reopenPayout.mutateAsync({ from: data.from, to: data.to, reason: reason.trim() });
    } catch (e) {
      await notify({ title: 'Could not reopen the period', body: (e as Error)?.message, tone: 'error' });
    }
  };

  const toggle = (staffId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(staffId)) next.delete(staffId);
      else next.add(staffId);
      return next;
    });

  const onExport = async () => {
    if (!data) return;
    const rows: (string | number)[][] = [[
      'Showroom', 'Salesperson', 'Tier', 'Goods (RM)', 'Rate', 'Personal (RM)',
      'Override rate', 'Override (RM)', 'Item KPI (RM)', 'Total (RM)',
    ]];
    for (const s of data.showrooms) {
      for (const r of s.rows) {
        rows.push([
          s.showroomName, r.staffName, r.tier,
          r.personalGoodsCenti / 100,
          fmtPct(r.personalRateBps),
          r.personalCommissionCenti / 100,
          r.overrideRateBps === null ? 'chain' : fmtPct(r.overrideRateBps),
          r.overrideCommissionCenti / 100,
          r.itemKpiCenti / 100,
          r.totalCenti / 100,
        ]);
      }
    }
    const XLSX = await import('../../lib/xlsx-runtime');
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = rows[0].map((_, i) => {
      let w = 10;
      for (const row of rows) w = Math.max(w, String(row[i] ?? '').length);
      return { wch: Math.min(40, w + 2) };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Commission');
    XLSX.writeFileXLSX(wb, `Commission ${applied.from} to ${applied.to}.xlsx`);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="HR"
        title="Commission"
        primaryAction={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={<Download {...ICON} />}
              onClick={onExport}
              disabled={!data || data.showrooms.length === 0}
            >
              Export Excel
            </Button>
            {data && !data.closed && mayClose && (
              <Button
                variant="primary"
                icon={<Lock {...ICON} />}
                onClick={onClose}
                // Closing an empty period would freeze "nobody earned anything"
                // as an approved payroll run. Nothing to approve, so no button.
                disabled={busy || data.showrooms.length === 0}
              >
                {closePayout.isPending ? 'Closing…' : 'Close period'}
              </Button>
            )}
            {data?.closed && mayReopen && (
              <Button
                variant="secondary"
                icon={<LockOpen {...ICON} />}
                onClick={onReopen}
                disabled={busy}
              >
                {reopenPayout.isPending ? 'Reopening…' : 'Reopen period'}
              </Button>
            )}
          </div>
        }
      />

      {/* The period picker is its own row, not a PageHeader action: the header
          rail centres its children, which would float these labelled fields off
          the buttons' baseline. */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">From</span>
          <input type="date" className={INPUT_CLASS} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">To</span>
          <input type="date" className={INPUT_CLASS} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <Button
          variant="primary"
          disabled={!rangeValid}
          onClick={() => rangeValid && setApplied({ from, to })}
        >
          Calculate
        </Button>
      </div>

      {!rangeValid && (
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-secondary">
          The From date must not be after the To date.
        </div>
      )}

      {query.isLoading && (
        <div className="rounded-md border border-border bg-surface px-3 py-6 text-center text-[13px] text-ink-secondary">
          Calculating…
        </div>
      )}

      {query.isError && (
        <div className="rounded-md border border-err/40 bg-err/5 px-3 py-3 text-[13px] text-ink">
          {(query.error as Error)?.message || 'The commission report could not be loaded.'}
        </div>
      )}

      {data && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-secondary">
          <span>
            {formatDate(data.from)} to {formatDate(data.to)}
          </span>
          {data.closed ? (
            /* A closed period is served from frozen rows, so these figures are
               the ones that were approved — not a fresh recompute against
               today's rates. Saying so is the whole point of freezing them. */
            <Badge tone="success" variant="soft" caseless>
              <span className="inline-flex items-center gap-1">
                <Lock size={11} strokeWidth={2} />
                Closed rev {data.closed.revision}
                {data.closed.closedByName ? ` by ${data.closed.closedByName}` : ''}
                {data.closed.closedAt ? ` on ${formatDate(data.closed.closedAt)}` : ''}
              </span>
            </Badge>
          ) : (
            <Badge tone="neutral" variant="soft" caseless>
              Open period — recalculated live
            </Badge>
          )}
          {data.overrideMode === 'chain' && (
            /* The ladder these figures were actually computed against — the
               SNAPSHOT on a closed period, today's on an open one. Without it a
               chain override is an amount with nothing on the page that
               explains it, and on a closed period the live HR Settings ladder
               may no longer be the one that produced it. */
            <Badge tone="accent" variant="soft" caseless>
              {data.overrideLevels.length > 0
                ? `Chain override · ${data.overrideLevels.map((l) => `L${l.level} ${fmtPct(l.rateBps)}`).join(' · ')}`
                : 'Chain override · no levels configured'}
            </Badge>
          )}
        </div>
      )}

      {/* The reopen fields are NOT rendered here on purpose. /commission serves
          only status='CLOSED' rows, and a reopen flips the row to 'REOPENED' and
          leaves a fresh row behind on the next close — so closed.reopened* is
          always null in this response. Those fields belong to the history table
          below, which is the read that actually returns REOPENED rows. */}

      {data && data.showrooms.length === 0 && (
        <EmptyState
          message="No salespeople configured"
          description="Nobody has a commission profile in this company yet. Add them in HR Settings."
        />
      )}

      {data && data.showrooms.map((s) => (
        <section key={s.showroomId} className="space-y-2">
          <header className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[14px] font-semibold text-ink">{s.showroomName}</h2>
            <Badge tone={s.showroomKpiHit ? 'success' : 'warning'} variant="soft" caseless>
              Showroom goods {fmtCenti(s.showroomGoodsCenti)} ·{' '}
              {fmtCenti(data.config.showroomKpiThresholdCenti)} target{' '}
              {s.showroomKpiHit ? 'hit' : 'not hit'}
            </Badge>
          </header>

          <div className="overflow-x-auto rounded-md border border-border bg-surface">
            <table className="w-full text-[12px]">
              <thead className="border-b-2 border-border bg-surface-dim text-[10px] font-bold uppercase tracking-brand text-ink">
                <tr>
                  <th className="px-3 py-2 text-left">Salesperson</th>
                  <th className="px-2 py-2 text-left">Tier</th>
                  <th className="px-2 py-2 text-right">Goods</th>
                  <th className="px-2 py-2 text-right">Rate</th>
                  <th className="px-2 py-2 text-right">Personal</th>
                  <th className="px-2 py-2 text-right">Override</th>
                  <th className="px-2 py-2 text-right">Item KPI</th>
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r) => (
                  <CommissionRow
                    key={r.staffId}
                    row={r}
                    open={expanded.has(r.staffId)}
                    onToggle={() => toggle(r.staffId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {/* Payout history — every close and every reopen, newest first. This is
          the audit answer to "what did we approve, when, and who moved it".
          Clicking a row loads that period into the report above. */}
      <section className="space-y-2">
        <h2 className="text-[14px] font-semibold text-ink">Payout history</h2>

        {periods.isError && (
          <div className="rounded-md border border-err/40 bg-err/5 px-3 py-3 text-[13px] text-ink">
            {(periods.error as Error)?.message || 'The payout history could not be loaded.'}
          </div>
        )}

        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full text-[12px]">
            <thead className="border-b-2 border-border bg-surface-dim text-[10px] font-bold uppercase tracking-brand text-ink">
              <tr>
                <th className="px-3 py-2 text-left">Period</th>
                <th className="px-2 py-2 text-right">Rev</th>
                <th className="px-2 py-2 text-left">Status</th>
                <th className="px-2 py-2 text-right">People</th>
                <th className="px-2 py-2 text-right">Total</th>
                <th className="px-2 py-2 text-left">Closed by</th>
                <th className="px-3 py-2 text-left">Reopened</th>
              </tr>
            </thead>
            <tbody>
              {(periods.data ?? []).map((p) => (
                <tr
                  key={p.id}
                  className="cursor-pointer border-t border-border-subtle hover:bg-primary-soft/40"
                  onClick={() => {
                    setFrom(p.from);
                    setTo(p.to);
                    setApplied({ from: p.from, to: p.to });
                  }}
                >
                  <td className="px-3 py-2 text-ink">
                    {formatDate(p.from)} – {formatDate(p.to)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-ink-secondary">{p.revision}</td>
                  <td className="px-2 py-2">
                    <Badge tone={p.status === 'CLOSED' ? 'success' : 'warning'} variant="soft" caseless>
                      {p.status === 'CLOSED' ? 'Closed' : 'Reopened'}
                    </Badge>
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-ink-secondary">{p.rowCount}</td>
                  <td className="px-2 py-2 text-right font-mono">{fmtCenti(p.totalCenti)}</td>
                  <td className="px-2 py-2 text-ink-secondary">
                    {p.closedByName || '—'}
                    {p.closedAt ? ` · ${formatDate(p.closedAt)}` : ''}
                  </td>
                  <td className="px-3 py-2 text-ink-secondary">
                    {p.reopenedAt
                      ? `${p.reopenedByName || 'unknown'} · ${formatDate(p.reopenedAt)}${p.reopenReason ? ` — ${p.reopenReason}` : ''}`
                      : '—'}
                  </td>
                </tr>
              ))}
              {(periods.data ?? []).length === 0 && !periods.isLoading && !periods.isError && (
                <tr className="border-t border-border-subtle">
                  <td colSpan={7} className="px-3 py-4 text-center text-[12px] text-ink-secondary">
                    No period has been closed yet. Every range still recalculates live.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

const CommissionRow = ({
  row,
  open,
  onToggle,
}: {
  row: HrCommissionRow;
  open: boolean;
  onToggle: () => void;
}) => {
  const overrideLevels = row.overrideDetail ?? [];
  const expandable = row.kpiDetail.length > 0 || overrideLevels.length > 0;

  return (
    <Fragment>
      <tr className="border-t border-border-subtle">
        <td className="px-3 py-2">
          <span className="inline-flex items-center gap-1">
            {expandable && (
              <button
                type="button"
                onClick={onToggle}
                aria-label={open ? 'Hide breakdown' : 'Show breakdown'}
                className="rounded p-0.5 text-ink-muted hover:bg-primary-soft hover:text-primary"
              >
                {open ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
              </button>
            )}
            <span className="font-semibold text-ink">{row.staffName}</span>
          </span>
        </td>
        <td className="px-2 py-2 text-ink-secondary">{row.tier}</td>
        <td className="px-2 py-2 text-right font-mono">{fmtCenti(row.personalGoodsCenti)}</td>
        <td className="px-2 py-2 text-right font-mono">{fmtPct(row.personalRateBps)}</td>
        <td className="px-2 py-2 text-right font-mono">{fmtCenti(row.personalCommissionCenti)}</td>
        <td className="px-2 py-2 text-right font-mono">
          {/* null rate = chain mode, where the override is a sum over levels of
              different rates on different bases. Printing a blended rate would
              be a figure nobody can reconcile against a payslip, so the amount
              stands alone and the per-level split lives in the expansion. */}
          {row.overrideRateBps === null
            ? overrideLevels.length === 0 && row.overrideCommissionCenti === 0
              ? '—'
              : fmtCenti(row.overrideCommissionCenti)
            : row.overrideRateBps === 0
              ? '—'
              : `${fmtPct(row.overrideRateBps)} · ${fmtCenti(row.overrideCommissionCenti)}`}
        </td>
        <td className="px-2 py-2 text-right font-mono">{fmtCenti(row.itemKpiCenti)}</td>
        <td className="px-3 py-2 text-right font-mono font-semibold text-ink">{fmtCenti(row.totalCenti)}</td>
      </tr>

      {open &&
        overrideLevels.map((d) => (
          <tr key={`${row.staffId}-lvl${d.level}`} className="border-t border-border-subtle bg-bg/30 text-[11px]">
            <td className="px-3 py-1.5 pl-9 text-ink-secondary" colSpan={5}>
              Level {d.level} downline goods {fmtCenti(d.goodsCenti)} @ {fmtPct(d.rateBps)}
            </td>
            <td className="px-2 py-1.5 text-right font-mono text-ink-secondary" colSpan={3}>
              {fmtCenti(d.commissionCenti)}
            </td>
          </tr>
        ))}

      {open &&
        row.kpiDetail.map((d, i) => (
          <tr key={`${row.staffId}-kpi${i}`} className="border-t border-border-subtle bg-bg/30 text-[11px]">
            <td className="px-3 py-1.5 pl-9 text-ink-secondary" colSpan={5}>
              {d.label} × {d.qty} @ {fmtCenti(d.bonusCenti)}
            </td>
            <td className="px-2 py-1.5 text-right font-mono text-ink-secondary" colSpan={3}>
              {fmtCenti(d.lineCenti)}
            </td>
          </tr>
        ))}
    </Fragment>
  );
};
