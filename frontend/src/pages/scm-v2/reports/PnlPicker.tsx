// ----------------------------------------------------------------------------
// PnlPicker — a P&L's views (owner 2026-11-25: 入口可以改成根据overall P&L,
// Department P&L 每个P&L 有三个view): across the top of each view of the
// Overall P&L or the Department P&L, in a white bar of its own, the P&L's name
// and its views (reports-catalog PNL_FAMILY_VIEWS, PNL_CHOICES) — the Overall
// P&L's Actual (by sales invoice) | Forecast (its Performance removed, owner
// 2026-11-28), the Department P&L's Actual | Performance (by sales order) |
// Forecast. Only the views the reader may open
// are offered; a view not built yet (the Department P&L's Forecast) stays in
// its place, greyed, saying it comes later.
//
// The Overall P&L's views turn on and off (the same day: 这个view 我可以select
// 我要看什么view，也可以同时显示两个还是三个): one on is that view's own page,
// both on are the side-by-side table (PNL_SIDE_BY_SIDE); the last one
// on stays on. The Department P&L's are picked one at a time.
//
// A view is that report's own address — so a link to it, old or new, lands on
// it — carrying the range in use, so the dates follow the reader; between the
// Department P&L's two views the page's own settings (its department, its view)
// come along, and on the side-by-side table its By month. On a phone the track scrolls sideways, the open view kept in view.
// The report shell draws it, so no P&L page carries it.
// ----------------------------------------------------------------------------

import { useLayoutEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import {
  PNL_BY_MONTH, PNL_CHOICES, PNL_FAMILIES, PNL_FAMILY_VIEWS, PNL_SIDE_BY_SIDE, PNL_VIEWS, reportById, reportHref,
  type PnlChoice, type PnlFamily, type PnlView, type ReportRange,
} from '../reports-catalog';
import { ReportTool } from './reportParts';
import s from './ReportShell.module.css';

const VIEW_TITLE: Record<PnlView, string> = {
  actual: 'Actual: by sales invoice, the books',
  performance: 'Performance: by sales order (SO date), the expenses as booked',
  forecast: 'Forecast: the targets per account',
};
const LATER = 'Comes later: this P&L’s Forecast is not built yet';

const NOT_CARRIED = new Set(['tab', 'dbasis', 'from', 'to']);

export function PnlPicker({ family, current, selected, choices, range }: {
  family: PnlFamily;
  current: PnlChoice | null;
  selected: readonly PnlView[];
  choices: readonly PnlChoice[];
  range: ReportRange | null;
}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const nav = useRef<HTMLElement>(null);
  const name = PNL_FAMILIES.find((f) => f.id === family)!.label;
  const toggles = family === PNL_SIDE_BY_SIDE.family;

  const hrefOf = (c: PnlChoice): string => {
    const item = reportById(c.report);
    const plain = reportHref(item, range);
    if (c.dbasis == null || !item.tab) return plain;
    const [path, search = ''] = plain.split('?');
    const q = new URLSearchParams({ tab: item.tab, dbasis: c.dbasis });
    if (current?.report === c.report) for (const [k, v] of params) if (!NOT_CARRIED.has(k)) q.set(k, v);
    for (const [k, v] of new URLSearchParams(search)) if (k !== 'tab') q.set(k, v);
    return `${path}?${q.toString()}`;
  };
  const openOf = (next: readonly PnlView[]): string | null => {
    if (next.length === 0) return null;
    if (next.length === 1) {
      const c = choices.find((x) => x.view === next[0]);
      return c ? hrefOf(c) : null;
    }
    const item = reportById(PNL_SIDE_BY_SIDE.report);
    const [path, search = ''] = reportHref(item, range).split('?');
    const q = new URLSearchParams({ tab: item.tab ?? PNL_SIDE_BY_SIDE.report, views: next.join(',') });
    for (const [k, v] of new URLSearchParams(search)) if (k !== 'tab') q.set(k, v);
    const by = current == null ? params.get(PNL_BY_MONTH.param) : null;
    if (by === PNL_BY_MONTH.value) q.set(PNL_BY_MONTH.param, by);
    return `${path}?${q.toString()}`;
  };
  const offered = PNL_FAMILY_VIEWS[family];
  const views = PNL_VIEWS.filter((v) => offered.includes(v.id)).flatMap((v): Array<{ id: PnlView; label: string; choice: PnlChoice | null }> => {
    const choice = choices.find((c) => c.view === v.id);
    if (choice) return [{ ...v, choice }];
    const built = PNL_CHOICES.some((c) => c.family === family && c.view === v.id);
    return built ? [] : [{ ...v, choice: null }];
  });

  const openKey = `${current?.report ?? ''}|${current?.view ?? ''}|${selected.join(',')}`;
  useLayoutEffect(() => {
    for (const box of nav.current?.querySelectorAll<HTMLElement>('[data-track]') ?? []) {
      const lit = box.querySelector('[aria-current="page"], [aria-pressed="true"]');
      if (!lit) continue;
      const b = box.getBoundingClientRect();
      const l = lit.getBoundingClientRect();
      if (l.left < b.left) box.scrollLeft -= b.left - l.left;
      else if (l.right > b.right) box.scrollLeft += l.right - b.right;
    }
  }, [openKey]);

  return (
    <nav ref={nav} className={s.toolbar} aria-label="P&L views">
      <ReportTool label={name}>
        <div className={s.segs} role="group" aria-label="View" data-track>
          {views.map((v) => {
            if (!v.choice) {
              return <span key={v.id} className={`${s.seg} ${s.segOff}`} aria-disabled="true" title={LATER}>{v.label}</span>;
            }
            if (toggles) {
              const on = selected.includes(v.id);
              const next = on ? selected.filter((x) => x !== v.id) : offered.filter((x) => x === v.id || selected.includes(x));
              const to = openOf(next);
              return (
                <button key={v.id} type="button" className={`${s.seg} ${s.segToggle} ${on ? s.segOn : ''}`} aria-pressed={on}
                  title={to ? VIEW_TITLE[v.id] : `${VIEW_TITLE[v.id]} — the one view shown, it stays on`}
                  onClick={() => { if (to) navigate(to); }}>
                  {on && <Check size={12} strokeWidth={2.25} aria-hidden />}
                  {v.label}
                </button>
              );
            }
            const on = v.id === current?.view;
            return (
              <Link key={v.id} to={hrefOf(v.choice)} className={`${s.seg} ${on ? s.segOn : ''}`} title={VIEW_TITLE[v.id]}
                aria-current={on ? 'page' : undefined}>
                {v.label}
              </Link>
            );
          })}
        </div>
      </ReportTool>
      {toggles && <span className={s.pickerHint}>Turn both on to see them side by side.</span>}
    </nav>
  );
}
