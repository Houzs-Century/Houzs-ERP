// ----------------------------------------------------------------------------
// PnlPicker — a P&L's three views (owner 2026-11-25: 入口可以改成根据overall
// P&L, Department P&L 每个P&L 有三个view): across the top of each view of the
// Overall P&L or the Department P&L, in a white bar of its own, the P&L's name
// and the segmented track the Department P&L picks its department with —
// Actual (by sales invoice) | Performance (by sales order) | Forecast
// (reports-catalog PNL_CHOICES). Only the views the reader may open are offered;
// a view not built yet (the Department P&L's Forecast) stays in its place,
// greyed, saying it comes later.
//
// A view is that report's own address — so a link to it, old or new, lands on
// it — carrying the range in use, so the dates follow the reader; between the
// Department P&L's two views the page's own settings (its department, its view)
// come along. On a phone the track scrolls sideways, the open view kept in view.
// The report shell draws it, so no P&L page carries it.
// ----------------------------------------------------------------------------

import { useLayoutEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  PNL_CHOICES, PNL_FAMILIES, PNL_VIEWS, reportById, reportHref, type PnlChoice, type PnlView, type ReportRange,
} from '../reports-catalog';
import { ReportTool } from './reportParts';
import s from './ReportShell.module.css';

/** What each view reads, said on hover. */
const VIEW_TITLE: Record<PnlView, string> = {
  actual: 'Actual: by sales invoice, the books',
  performance: 'Performance: by sales order (SO date), the expenses as booked',
  forecast: 'Forecast: the targets per account',
};
const LATER = 'Comes later: this P&L’s Forecast is not built yet';

/** The address bits the Department P&L keeps for itself, carried between its two views. */
const NOT_CARRIED = new Set(['tab', 'dbasis', 'from', 'to']);

export function PnlPicker({ current, choices, range }: {
  /** The view this page is. */
  current: PnlChoice;
  /** This P&L's views the reader may open, in the picker's order. */
  choices: readonly PnlChoice[];
  /** The range the views carry; null opens each on its own dates. */
  range: ReportRange | null;
}) {
  const [params] = useSearchParams();
  const nav = useRef<HTMLElement>(null);
  const family = PNL_FAMILIES.find((f) => f.id === current.family)!;

  const hrefOf = (c: PnlChoice): string => {
    const item = reportById(c.report);
    const plain = reportHref(item, range);
    if (c.dbasis == null || !item.tab) return plain;
    const [path, search = ''] = plain.split('?');
    const q = new URLSearchParams({ tab: item.tab, dbasis: c.dbasis });
    if (current.report === c.report) for (const [k, v] of params) if (!NOT_CARRIED.has(k)) q.set(k, v);
    for (const [k, v] of new URLSearchParams(search)) if (k !== 'tab') q.set(k, v);
    return `${path}?${q.toString()}`;
  };
  /* Each view: the reader's where they may open it, greyed where this P&L has none yet. */
  const views = PNL_VIEWS.flatMap((v): Array<{ id: PnlView; label: string; choice: PnlChoice | null }> => {
    const choice = choices.find((c) => c.view === v.id);
    if (choice) return [{ ...v, choice }];
    const built = PNL_CHOICES.some((c) => c.family === current.family && c.view === v.id);
    return built ? [] : [{ ...v, choice: null }];
  });

  useLayoutEffect(() => {
    for (const box of nav.current?.querySelectorAll<HTMLElement>('[data-track]') ?? []) {
      const lit = box.querySelector('[aria-current="page"]');
      if (!lit) continue;
      const b = box.getBoundingClientRect();
      const l = lit.getBoundingClientRect();
      if (l.left < b.left) box.scrollLeft -= b.left - l.left;
      else if (l.right > b.right) box.scrollLeft += l.right - b.right;
    }
  }, [current]);

  return (
    <nav ref={nav} className={s.toolbar} aria-label="P&L views">
      <ReportTool label={family.label}>
        <div className={s.segs} role="group" aria-label="View" data-track>
          {views.map((v) => {
            if (!v.choice) {
              return <span key={v.id} className={`${s.seg} ${s.segOff}`} aria-disabled="true" title={LATER}>{v.label}</span>;
            }
            const on = v.id === current.view;
            return (
              <Link key={v.id} to={hrefOf(v.choice)} className={`${s.seg} ${on ? s.segOn : ''}`} title={VIEW_TITLE[v.id]}
                aria-current={on ? 'page' : undefined}>
                {v.label}
              </Link>
            );
          })}
        </div>
      </ReportTool>
    </nav>
  );
}
