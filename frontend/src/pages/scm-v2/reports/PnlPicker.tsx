// ----------------------------------------------------------------------------
// PnlPicker — the P&Ls as one report (owner 2026-11-25: 几份P&L, 可以combine 起来
// 然后 类似这样我在这里选), in his three categories: across the top of each P&L, in
// a white bar of its own, the segmented tracks the Department P&L picks its
// department with — the category, Actual (by sales invoice) | Performance (by
// sales order) | Forecast, then Overall | Department (reports-catalog
// PNL_CHOICES). Only the choices the reader may open are offered; a category
// with one part shows no second track.
//
// A choice is that report's own address — so a link to it, old or new, lands on
// it — carrying the range in use, so the dates follow the reader. A category
// opens the part the reader is on where it has one, else its Overall; between
// the two Department P&Ls the page's own settings (its department, its view)
// come along. On a phone the tracks scroll sideways, the open choice kept in
// view. The report shell draws it, so no P&L page carries it.
// ----------------------------------------------------------------------------

import { useLayoutEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  PNL_CATEGORIES, PNL_PARTS, reportById, reportHref, type PnlCategory, type PnlChoice, type ReportRange,
} from '../reports-catalog';
import { ReportTool } from './reportParts';
import s from './ReportShell.module.css';

/** What each choice reads, said on hover. */
const CATEGORY_TITLE: Record<PnlCategory, string> = {
  actual: 'Actual: by sales invoice, the books',
  performance: 'Performance: by sales order (SO date), the expenses as booked',
  forecast: 'Forecast: the targets per account',
};
const PART_TITLE = {
  overall: 'The company as a whole',
  department: 'Each department by its own P&L: Exhibition, Operation, Logistics, G&A',
} as const;

/** The address bits the Department P&L keeps for itself, carried between its two bases. */
const NOT_CARRIED = new Set(['tab', 'dbasis', 'from', 'to']);

export function PnlPicker({ current, choices, range }: {
  /** The choice this page is. */
  current: PnlChoice;
  /** The choices the reader may open, in the picker's order. */
  choices: readonly PnlChoice[];
  /** The range the choices carry; null opens each on its own dates. */
  range: ReportRange | null;
}) {
  const [params] = useSearchParams();
  const nav = useRef<HTMLElement>(null);

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
  const categories = PNL_CATEGORIES.filter((k) => choices.some((c) => c.category === k.id));
  /** A category opens the part the reader is on where it has one, else its first. */
  const openOf = (category: PnlCategory): PnlChoice =>
    choices.find((c) => c.category === category && c.part === current.part) ?? choices.find((c) => c.category === category)!;
  const parts = PNL_PARTS
    .map((p) => ({ ...p, choice: choices.find((c) => c.category === current.category && c.part === p.id) }))
    .filter((p): p is typeof p & { choice: PnlChoice } => p.choice != null);

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
    <nav ref={nav} className={s.toolbar} aria-label="Choose a P&L">
      <ReportTool label="P&L">
        <div className={s.segs} role="group" aria-label="P&L category" data-track>
          {categories.map((k) => {
            const on = k.id === current.category;
            return (
              <Link key={k.id} to={hrefOf(openOf(k.id))} className={`${s.seg} ${on ? s.segOn : ''}`} title={CATEGORY_TITLE[k.id]}
                aria-current={on ? 'page' : undefined}>
                {k.label}
              </Link>
            );
          })}
        </div>
      </ReportTool>
      {parts.length > 1 && (
        <div className={s.segs} role="group" aria-label="Overall or by department" data-track>
          {parts.map((p) => {
            const on = p.id === current.part;
            return (
              <Link key={p.id} to={hrefOf(p.choice)} className={`${s.seg} ${on ? s.segOn : ''}`} title={PART_TITLE[p.id]}
                aria-current={on ? 'page' : undefined}>
                {p.label}
              </Link>
            );
          })}
        </div>
      )}
    </nav>
  );
}
