
import { isDocumentHeld } from './document-hold';
import { soCanRaiseDo } from '../shared/so-deliverable-states';

/** The offender a gate returns: which document, what it says, and whether the
 *  reason is a hold rather than a status. */
export type BlockedSo = { docNo: string; status: string; onHold: boolean };

type SoStateRow = { doc_no: string; status: string | null; on_hold: boolean | null };

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

export const SO_UNORDERABLE_STATUSES = new Set(['DRAFT', 'CANCELLED', 'ON_HOLD', 'CLOSED']);

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
