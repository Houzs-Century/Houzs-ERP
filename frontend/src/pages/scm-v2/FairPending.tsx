/* Orders with no FAIR link that a person should look at.
 *
 * Owner 2026-09-13. The picker records which exhibition a sale was written at,
 * and three things can stop it resolving. They are different problems for
 * different people, so this screen keeps them apart instead of showing one
 * undifferentiated "unlinked" pile:
 *
 *   WAITING FOR THE FAIR   the event is not in PMS yet. Nobody needs to do
 *                          anything — the nightly pass links it once it exists.
 *                          23% of fairs arrive within a week of opening and 13
 *                          of 114 only after they had started (Jun-Sep 2026).
 *   PICK ONE               two brand booths fit and the order cannot say which.
 *                          Only a person knows. This is the row that needs work.
 *   BRAND HAS NO BOOTH     the order sells a brand that is not at that event.
 *                          Usually a SKU with no brand on it rather than a wrong
 *                          venue — "Fair data gaps (read-only)" lists those.
 *   MARKED NO FAIR         the salesperson ticked No fair. Listed so a person can
 *                          check it really was not a fair sale (owner 2026-10-19:
 *                          「总之没有 assign 到 fair 的就列出来就对了」).
 *   KEYED BEFORE THE PICKER  no verdict at all — orders from 1 September 2026
 *                          (when Houzs opened its books in the ERP) keyed before
 *                          the picker went live, never linked.
 *
 * Which orders, exactly, is the server's (scm/lib/fair-pending.ts); the sidebar
 * entry's red number counts the same list.
 *
 * Two groups of LINKED orders sit above them (owner 2026-10-19,
 * scm/lib/fair-checks.ts), each row with the server's own sentence:
 *
 *   TO CHECK — VENUE DIFFERS   要查: the venue on the order is not where it was
 *                              placed. Re-link it to the fair at its venue here.
 *   WAITING FOR SALES ATTENDING 等加人: the person who scanned it is not on that
 *                              booth's Sales Attending. PMS adds them in the
 *                              project; a draft cannot be confirmed until then.
 *
 * ONE TABLE SHAPE FOR EVERY GROUP (owner 2026-10-20: 「很乱不整齐，然我要 link
 * fair 时无法知道 brand」): SO No. | SO date | Venue | Brand | Amount | Fair |
 * Link, fixed columns so the groups line up under each other. Each choice is ONE
 * BOOTH and says whose — BRAND — VENUE — ORGANIZER (dates), the venue kept
 * (「地点照样要显示」) — with the order's own brand first. The order's-brand
 * booth nearest its date is filled in (「可以」), and nothing is linked until a
 * person presses Link. The SO number opens the order in its own tab (「这里可以
 * 直接点开 so 看那张 so」).
 *
 * There is no bulk "link them all" action, deliberately: every button here
 * writes an attribution into exhibition P&L and somebody's commission, and a
 * bulk action over rows nobody read is how a wrong one gets in.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@2990s/design-system';
import { useAuth } from '../../auth/AuthContext';
import { canCreateEvent } from '../../auth/salesAccess';
import { markWorkspaceOpenIntent } from '../../lib/workspaceTabs';
import { fmtDateOrDash } from '../../vendor/shared/format';
import {
  useFairChecks,
  useFairPending,
  useAssignFair,
  useFairOptions,
  fairLabel,
  type FairCheckRow,
  type FairOption,
  type FairPendingRow,
} from '../../vendor/scm/lib/fair-options-queries';

/** The group of an order with no verdict at all (fair_match NULL). */
const NO_VERDICT = 'NO_VERDICT';
/** The server sends at most this many, newest first. */
const LIST_LIMIT = 500;

const GROUPS = [
  { key: 'AMBIGUOUS', title: 'Pick one', hint: 'Two booths fit this order. Choose the fair it belongs to.' },
  { key: 'UNMATCHED', title: 'Brand has no booth', hint: 'The order sells a brand that is not at that event. Check the SKU brand first.' },
  { key: 'PENDING', title: 'Waiting for the fair', hint: 'The event is not in the system yet. It links itself once it is.' },
  { key: 'NO_FAIR', title: 'Marked No fair', hint: 'The salesperson ticked No fair. Check it really was not a fair sale.' },
  { key: NO_VERDICT, title: 'Keyed before the fair picker', hint: 'Orders from 1 September keyed before the fair picker went live on 13 September, never linked to a fair.' },
] as const;

/* The LINKED orders to look at, above the unlinked ones (owner 2026-10-19). */
const CHECK_GROUPS = [
  { key: 'VENUE_DIFFERS', title: 'To check — venue differs', hint: 'The venue on the order is not where it was placed. Re-link it to the fair at its venue, or leave it if the link is right.' },
  { key: 'NEEDS_ATTENDING', title: 'Waiting for Sales Attending', hint: 'The person who scanned the order is not on that booth’s Sales Attending. PMS adds them in the project; a draft cannot be confirmed until then.' },
] as const;

const soft: CSSProperties = { color: 'var(--fg-muted)' };
const card: CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, overflowX: 'auto' };
const th: CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'left' };
const td: CSSProperties = { padding: '8px 10px', verticalAlign: 'middle', borderTop: '1px solid var(--border-weak, #e3e1da)', overflowWrap: 'anywhere' };
const num: CSSProperties = { ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const noteCell: CSSProperties = { padding: '0 10px 8px', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const select: CSSProperties = { width: '100%', fontSize: 'var(--fs-13)', padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border-weak, #e3e1da)', background: 'var(--c-paper, #fff)' };

/* The same column widths in every group, so the tables line up. */
const COLUMNS: Array<number | string | undefined> = [150, 100, '20%', 120, 130, undefined, 84];
const COLS = COLUMNS.length;

function money(sen: number | null): string {
  if (sen == null) return '—';
  return `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Case/space-insensitive, as every venue and brand compare on the server. */
const norm = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dayNo = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;

/** Days between the order's date and the fair's period: 0 inside it. */
function daysFrom(o: Pick<FairOption, 'startDate' | 'endDate'>, soDate: string | null): number {
  if (!soDate || !ISO.test(soDate) || !ISO.test(o.startDate)) return 0;
  const d = dayNo(soDate);
  const start = dayNo(o.startDate);
  const end = dayNo(o.endDate && ISO.test(o.endDate) ? o.endDate : o.startDate);
  if (d < start) return start - d;
  if (d > end) return d - end;
  return 0;
}

/** One choice in a row's Fair dropdown: ONE booth — a brand at one event. */
export type BoothChoice = { projectId: number; label: string; sameBrand: boolean };

/**
 * The booths an order can be linked to here, and the one to fill in.
 *
 * Only fairs at the venue the order already records — the place is evidence
 * from the floor; this screen decides WHICH BOOTH, never where the sale
 * happened. Each reads BRAND — VENUE — ORGANIZER (dates). The order's own brand
 * comes first, then the rest; in each, the fair nearest the order's date first.
 * Two records of one booth (same brand at one event) show once, as the lowest
 * id — the arbiter the server's resolver uses (fair-options.ts
 * oneBoothOrNothing); booths with no brand cannot be told apart, so they are
 * never merged.
 *
 * `suggested` is the order's-brand booth nearest its date, or null when the
 * order has no brand or its brand has no booth there.
 */
export function boothChoices(
  options: readonly FairOption[],
  order: Pick<FairPendingRow, 'venue' | 'branding' | 'so_date'>,
): { choices: BoothChoice[]; suggested: number | null } {
  const brand = norm(order.branding);
  const soDate = order.so_date ? order.so_date.slice(0, 10) : null;
  const byBooth = new Map<string, { choice: BoothChoice; days: number; start: string; brand: string }>();
  for (const o of options) {
    if (norm(o.venue) !== norm(order.venue)) continue;
    const booths = o.booths ?? o.projectIds.map((projectId) => ({ projectId, brand: null }));
    for (const b of booths) {
      const key = b.brand ? `${o.key}|${norm(b.brand)}` : `${o.key}|#${b.projectId}`;
      const seen = byBooth.get(key);
      if (seen && seen.choice.projectId <= b.projectId) continue;
      byBooth.set(key, {
        choice: { projectId: b.projectId, label: `${b.brand || 'No brand'} — ${fairLabel(o)}`, sameBrand: brand !== '' && norm(b.brand) === brand },
        days: daysFrom(o, soDate),
        start: o.startDate,
        brand: norm(b.brand),
      });
    }
  }
  const choices = [...byBooth.values()]
    .sort((a, b) =>
      Number(b.choice.sameBrand) - Number(a.choice.sameBrand) ||
      a.days - b.days ||
      b.start.localeCompare(a.start) ||
      (a.brand === '' ? 1 : 0) - (b.brand === '' ? 1 : 0) ||
      a.brand.localeCompare(b.brand) ||
      a.choice.projectId - b.choice.projectId)
    .map((x) => x.choice);
  return { choices, suggested: choices[0]?.sameBrand ? choices[0].projectId : null };
}

export function FairPending() {
  const rowsQ = useFairPending(LIST_LIMIT);
  const checksQ = useFairChecks();
  const assign = useAssignFair();
  /* Finance or PMS re-assign here (owner 2026-10-16); the API enforces the same
     (scm/lib/fair-reassign.ts), this only stops a button that would be refused. */
  const { can, user } = useAuth();
  const canReassign = can('scm.finance.accounting') || canCreateEvent(user);
  const busy = assign.isPending || !canReassign;
  const rows = rowsQ.data ?? [];
  const checks = checksQ.data ?? [];

  const byGroup = useMemo(() => {
    const m = new Map<string, FairPendingRow[]>();
    for (const r of rows) {
      const k = r.fair_match ?? NO_VERDICT;
      const list = m.get(k);
      if (list) list.push(r); else m.set(k, [r]);
    }
    return m;
  }, [rows]);

  if (rowsQ.isLoading) return <div style={{ padding: 16 }}>Loading…</div>;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 20 }}>Fair links to settle</h1>
        {/* A list that could not be read must not read as "nothing to settle". */}
        {rowsQ.isError ? (
          <p role="alert" style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--c-festive-b, #B8331F)' }}>
            Couldn’t load the orders with no fair — try again.
          </p>
        ) : (
          <p style={{ margin: '4px 0 0', opacity: 0.7, fontSize: 13 }}>
            {rows.length === 0
              ? 'Nothing to settle — every order is linked to its fair.'
              : `${rows.length} order${rows.length === 1 ? '' : 's'} not yet attributed to a fair${rows.length >= LIST_LIMIT ? ` (the newest ${LIST_LIMIT} shown)` : ''}.`}
          </p>
        )}
        {checksQ.isError && (
          <p role="alert" style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--c-festive-b, #B8331F)' }}>
            Couldn’t load the linked orders to check — try again.
          </p>
        )}
        {!canReassign && (
          <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.7 }}>
            Only Finance or PMS can re-assign a fair here. Every change is in the order’s History.
          </p>
        )}
      </div>

      {CHECK_GROUPS.map((g) => {
        const list = checks.filter((r) => r.check === g.key);
        if (list.length === 0) return null;
        return (
          <Group key={g.key} title={`${g.title} (${list.length})`} hint={g.hint} last={g.key === 'VENUE_DIFFERS' ? 'Fair' : 'Status'}>
            {list.map((r) => (g.key === 'VENUE_DIFFERS'
              ? <PendingRow key={r.doc_no} row={r} note={r.note} onAssign={assign.mutate} busy={busy} />
              : <CheckRow key={r.doc_no} row={r} />))}
          </Group>
        );
      })}

      {GROUPS.map((g) => {
        const list = byGroup.get(g.key) ?? [];
        if (list.length === 0) return null;
        return (
          <Group key={g.key} title={`${g.title} (${list.length})`} hint={g.hint} last="Fair">
            {list.map((r) => (
              <PendingRow key={r.doc_no} row={r} onAssign={assign.mutate} busy={busy} />
            ))}
          </Group>
        );
      })}
    </div>
  );
}

/** One group: its title, what to do, and its orders in the shared columns. */
function Group({ title, hint, last, children }: { title: string; hint: string; last: 'Fair' | 'Status'; children: ReactNode }) {
  return (
    <section>
      <h2 style={{ margin: '0 0 2px', fontSize: 15 }}>{title}</h2>
      <p style={{ margin: '0 0 8px', opacity: 0.7, fontSize: 12 }}>{hint}</p>
      <div style={card}>
        <table style={{ width: '100%', minWidth: 960, tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
          <colgroup>
            {COLUMNS.map((w, i) => <col key={i} style={w == null ? undefined : { width: w }} />)}
          </colgroup>
          <thead>
            <tr>
              <th style={th}>SO No.</th>
              <th style={th}>SO date</th>
              <th style={th}>Venue</th>
              <th style={th}>Brand</th>
              <th style={{ ...th, textAlign: 'right' }}>Amount</th>
              <th style={th}>{last}</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </section>
  );
}

/** The order number, opening the order in its OWN tab of the in-app strip so
 *  this list stays one click away (owner 2026-10-20; the convention of the
 *  project page's SO list, lib/openDocInTab.ts). Ctrl/Cmd-click still opens a
 *  browser window. */
function SoLink({ docNo }: { docNo: string }) {
  return (
    <Link
      to={`/scm/sales-orders/${encodeURIComponent(docNo)}`}
      onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) markWorkspaceOpenIntent(true); }}
      style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, whiteSpace: 'nowrap' }}
    >
      {docNo}
    </Link>
  );
}

/** The cells every group shares: number, date, venue, brand, amount. */
function OrderCells({ row }: { row: Pick<FairPendingRow, 'doc_no' | 'so_date' | 'venue' | 'branding' | 'local_total_sen'> }) {
  return (
    <>
      <td style={td}><SoLink docNo={row.doc_no} /></td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDateOrDash(row.so_date)}</td>
      <td style={td}>{row.venue || <span style={soft}>(no place)</span>}</td>
      <td style={td}>{row.branding || <span style={soft}>no brand</span>}</td>
      <td style={num}>{money(row.local_total_sen)}</td>
    </>
  );
}

/** A 等加人 row: nothing to pick here — PMS adds the person in the project. */
function CheckRow({ row }: { row: FairCheckRow }) {
  return (
    <>
      <tr>
        <OrderCells row={row} />
        <td style={td}>{row.status === 'DRAFT' ? 'Draft' : 'Confirmed'}</td>
        <td style={td} />
      </tr>
      <tr><td colSpan={COLS} style={noteCell}>{row.note}</td></tr>
    </>
  );
}

function PendingRow(props: {
  row: Pick<FairPendingRow, 'doc_no' | 'so_date' | 'venue' | 'branding' | 'local_total_sen'>;
  /** The server's 要查 sentence, shown under the row. */
  note?: string;
  onAssign: (v: { docNo: string; projectId: number | null }) => void;
  busy: boolean;
}) {
  const { row, note, onAssign, busy } = props;
  /* null = untouched, so the suggestion shows; '' = the person cleared it. */
  const [pick, setPick] = useState<string | null>(null);
  /* The SAME options the salesperson saw, resolved for THIS order's date — not
     today's. An order from last week must be settled against the fairs that were
     running last week, or the screen offers an attribution that is wrong by
     construction. */
  const optionsQ = useFairOptions(row.so_date);
  const { choices, suggested } = boothChoices(
    [...(optionsQ.data?.running ?? []), ...(optionsQ.data?.earlier ?? [])],
    row,
  );
  const value = pick ?? (suggested != null ? String(suggested) : '');

  return (
    <>
      <tr>
        <OrderCells row={row} />
        <td style={td}>
          <select
            aria-label={`Fair for ${row.doc_no}`}
            value={value}
            disabled={busy || choices.length === 0}
            onChange={(e) => setPick(e.target.value)}
            style={select}
          >
            <option value="">
              {choices.length === 0 ? 'No fair at that place on that date' : '— choose a fair —'}
            </option>
            {choices.map((ch) => (
              <option key={ch.projectId} value={String(ch.projectId)}>{ch.label}</option>
            ))}
          </select>
        </td>
        <td style={{ ...td, textAlign: 'right' }}>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !value}
            onClick={() => onAssign({ docNo: row.doc_no, projectId: Number(value) })}
          >
            Link
          </Button>
        </td>
      </tr>
      {note && <tr><td colSpan={COLS} style={noteCell}>{note}</td></tr>}
    </>
  );
}

export default FairPending;
