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
 *                              project (it no longer stops Confirm, 2026-10-22).
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
 * REPORT SAYS ANOTHER FAIR (owner 2026-10-20) sits first: another fair's
 * evening sales report lists the order — linked elsewhere or to nothing — so
 * the report names where it belongs. Only there may orders move in bulk
 * (ticked, or all at one click: 「也要支持一键按钮转」): the floor's own report
 * is the evidence. Everywhere else a person picks per order, deliberately —
 * every button here writes an attribution into exhibition P&L and somebody's
 * commission, and a bulk action over rows nobody read is how a wrong one gets
 * in. A transfer moves the Fair, the Venue and the Fair Day together.
 *
 * REF NO. AND ONE ROW PER ORDER (owner 2026-10-21: 「我这里也需要这个reference，
 * 然后这个表很乱」). Every group shows the order's Ref No. beside its SO number —
 * the slip number the evening report lists, by the SO page's own rule
 * (lib/customer-ref.ts). The report group is one row per order: the tick on the
 * left, then where the order is NOW and where the REPORT puts it, each booth on
 * two lines — "[AKEMI] HOMELOVE" over "IOIGECC · 10/09 - 10/11" — in place of
 * the sentence that used to sit under each row. Every group keeps the tick
 * column, empty where nothing is ticked, so the tables still line up.
 *
 * EVERY FAIR, FOR THE PEOPLE WHO SETTLE (owner 2026-10-21: 「我这里link fair 要可以
 * 选完全部fair」). A row offers the order's own place first — the same four weeks
 * the salesperson saw, its brand filled in — then, for Finance / PMS, every
 * other fair: the same place on other dates, then everywhere else, nearest the
 * order's date first, in one list that typing narrows. A slip saying PISA SPICE
 * ARENA could not otherwise reach the fair PMS calls SETIA SPICE CONVENTION
 * CENTRE. The order form keeps its four weeks at the order's place.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useAuth } from '../../auth/AuthContext';
import { canCreateEvent } from '../../auth/salesAccess';
import { customerRefOf } from '../../lib/customer-ref';
import { cn } from '../../lib/utils';
import { markWorkspaceOpenIntent } from '../../lib/workspaceTabs';
import { fmtDateOrDash, fmtDayMonth } from '../../vendor/shared/format';
import {
  useFairChecks,
  useFairPending,
  useFairPutAside,
  usePutAside,
  useAssignFair,
  useFairOptions,
  useAllFairOptions,
  useFairTransfer,
  transferSummary,
  type FairCheckRow,
  type FairPendingRow,
} from '../../vendor/scm/lib/fair-options-queries';
import { allBoothChoices, boothChoices } from '../../vendor/scm/lib/fair-booth-choices';
import { SearchableSelect, type SearchableSelectOption } from '../../vendor/scm/components/SearchableSelect';

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
  { key: 'NEEDS_ATTENDING', title: 'Waiting for Sales Attending', hint: 'The person who scanned the order is not on that booth’s Sales Attending. PMS adds them in the project.' },
] as const;

const soft: CSSProperties = { color: 'var(--fg-muted)' };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)' };
/* The second line of a booth: where and when. */
const detailLine: CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };

/* A boxed table, its heading drawn as the system's lists draw theirs
   (components/DataTable.tsx: surface-dim, bold ink, Title Case, a 2px rule
   under it) — owner 2026-10-21: 「做成好看的table 有线条的那种」, 「header
   颜色…可以refer 其他的table」. Every cell is ruled; the sentence under an order
   sits in that order's box, on a grey ground, with no line between them. */
const TABLE_BOX = 'overflow-x-auto rounded-lg border border-border bg-surface';
const TH = 'whitespace-nowrap border-b-2 border-r border-border bg-surface-dim px-3 py-2 text-left text-[11.5px] font-semibold text-ink last:border-r-0';
const TD = 'border-r border-t border-border px-3 py-2 align-middle text-[13px] text-ink [overflow-wrap:anywhere] last:border-r-0';
const TD_NOWRAP = cn(TD, 'whitespace-nowrap');
const TD_AMOUNT = cn(TD, 'whitespace-nowrap text-right tabular-nums');
const NOTE = 'bg-surface-2 px-3 pb-2 pt-1.5 text-[12px] text-ink-muted';

/* The same column widths in every group, so the tables line up: SO No. (with
   the report group's tick), Ref No., SO date, Venue (Now under), Brand, Amount,
   Fair, Link. */
const COLUMNS: Array<number | string | undefined> = [172, 104, 100, '18%', 110, 124, undefined, 184];
const COLS = COLUMNS.length;

function money(sen: number | null): string {
  if (sen == null) return '—';
  return `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function FairPending() {
  const rowsQ = useFairPending(LIST_LIMIT);
  const checksQ = useFairChecks();
  const asideQ = useFairPutAside(LIST_LIMIT);
  const assign = useAssignFair();
  const putAside = usePutAside();
  /* Finance or PMS re-assign here (owner 2026-10-16); the API enforces the same
     (scm/lib/fair-reassign.ts), this only stops a button that would be refused. */
  const { can, user } = useAuth();
  const canReassign = can('scm.finance.accounting') || canCreateEvent(user);
  const busy = assign.isPending || putAside.isPending || !canReassign;
  /* Owner 2026-10-21: 「还有一些我看了是 service 要 put aside 的」. */
  const setAside = (docNo: string, aside: boolean) => putAside.mutate({ docNo, aside });
  const rows = rowsQ.data ?? [];
  const checks = checksQ.data ?? [];
  const reported = useMemo(() => checks.filter((r) => r.check === 'REPORT_ELSEWHERE'), [checks]);

  /* An unlinked order a report names is listed once — under the report. */
  const byGroup = useMemo(() => {
    const inReport = new Set(reported.map((r) => r.doc_no));
    const m = new Map<string, FairPendingRow[]>();
    for (const r of rows) {
      if (inReport.has(r.doc_no)) continue;
      const k = r.fair_match ?? NO_VERDICT;
      const list = m.get(k);
      if (list) list.push(r); else m.set(k, [r]);
    }
    return m;
  }, [rows, reported]);

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

      {reported.length > 0 && <ReportGroup rows={reported} canTransfer={canReassign} />}

      {CHECK_GROUPS.map((g) => {
        const list = checks.filter((r) => r.check === g.key);
        if (list.length === 0) return null;
        return (
          <Group key={g.key} title={`${g.title} (${list.length})`} hint={g.hint} last={g.key === 'VENUE_DIFFERS' ? 'Fair' : 'Status'}>
            {list.map((r) => (g.key === 'VENUE_DIFFERS'
              ? <PendingRow key={r.doc_no} row={r} note={r.note} onAssign={assign.mutate} onPutAside={setAside} busy={busy} reachAll={canReassign} />
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
              <PendingRow key={r.doc_no} row={r} onAssign={assign.mutate} onPutAside={setAside} busy={busy} reachAll={canReassign} />
            ))}
          </Group>
        );
      })}

      <PutAsideGroup rows={asideQ.data ?? []} busy={busy} onBringBack={(docNo) => setAside(docNo, false)} />
    </div>
  );
}

/** The orders a person put aside (owner 2026-10-21), folded at the bottom: they
 *  are out of every group above and the menu's count until brought back. */
function PutAsideGroup({ rows, busy, onBringBack }: { rows: FairPendingRow[]; busy: boolean; onBringBack: (docNo: string) => void }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  const heading = (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: 0, border: 0, background: 'none', font: 'inherit', cursor: 'pointer' }}
    >
      <Chevron size={15} aria-hidden />Put aside ({rows.length})
    </button>
  );
  const hint = 'Orders put aside here: not in the groups above or the menu’s count. Bring one back to list it again.';
  if (!open) {
    return (
      <section>
        <h2 style={{ margin: '0 0 2px', fontSize: 15 }}>{heading}</h2>
        <p style={{ margin: 0, opacity: 0.7, fontSize: 12 }}>{hint}</p>
      </section>
    );
  }
  return (
    <Group title={heading} hint={hint} last="Put aside">
      {rows.map((r) => (
        <tr key={r.doc_no}>
          <OrderCells row={r} />
          <td className={TD}>{[r.fair_put_aside_by, r.fair_put_aside_at ? fmtDateOrDash(r.fair_put_aside_at) : ''].filter(Boolean).join(' · ') || '—'}</td>
          <td className={cn(TD, 'text-right')}>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onBringBack(r.doc_no)}>Bring back</Button>
          </td>
        </tr>
      ))}
    </Group>
  );
}

/** REPORT SAYS ANOTHER FAIR — move the ticked orders, or all of them at one
 *  click, to the booth the report puts each at (owner 2026-10-20). */
function ReportGroup({ rows, canTransfer }: { rows: FairCheckRow[]; canTransfer: boolean }) {
  const transfer = useFairTransfer();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [said, setSaid] = useState<string | null>(null);
  const movable = rows.filter((r) => r.target);
  const tickedRows = movable.filter((r) => ticked.has(r.doc_no));
  const off = transfer.isPending || !canTransfer;
  const allTicked = movable.length > 0 && tickedRows.length === movable.length;
  const toggle = (doc: string) => setTicked((s) => {
    const next = new Set(s);
    if (next.has(doc)) next.delete(doc); else next.add(doc);
    return next;
  });
  const move = (list: FairCheckRow[]) => {
    setSaid(null);
    transfer.mutate(
      list.map((r) => ({ docNo: r.doc_no, projectId: r.target!.projectId })),
      { onSuccess: (res) => { setSaid(transferSummary(res.results)); setTicked(new Set()); } },
    );
  };
  return (
    <Group
      title={`Report says another fair (${rows.length})`}
      hint="The evening sales report of another fair lists these orders. Transfer moves the Fair, the Venue and the Fair Day to that fair, and History records it."
      place="Now under"
      last="Report says"
      lead={(
        <input
          type="checkbox"
          aria-label="Tick every order"
          checked={allTicked}
          disabled={off || movable.length === 0}
          onChange={() => setTicked(allTicked ? new Set() : new Set(movable.map((r) => r.doc_no)))}
        />
      )}
      actions={(
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '0 0 8px' }}>
          <Button variant="secondary" size="sm" disabled={off || tickedRows.length === 0} onClick={() => move(tickedRows)}>
            Transfer ticked ({tickedRows.length})
          </Button>
          <Button variant="primary" size="sm" disabled={off || movable.length === 0} onClick={() => move(movable)}>
            Transfer all ({movable.length})
          </Button>
          {said && <span role="status" style={{ fontSize: 'var(--fs-12)' }}>{said}</span>}
        </div>
      )}
    >
      {rows.map((r) => (
        <tr key={r.doc_no}>
          <OrderCells
            row={r}
            lead={r.target && (
              <input type="checkbox" aria-label={`Tick ${r.doc_no}`} checked={ticked.has(r.doc_no)} disabled={off} onChange={() => toggle(r.doc_no)} />
            )}
            place={<NowUnder row={r} />}
          />
          <td className={TD} colSpan={2}><ReportSays row={r} /></td>
        </tr>
      ))}
    </Group>
  );
}

/** A booth on two lines: "[AKEMI] HOMELOVE" over "IOIGECC · 10/09 - 10/11". */
function BoothLines({ title, detail }: { title: string; detail: string }) {
  return (
    <>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {detail && <div style={detailLine}>{detail}</div>}
    </>
  );
}

/** Where the order is now: its booth, or "Not linked" over the venue it records. */
function NowUnder({ row }: { row: FairCheckRow }) {
  if (row.current) return <BoothLines title={row.current.title} detail={row.current.detail} />;
  if (row.project_id == null) {
    return <><div style={soft}>Not linked</div>{row.venue && <div style={detailLine}>{row.venue}</div>}</>;
  }
  return <span style={soft}>—</span>;
}

/** Where the evening report puts it, and the day of that report. Two fairs'
 *  reports both listing it: both named, for a person to pick on the order. */
function ReportSays({ row }: { row: FairCheckRow }) {
  const t = row.target;
  if (t) {
    const on = t.reportDate ? `reported ${fmtDayMonth(t.reportDate)}` : '';
    /* An older server sends one line only. */
    if (!t.title) return <>{t.label}{on && <span style={soft}> · {on}</span>}</>;
    return <BoothLines title={t.title} detail={[t.detail, on].filter(Boolean).join(' · ')} />;
  }
  return (
    <>
      <div style={soft}>Two reports list it — pick on the order</div>
      {!!row.candidates?.length && (
        <div style={detailLine}>{row.candidates.map((c) => (c.detail ? `${c.title} (${c.detail})` : c.title)).join(' / ')}</div>
      )}
    </>
  );
}

/** One group: its title, what to do, and its orders in the shared columns. */
function Group({ title, hint, place = 'Venue', last, lead, actions, children }: {
  title: ReactNode;
  hint: string;
  /** The fifth column: the order's venue, or (report group) where it is now. */
  place?: 'Venue' | 'Now under';
  /** The report group's last column also takes the Link column — it has no button. */
  last: 'Fair' | 'Status' | 'Report says' | 'Put aside';
  /** The report group's tick-all box, ahead of "SO No.". */
  lead?: ReactNode;
  /** Buttons above the table. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const wide = last === 'Report says';
  return (
    <section>
      <h2 style={{ margin: '0 0 2px', fontSize: 15 }}>{title}</h2>
      <p style={{ margin: '0 0 8px', opacity: 0.7, fontSize: 12 }}>{hint}</p>
      {actions}
      <div className={TABLE_BOX}>
        <table style={{ width: '100%', minWidth: 1040, tableLayout: 'fixed', borderCollapse: 'collapse' }}>
          <colgroup>
            {COLUMNS.map((w, i) => <col key={i} style={w == null ? undefined : { width: w }} />)}
          </colgroup>
          <thead>
            <tr>
              <th className={TH}>{lead ? <span className="inline-flex items-center gap-2">{lead}SO No.</span> : 'SO No.'}</th>
              <th className={TH}>Ref No.</th>
              <th className={TH}>SO date</th>
              <th className={TH}>{place}</th>
              <th className={TH}>Brand</th>
              <th className={cn(TH, 'text-right')}>Amount</th>
              <th className={TH} colSpan={wide ? 2 : 1}>{last}</th>
              {!wide && <th className={TH} />}
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

type OrderRow = Pick<FairPendingRow, 'doc_no' | 'so_date' | 'venue' | 'branding' | 'local_total_sen' | 'ref' | 'customer_so_no'>;

/** The cells every group shares: number (the report group's tick ahead of it),
 *  Ref No., date, venue, brand, amount. The report group puts where the order
 *  is now in the venue's place. */
function OrderCells({ row, lead, place }: { row: OrderRow; lead?: ReactNode; place?: ReactNode }) {
  const ref = customerRefOf(row);
  return (
    <>
      <td className={TD_NOWRAP}>
        {lead ? <span className="inline-flex items-center gap-2">{lead}<SoLink docNo={row.doc_no} /></span> : <SoLink docNo={row.doc_no} />}
      </td>
      <td className={TD_NOWRAP} style={mono}>{ref || <span style={soft}>—</span>}</td>
      <td className={TD_NOWRAP}>{fmtDateOrDash(row.so_date)}</td>
      <td className={TD}>{place ?? (row.venue || <span style={soft}>(no place)</span>)}</td>
      <td className={TD}>{row.branding || <span style={soft}>no brand</span>}</td>
      <td className={TD_AMOUNT} style={mono}>{money(row.local_total_sen)}</td>
    </>
  );
}

/** The server's sentence under an order, inside that order's box. */
function NoteRow({ note }: { note: string }) {
  return <tr><td colSpan={COLS} className={NOTE}>{note}</td></tr>;
}

/** A 等加人 row: nothing to pick here — PMS adds the person in the project. */
function CheckRow({ row }: { row: FairCheckRow }) {
  return (
    <>
      <tr>
        <OrderCells row={row} />
        <td className={TD}>{row.status === 'DRAFT' ? 'Draft' : 'Confirmed'}</td>
        <td className={TD} />
      </tr>
      <NoteRow note={row.note} />
    </>
  );
}

function PendingRow(props: {
  row: OrderRow;
  /** The server's 要查 sentence, shown under the row. */
  note?: string;
  onAssign: (v: { docNo: string; projectId: number | null }) => void;
  /** Put the order aside (owner 2026-10-21) — out of the list until brought back. */
  onPutAside: (docNo: string, aside: boolean) => void;
  busy: boolean;
  /** Finance / PMS: every fair may be picked, not only the order's own place. */
  reachAll: boolean;
}) {
  const { row, note, onAssign, onPutAside, busy, reachAll } = props;
  /* null = untouched, so the suggestion shows; '' = the person cleared it. */
  const [pick, setPick] = useState<string | null>(null);
  /* The SAME options the salesperson saw, resolved for THIS order's date — not
     today's. An order from last week must be settled against the fairs that were
     running last week, or the screen offers an attribution that is wrong by
     construction. They come first, the order's own brand filled in. */
  const optionsQ = useFairOptions(row.so_date);
  const { choices, suggested } = boothChoices(
    [...(optionsQ.data?.running ?? []), ...(optionsQ.data?.earlier ?? [])],
    row,
  );
  /* Then, for Finance / PMS, EVERY other fair — the same place on other dates,
     then everywhere else, nearest the order's date first (owner 2026-10-21: 「我
     这里link fair 要可以选完全部fair」: a slip saying PISA SPICE ARENA could not
     reach the fair PMS calls SETIA SPICE CONVENTION CENTRE). Never filled in;
     typing narrows the list. */
  const allQ = useAllFairOptions(reachAll);
  const options = useMemo((): SearchableSelectOption[] => {
    const offered = new Set(choices.map((ch) => ch.projectId));
    const rest = allBoothChoices(allQ.data ?? [], row).filter((ch) => !offered.has(ch.projectId));
    return [
      ...choices.map((ch) => ({ value: String(ch.projectId), label: ch.label, group: 'At this place' })),
      ...rest.filter((ch) => ch.samePlace).map((ch) => ({ value: String(ch.projectId), label: ch.label, group: 'At this place — other dates' })),
      ...rest.filter((ch) => !ch.samePlace).map((ch) => ({ value: String(ch.projectId), label: ch.label, group: 'Other places' })),
    ];
  }, [choices, allQ.data, row]);
  const value = pick ?? (suggested != null ? String(suggested) : '');

  return (
    <>
      <tr>
        <OrderCells row={row} />
        <td className={TD}>
          <SearchableSelect
            ariaLabel={`Fair for ${row.doc_no}`}
            value={value}
            options={options}
            disabled={busy || options.length === 0}
            onChange={setPick}
            placeholder={options.length === 0 ? 'No fair at that place on that date' : '— choose a fair — (type to search)'}
            className="w-full rounded-md border border-border bg-surface px-2 py-1 text-[13px]"
          />
        </td>
        <td className={cn(TD, 'text-right')}>
          <span className="inline-flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !value}
              onClick={() => onAssign({ docNo: row.doc_no, projectId: Number(value) })}
            >
              Link
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onPutAside(row.doc_no, true)}>
              Put aside
            </Button>
          </span>
        </td>
      </tr>
      {note && <NoteRow note={note} />}
    </>
  );
}

export default FairPending;
