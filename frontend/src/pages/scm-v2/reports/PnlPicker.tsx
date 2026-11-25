// ----------------------------------------------------------------------------
// PnlPicker — the P&Ls as one report (owner 2026-11-25: 几份P&L, 可以combine 起来
// 然后 类似这样我在这里选): across the top of each P&L, in a white bar of its own,
// the segmented track the Department P&L picks its department with, one choice
// per P&L the reader may open, in the catalog's order, by its name there
// (`pnlPick`). A choice is that P&L's own address — so a link to it, old or
// new, lands on it — carrying the range in use, so the dates follow the reader;
// hovering it says what that P&L reads. The report shell draws it, so no P&L
// page carries it. On a phone the choices scroll sideways, the open one kept in
// view.
// ----------------------------------------------------------------------------

import { useLayoutEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { reportHref, type ReportId, type ReportItem, type ReportRange } from '../reports-catalog';
import { REPORT_LOOK } from './reportListLook';
import { ReportTool } from './reportParts';
import s from './ReportShell.module.css';

export function PnlPicker({ current, choices, range }: {
  current: ReportId;
  /** The P&Ls the reader may open, in the picker's order. */
  choices: readonly ReportItem[];
  /** The range the choices carry; null opens each on its own dates. */
  range: ReportRange | null;
}) {
  const track = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = track.current;
    const lit = box?.querySelector('[aria-current="page"]');
    if (!box || !lit) return;
    const b = box.getBoundingClientRect();
    const l = lit.getBoundingClientRect();
    if (l.left < b.left) box.scrollLeft -= b.left - l.left;
    else if (l.right > b.right) box.scrollLeft += l.right - b.right;
  }, [current]);
  return (
    <nav className={s.toolbar} aria-label="Choose a P&L">
      <ReportTool label="P&L">
        <div ref={track} className={s.segs}>
          {choices.map((r) => {
            const on = r.id === current;
            return (
              <Link
                key={r.id}
                to={reportHref(r, range)}
                className={`${s.seg} ${on ? s.segOn : ''}`}
                title={REPORT_LOOK[r.id].desc}
                aria-current={on ? 'page' : undefined}
              >
                {r.pnlPick}
              </Link>
            );
          })}
        </div>
      </ReportTool>
    </nav>
  );
}
