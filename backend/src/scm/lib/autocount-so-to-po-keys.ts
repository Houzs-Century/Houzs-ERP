/* ----------------------------------------------------------------------------
   autocount-so-to-po-keys — the source line keys a `wait`-shaped purchase order
   could not know when it was queued.

   WHY IT IS ITS OWN FILE. `autocount-outbox.ts` sits at the 2,000-line cap and
   this is a self-contained drain-time read — the same reason `mastersOf` was
   extracted in 2026-08-14.

   WHY IT EXISTS. poTransferShape decides transfer-or-create on whether the
   sales-order lines carry an AutoCount DtlKey, and that key is written back
   only when the sales order reaches the book. A purchase order raised in the
   same minute sees NULL keys. That used to become a `create` — permanently
   unlinked in a licensed account book — and now becomes a `wait`, queued as
   so_to_po with an EMPTY DtlKeys array and a fromDoc on the sales order.

   The drain replays a stored payload and never recomposes, so an empty array
   would stay empty for ever and AcSyncService would refuse it ("DtlKeys
   required for /so-to-po"). By the time this runs, the parent check has already
   held the row until the sales order HAS its number, so the keys its create
   wrote back exist now. This is what turns "not yet" into "now".

   docs/bugs/0543.
   -------------------------------------------------------------------------- */

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client; `sb` is
   `any` throughout the SCM routes, no exported client type. */
type Sb = any;

import { readPoTransferFacts } from './autocount-read';
import { composeSoToPo } from '../../services/autocount-writeback';
import type { AcDetail } from '../../services/autocount-writeback';
import type { PoTransferShape } from '../shared/po-transfer-shape';

/**
 * The payload body for a purchase order, given its shape.
 *
 * `transfer` carries the keys it already has. `wait` carries an EMPTY DtlKeys
 * array — empty rather than absent, because the backfill below has to be able
 * to see the absence as a fact rather than guess it from a missing property
 * that could equally mean "this is a create". `create` sends the master whole.
 */
export function poBodyForShape(
  shape: PoTransferShape,
  body: Record<string, unknown>,
  details: readonly AcDetail[],
): Record<string, unknown> {
  if (shape.kind === 'transfer') {
    return composeSoToPo(body as never, shape.dtlKeys, details) as unknown as Record<string, unknown>;
  }
  if (shape.kind === 'wait') {
    return composeSoToPo(body as never, [], details) as unknown as Record<string, unknown>;
  }
  return body;
}


/**
 * Fill `body.DtlKeys` (and each Detail's DtlKey) for a so_to_po whose keys were
 * unknown at enqueue. Mutates `body` in place and returns whether it filled.
 *
 * ALL OF THEM OR NONE. A partial set would transfer some lines and leave the
 * rest out of a purchase order that looks complete — worse than the refusal the
 * service gives for an empty array, because nothing would report it.
 *
 * Best-effort: on any read failure the body is left untouched and the service's
 * own named refusal answers, which is a clear error rather than a mystery.
 */
export async function backfillSoToPoKeys(
  sb: Sb,
  op: string,
  body: Record<string, unknown>,
  writeback: { table?: string; key?: string } | null | undefined,
): Promise<boolean> {
  /* The guard lives HERE so the drain reads as one line. Only a so_to_po whose
     keys are an EMPTY array is a `wait` that has been held long enough. */
  if (op !== 'so_to_po' || !Array.isArray(body.DtlKeys) || body.DtlKeys.length !== 0) return false;
  if (writeback?.table !== 'purchase_orders' || !writeback.key) return false;
  const poId = String(writeback.key);
  try {
    const facts = await readPoTransferFacts(sb, poId);
    const keys = facts
      .map((f: { sourceAcDtlKey: number | null }) => f.sourceAcDtlKey)
      .filter((k): k is number => typeof k === 'number' && k > 0);
    if (!keys.length || keys.length !== facts.length) return false;
    body.DtlKeys = keys;
    const det = body.Details;
    if (Array.isArray(det) && det.length === keys.length) {
      det.forEach((d, i) => { (d as Record<string, unknown>).DtlKey = keys[i]; });
    }
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('so_to_po: DtlKey backfill failed:', e instanceof Error ? e.message : String(e));
    return false;
  }
}
