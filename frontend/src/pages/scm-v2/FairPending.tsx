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
 * There is no bulk "link them all" action, deliberately: every button here
 * writes an attribution into exhibition P&L and somebody's commission, and a
 * bulk action over rows nobody read is how a wrong one gets in.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useFairChecks,
  useFairPending,
  useAssignFair,
  useFairOptions,
  fairLabel,
  type FairCheckRow,
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

function money(sen: number | null): string {
  if (sen == null) return '—';
  return `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function FairPending() {
  const rowsQ = useFairPending(LIST_LIMIT);
  const checksQ = useFairChecks();
  const assign = useAssignFair();
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
      </div>

      {CHECK_GROUPS.map((g) => {
        const list = checks.filter((r) => r.check === g.key);
        if (list.length === 0) return null;
        return (
          <section key={g.key}>
            <h2 style={{ margin: '0 0 2px', fontSize: 15 }}>{g.title} ({list.length})</h2>
            <p style={{ margin: '0 0 8px', opacity: 0.7, fontSize: 12 }}>{g.hint}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {list.map((r) => (g.key === 'VENUE_DIFFERS'
                ? <PendingRow key={r.doc_no} row={r} note={r.note} onAssign={assign.mutate} busy={assign.isPending} />
                : <CheckRow key={r.doc_no} row={r} />))}
            </div>
          </section>
        );
      })}

      {GROUPS.map((g) => {
        const list = byGroup.get(g.key) ?? [];
        if (list.length === 0) return null;
        return (
          <section key={g.key}>
            <h2 style={{ margin: '0 0 2px', fontSize: 15 }}>{g.title} ({list.length})</h2>
            <p style={{ margin: '0 0 8px', opacity: 0.7, fontSize: 12 }}>{g.hint}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {list.map((r) => (
                <PendingRow key={r.doc_no} row={r} onAssign={assign.mutate} busy={assign.isPending} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** A 等加人 row: nothing to pick here — PMS adds the person in the project. */
function CheckRow({ row }: { row: FairCheckRow }) {
  return (
    <div style={{ border: '1px solid var(--c-border, #ddd)', borderRadius: 8, padding: 10, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
      <Link to={`/scm/sales-orders/${encodeURIComponent(row.doc_no)}`} style={{ fontFamily: 'monospace', fontSize: 13 }}>{row.doc_no}</Link>
      <span style={{ fontSize: 13, opacity: 0.8 }}>{row.so_date ?? '—'}</span>
      <span style={{ fontSize: 12, opacity: 0.7 }}>{row.status === 'DRAFT' ? 'Draft' : 'Confirmed'}</span>
      <span style={{ fontSize: 13, marginInlineStart: 'auto' }}>{money(row.local_total_sen)}</span>
      <span style={{ flexBasis: '100%', fontSize: 12.5 }}>{row.note}</span>
    </div>
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
  const [pick, setPick] = useState<string>('');
  /* The SAME options the salesperson saw, resolved for THIS order's date — not
     today's. An order from last week must be settled against the fairs that were
     running last week, or the screen offers an attribution that is wrong by
     construction. */
  const optionsQ = useFairOptions(row.so_date);
  const options = [...(optionsQ.data?.running ?? []), ...(optionsQ.data?.earlier ?? [])];
  /* Only fairs at the venue the order already records. The place is evidence
     from the floor; this screen decides WHICH BOOTH, never where the sale
     happened. */
  const atVenue = options.filter(
    (o) => o.venue.trim().toLowerCase() === (row.venue ?? '').trim().toLowerCase(),
  );

  return (
    <div style={{ border: '1px solid var(--c-border, #ddd)', borderRadius: 8, padding: 10, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
      <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{row.doc_no}</span>
      <span style={{ fontSize: 13, opacity: 0.8 }}>{row.so_date ?? '—'}</span>
      <span style={{ fontSize: 13 }}>{row.venue || '(no place)'}</span>
      <span style={{ fontSize: 12, opacity: 0.7 }}>{row.branding || 'no brand'}</span>
      <span style={{ fontSize: 13, marginInlineStart: 'auto' }}>{money(row.local_total_sen)}</span>
      <select
        aria-label={`Fair for ${row.doc_no}`}
        value={pick}
        disabled={busy || atVenue.length === 0}
        onChange={(e) => setPick(e.target.value)}
      >
        <option value="">
          {atVenue.length === 0 ? 'No fair at that place on that date' : '— choose a fair —'}
        </option>
        {atVenue.map((o) => (
          /* One row can cover several brand booths. Offer each project id, since
             the point of this screen is choosing between them. */
          o.projectIds.map((id) => (
            <option key={`${o.key}:${id}`} value={String(id)}>{`${fairLabel(o)} #${id}`}</option>
          ))
        ))}
      </select>
      <button
        type="button"
        disabled={busy || !pick}
        onClick={() => onAssign({ docNo: row.doc_no, projectId: Number(pick) })}
      >
        Link
      </button>
      {note && <span style={{ flexBasis: '100%', fontSize: 12.5 }}>{note}</span>}
    </div>
  );
}

export default FairPending;
