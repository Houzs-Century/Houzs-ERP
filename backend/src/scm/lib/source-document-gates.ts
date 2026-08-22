/* ----------------------------------------------------------------------------
   source-document-gates — "may this document be the SOURCE of a downstream one",
   for the four conversions where the answer depends on a HOLD.

     Sales Order  -> Delivery Order    firstUndeliverableSo
     Sales Order  -> Purchase Order    firstUnorderableSo
     Purchase Order -> GRN             isReceivablePo
     GRN -> Purchase Invoice           grnOnHoldRefusal

   WHY THEY MOVED HERE (2026-08-22, mig 0324). Each one used to live inside its
   own route file and each one used to be able to see a hold FOR FREE, because
   the hold was written into the `status` column those three already read. It is
   a marker beside the status now, so all three had to be taught to read it — and
   two of them were described in their own migration headers as blocks that
   "come for free and cannot be forgotten" (0318 and 0319), which is exactly the
   kind of sentence that stops being true without anything failing.

   Putting them side by side is the point. They are three spellings of one
   question, they now share one dependency (`isDocumentHeld`), and the three
   route files they came from are all over their size ceilings, so a fourth
   inline copy could not have been added anyway.

   THEY REMAIN THE CALLER'S RULE, not this module's. Each takes the untyped
   supabase-js client the SCM tree passes around and performs its own read; none
   of them holds a company predicate, because the callers scope their own writes
   and a predicate hidden in here would be a scope nobody can see. That is the
   same posture `outstanding-po-lines.ts` states in its header.

   WHAT THEY ALL GET RIGHT, and it is the one thing to preserve: the hold column
   is SELECTED, never inferred. An unselected column reads `undefined`, which is
   not held, which is the permissive answer — so forgetting it is not a type
   error, it is a silently-open gate.
   ---------------------------------------------------------------------------- */

import { isDocumentHeld } from './document-hold';
import { soCanRaiseDo } from '../shared/so-deliverable-states';

/** The offender a gate returns: which document, what it says, and whether the
 *  reason is a hold rather than a status. */
export type BlockedSo = { docNo: string; status: string; onHold: boolean };

type SoStateRow = { doc_no: string; status: string | null; on_hold: boolean | null };

/** The one read all three SO gates make. `on_hold` is in the projection here so
 *  neither caller can forget it.
 *
 *  THE ERROR IS BOUND, and both gates FAIL CLOSED on it. supabase-js does not
 *  throw, so `const { data } = await …` cannot tell "the query failed" from
 *  "there are no such orders" — and here the two answers are opposite: an
 *  unreadable read would return no rows, every gate would find no offender, and
 *  a five-second database blip would authorise a delivery, a purchase order or
 *  a receipt against an order nobody could check. That is the exact shape
 *  check-swallowed-reads.mjs exists for, and it caught this one when the gates
 *  moved here (the discarded error came with them from the route files).
 *
 *  Note the asymmetry, because it is deliberate: an unreadable STATUS on a row
 *  we DID read falls through and is allowed — never over-block on a legacy
 *  row — but a read that did not happen at all authorises nothing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped supabase-js client this tree passes around
async function readSoStates(
  sb: any,
  soDocNos: Array<string | null | undefined>,
): Promise<{ rows: SoStateRow[]; error: string | null }> {
  const docNos = [...new Set(soDocNos.filter((d): d is string => !!d))];
  if (docNos.length === 0) return { rows: [], error: null };
  const { data, error } = await sb.from('mfg_sales_orders').select('doc_no, status, on_hold').in('doc_no', docNos);
  if (error) return { rows: [], error: error.message ?? 'unknown' };
  return { rows: (data ?? []) as SoStateRow[], error: null };
}

/** The offender a gate reports when it could not read at all. `UNREADABLE` is
 *  not a status any enum has, so the refusal messages name it as itself rather
 *  than dressing a database failure up as a document state. */
const unreadable = (docNos: Array<string | null | undefined>, why: string): BlockedSo => ({
  docNo: docNos.find((d): d is string => !!d) ?? '(unknown)',
  status: `UNREADABLE (${why})`,
  onHold: false,
});

/**
 * The first Sales Order in this set that a Delivery Order may NOT be raised
 * from, or null.
 *
 * A row with no readable status is left to fall through (never over-block); an
 * unknown doc_no simply is not returned by the read (the FK rejects it
 * downstream anyway).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see readSoStates
export async function firstUndeliverableSo(sb: any, soDocNos: Array<string | null | undefined>): Promise<BlockedSo | null> {
  const read = await readSoStates(sb, soDocNos);
  if (read.error) return unreadable(soDocNos, read.error);
  for (const r of read.rows) {
    const st = (r.status ?? '').toUpperCase();
    if (!soCanRaiseDo(st, r.on_hold ?? null)) return { docNo: r.doc_no, status: st, onHold: isDocumentHeld(r) };
  }
  return null;
}

/* Owner ruling: PO and MRP are built ONLY from a CONFIRMED Sales Order. A PO
   line sourced from an SO is allowed only when that SO's status is NOT in the
   deny-list below (i.e. CONFIRMED or beyond). New SOs are CONFIRMED on insert
   (only asDraft lands DRAFT), so the normal flow is unaffected. A purely manual
   PO line (no SO link) skips this entirely — a PO can be raised with no SO.
   Deny-list (not allow-list) so any legitimate forward status stays orderable.
   This is the SAME threshold the DO side uses (SO_UNDELIVERABLE_STATUSES) —
   a paused order should not be ordered until it is taken off hold. */
export const SO_UNORDERABLE_STATUSES = new Set(['DRAFT', 'CANCELLED', 'ON_HOLD']);

/** The first Sales Order in this set that a Purchase Order may NOT be raised
 *  from, or null. Same never-over-block posture as the deliverable gate. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see readSoStates
export async function firstUnorderableSo(sb: any, soDocNos: Array<string | null | undefined>): Promise<BlockedSo | null> {
  const read = await readSoStates(sb, soDocNos);
  if (read.error) return unreadable(soDocNos, read.error);
  for (const r of read.rows) {
    const st = (r.status ?? '').toUpperCase();
    const held = isDocumentHeld(r);
    if (held || SO_UNORDERABLE_STATUSES.has(st)) return { docNo: r.doc_no, status: st, onHold: held };
  }
  return null;
}

/* THE HOLD IS NAMED FIRST IN BOTH REFUSALS BELOW. A held order's status is a
   LIVE one — Confirmed, In Production — so any later arm would explain the
   refusal with the one fact that is not the reason for it. */
const refusalLabel = (o: BlockedSo, draftWords: string): string =>
  o.status.startsWith('UNREADABLE') ? 'could not be read just now, so this was refused rather than guessed'
  : o.onHold ? 'is on hold'
  : o.status === 'DRAFT' ? draftWords
  : o.status === 'CANCELLED' ? 'has been cancelled'
  : o.status === 'ON_HOLD' ? 'is on hold'
  : `is ${o.status.toLowerCase()}`;

export function soNotDeliverableResponse(offender: BlockedSo) {
  return {
    error: 'so_not_deliverable',
    message: `Sales Order ${offender.docNo} ${refusalLabel(offender, 'is still a draft')}, so a Delivery Order cannot be created from it. Confirm the Sales Order first.`,
    soDocNo: offender.docNo,
    soStatus: offender.status,
  };
}

export function soNotOrderableResponse(offender: BlockedSo) {
  return {
    error: 'so_not_orderable',
    message: `This sales order (${offender.docNo}) ${refusalLabel(offender, 'is not confirmed yet')} — a purchase order can only be raised from a confirmed order.`,
    soDocNo: offender.docNo,
    soStatus: offender.status,
  };
}

/* A source PO can only be received against while it is still open for receipt —
   SUBMITTED (nothing received yet) or PARTIALLY_RECEIVED (some received). A
   DRAFT / CANCELLED / already-RECEIVED PO must NOT accept a GRN (it would write
   stock IN against a PO that isn't live). This is the SINGLE predicate every GRN
   create path shares, and the picker reads it too, so the picker cannot offer
   what the create paths refuse. */
export const RECEIVABLE_PO_STATUSES = ['SUBMITTED', 'PARTIALLY_RECEIVED'] as const;

/**
 * May a GRN be received against this Purchase Order?
 *
 * TAKES THE ROW, NOT THE STATUS, since mig 0324. Migration 0318's header said a
 * held PO was excluded from this allow-list "for free and cannot be forgotten",
 * and that was true only while the hold OVERWROTE the status. A held PO now
 * reads SUBMITTED, so the marker is read here. Getting it wrong writes stock IN
 * against a purchase order somebody deliberately stopped.
 */
export const isReceivablePo = (po: { status?: string | null; on_hold?: boolean | null } | null): boolean =>
  !isDocumentHeld(po) && (RECEIVABLE_PO_STATUSES as readonly string[]).includes(po?.status ?? '');

/**
 * May a Purchase Invoice be raised from this GRN? Returns the refusal, or null.
 *
 * BOTH REASONS IN ONE PLACE, and they were two until mig 0324. Migration 0319
 * said the hold half came for free because the billable read is
 * `.eq('status','POSTED')`; a held GRN now reads POSTED, so it has to be asked
 * separately — and asking it separately at each call site is how one of them
 * ends up not asking. Both create paths (`from-grn-items` per pick, `from-grn`
 * per document) call this, and the picker's own read carries
 * `.eq('on_hold', false)` so it cannot offer what these refuse.
 *
 * THE HOLD IS TESTED FIRST: a held GRN is POSTED, so `grn_not_posted` would be
 * a true sentence about the wrong thing.
 */
export function grnNotBillableRefusal(
  grn: { status?: string | null; on_hold?: boolean | null } | null,
  extra: Record<string, unknown> = {},
): { error: string; message?: string; status?: string | null } | null {
  if (isDocumentHeld(grn)) {
    return { error: 'grn_on_hold', message: 'That goods received note is on hold. Take it off hold before invoicing it.', ...extra };
  }
  if (grn?.status !== 'POSTED') return { error: 'grn_not_posted', status: grn?.status ?? null, ...extra };
  return null;
}
