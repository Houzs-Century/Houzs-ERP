// ----------------------------------------------------------------------------
// ReportShell — the frame every Finance report sits in (the owner's Claude
// Design, batch 6 §4.3): the report list on the left (ReportRail), the header
// — "Finance · Reports" over the report's name, its one grey line under it, its
// actions at the right (Layout · Excel · PDF · Print) — and the report below.
//
// A report adopts the frame from inside, with reportParts (header buttons, the
// grey line, the toolbar card, the exports); one that adopts nothing renders as
// it did, under the header.
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../../components/Layout';
import { todayMyt } from '../../../vendor/scm/lib/dates';
import { reportById, type ReportId } from '../reports-catalog';
import { ReportRail, useRailPinned, useVisibleReports } from './ReportRail';
import { ShellContext, type ShellSlots } from './reportParts';
import { isUsableRange, resolveReportRange } from './useReportRange';
import tokens from '../finance/finance-ui.module.css';
import s from './ReportShell.module.css';

export function ReportShell({ report, subtitle, actions, ownHeader = false, children }: {
  report: ReportId;
  /** The grey line under the title, when the page knows it up front. */
  subtitle?: string;
  /** Header buttons the page has up front; a report adds its own with <ReportHeaderActions>. */
  actions?: ReactNode;
  /** The report draws its own "Finance · Reports" header: the shell adds the list only. */
  ownHeader?: boolean;
  children: ReactNode;
}) {
  const item = reportById(report);
  const reports = useVisibleReports();
  const [pinned, setPinned] = useRailPinned();
  const [params] = useSearchParams();
  /* The range the list's links carry: one the reader picked (in the address or
     earlier in this tab) — never the bare default, which each report applies
     for itself. */
  const range = resolveReportRange(params, todayMyt());
  const carried = range.source !== 'default' && isUsableRange(range) ? { from: range.from, to: range.to } : null;
  const [actionsHost, setActionsHost] = useState<HTMLElement | null>(null);
  const [ownSubtitle, setSubtitle] = useState<string | null>(null);
  /* A part standing in for the report (the Layout editor) draws here, and the
     report with its header buttons steps aside until it closes. */
  const [inPlaceHost, setInPlaceHost] = useState<HTMLElement | null>(null);
  const [inPlace, setInPlace] = useState(false);
  const slots = useMemo<ShellSlots>(() => ({ actionsHost, setSubtitle, inPlaceHost, setInPlace }), [actionsHost, inPlaceHost]);
  /* A reader who may open one report only has no list to choose from. */
  const showRail = reports.length > 1;

  return (
    <div className={`${tokens.root} ${s.shell} ${!showRail ? s.shellBare : pinned ? s.shellPinned : ''}`} data-report={report}>
      {showRail && (
        <ReportRail current={report} reports={reports} range={carried} pinned={pinned} onPinned={setPinned} />
      )}
      <div className={s.main}>
        {ownHeader ? children : (
          <>
            <PageHeader
              eyebrow="Finance · Reports"
              title={item.title ?? item.label}
              description={ownSubtitle ?? subtitle}
              actions={(
                <div className={`${s.actions} ${inPlace ? s.asideNow : ''}`}>
                  {actions}
                  <span ref={setActionsHost} className={s.actionsSlot} />
                </div>
              )}
            />
            <div ref={setInPlaceHost} className={s.inPlace} />
            <div className={inPlace ? s.asideNow : s.inPlace} data-report-body>
              <ShellContext.Provider value={slots}>{children}</ShellContext.Provider>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
