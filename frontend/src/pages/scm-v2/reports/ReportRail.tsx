// ----------------------------------------------------------------------------
// ReportRail — "Choose a report" (the owner's Claude Design, batch 6 §4.1): a
// narrow icon strip on the left of every report, one icon per report, the
// groups apart by a thin rule. Pointing at it opens the full list over the
// report (after 90 ms; it closes 200 ms after the pointer leaves); on touch the
// list icon opens it; the pin keeps it open in its own column, remembered on
// this device. The open report is lit; a name's one-line description shows on
// hover. No tabs, no other menu: this is the one way between reports.
//
// The reports are reports-catalog's, filtered by today's sidebar gates — the
// list shows a report exactly where the sidebar shows its entry — and each link
// carries the range in use, so the dates follow the reader. The P&Ls are one
// entry, P&L (owner 2026-11-25), where the first of them sits: it opens the
// first P&L the reader may open and is lit on any; the picker across the top of
// each P&L (PnlPicker) opens the others.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { List, Pin, PinOff, type LucideIcon } from 'lucide-react';
import { useAuth } from '../../../auth/AuthContext';
import { NAV_TABS, type NavTab } from '../../../components/Sidebar';
import { makeNavFilter } from '../../../components/navFilter';
import { REPORT_CATALOG, REPORT_GROUPS, isPnlReport, reportHref, type ReportId, type ReportItem, type ReportRange } from '../reports-catalog';
import { readRailPinned, writeRailPinned } from './reportPrefs';
import { PNL_ENTRY_LOOK, REPORT_LOOK } from './reportListLook';
import s from './ReportShell.module.css';

const OPEN_DELAY_MS = 90;
const CLOSE_DELAY_MS = 200;

/** The reports this reader may open: each one whose sidebar entry the
 *  sidebar's own filter keeps (the gates stay in one place). */
export function useVisibleReports(): readonly ReportItem[] {
  const { user, can, pageAccess } = useAuth();
  return useMemo(() => {
    const filterTab = makeNavFilter({ user, can, pageAccess });
    const shown = new Set<string>();
    const walk = (t: NavTab | null): void => {
      if (!t) return;
      if (t.to) shown.add(t.to);
      t.children?.forEach(walk);
    };
    NAV_TABS.map(filterTab).forEach(walk);
    return REPORT_CATALOG.filter((r) => shown.has(r.navTo));
  }, [user, can, pageAccess]);
}

/** One entry of the list: a report, or the P&Ls as one. */
export type ReportListEntry = {
  /** The report it opens: for the P&Ls, the first the reader may open. */
  item: ReportItem;
  label: string;
  icon: LucideIcon;
  desc: string;
  /** Lit while this report is open — for the P&Ls, while any of them is. */
  isOn: (current: ReportId) => boolean;
};

/** The list's entries for the reports a reader may open, in the catalog's order. */
export function reportListEntries(reports: readonly ReportItem[]): ReportListEntry[] {
  const firstPnl = reports.find((r) => isPnlReport(r.id));
  return reports.flatMap((r): ReportListEntry[] => {
    if (!isPnlReport(r.id)) {
      return [{ item: r, label: r.label, ...REPORT_LOOK[r.id], isOn: (current) => current === r.id }];
    }
    return r === firstPnl ? [{ item: r, ...PNL_ENTRY_LOOK, isOn: isPnlReport }] : [];
  });
}

export function ReportRail({ current, entries, range, pinned, onPinned }: {
  current: ReportId;
  entries: readonly ReportListEntry[];
  /** The range the links carry; null opens each report on its own dates. */
  range: ReportRange | null;
  pinned: boolean;
  onPinned: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const clear = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  };
  useEffect(() => clear, []);
  /* Esc, or a tap anywhere else, closes the list opened by hand. */
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  /* Pointing opens it, a touch does not: a tap on the list icon does. */
  const onEnter = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse' || pinned) return;
    window.clearTimeout(closeTimer.current);
    if (open) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };
  const onLeave = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    window.clearTimeout(openTimer.current);
    if (!open) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const picked = () => { clear(); setOpen(false); };
  const togglePin = () => { clear(); setOpen(false); onPinned(!pinned); };

  const groups = REPORT_GROUPS
    .map((g) => ({ ...g, items: entries.filter((e) => e.item.group === g.id) }))
    .filter((g) => g.items.length > 0);

  return (
    <nav
      ref={navRef}
      aria-label="Reports"
      className={`${s.rail} ${open ? s.railOpen : ''} ${pinned ? s.railPinned : ''}`}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <div className={s.strip}>
        <button
          type="button"
          className={s.stripToggle}
          title="Reports · point here to open the list"
          aria-label="Choose a report"
          aria-expanded={open}
          onClick={() => { clear(); setOpen((v) => !v); }}
        >
          <List size={15} strokeWidth={1.75} aria-hidden />
        </button>
        {groups.map((g) => (
          <div key={g.id} className={s.stripGroup}>
            <span className={s.stripRule} aria-hidden />
            {g.items.map((e) => {
              const Icon = e.icon;
              const on = e.isOn(current);
              return (
                <Link
                  key={e.item.id}
                  to={reportHref(e.item, range)}
                  className={`${s.stripItem} ${on ? s.stripItemOn : ''}`}
                  title={e.label}
                  aria-label={e.label}
                  aria-current={on ? 'page' : undefined}
                  onClick={picked}
                >
                  <Icon size={14} strokeWidth={1.75} aria-hidden />
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div className={s.list}>
        <div className={s.listHead}>
          <span className={s.listTitle}>Choose a report</span>
          <button
            type="button"
            className={`${s.pin} ${pinned ? s.pinOn : ''}`}
            title={pinned ? 'Unpin the list' : 'Keep the list open'}
            aria-label={pinned ? 'Unpin the list' : 'Keep the list open'}
            aria-pressed={pinned}
            onClick={togglePin}
          >
            {pinned ? <PinOff size={13} strokeWidth={1.75} aria-hidden /> : <Pin size={13} strokeWidth={1.75} aria-hidden />}
          </button>
        </div>
        {groups.map((g) => (
          <div key={g.id} role="group" aria-label={g.label}>
            <div className={s.groupLabel}>{g.label}</div>
            {g.items.map((e) => {
              const Icon = e.icon;
              const on = e.isOn(current);
              return (
                <Link
                  key={e.item.id}
                  to={reportHref(e.item, range)}
                  className={`${s.item} ${on ? s.itemOn : ''}`}
                  title={e.desc}
                  aria-current={on ? 'page' : undefined}
                  onClick={picked}
                >
                  <Icon size={13} strokeWidth={1.75} aria-hidden className={s.itemIcon} />
                  <span className={s.itemLabel}>{e.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

/** The pin, remembered on this device. */
export function useRailPinned(): [boolean, (on: boolean) => void] {
  const [pinned, setPinned] = useState(readRailPinned);
  return [pinned, (on: boolean) => { writeRailPinned(on); setPinned(on); }];
}
