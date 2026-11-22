// ----------------------------------------------------------------------------
// scm/lib/do-rack-cycle — the rack ledger of a delivery order reverted to Draft
// and shipped again.
//
// A ship takes the goods off their racks (warehouse_rack_movements STOCK_OUT,
// reason DO_RACK_OUT_REASON) and a revert or cancel puts them back (STOCK_IN,
// reason DO_RACK_IN_REASON). Both writers guard on "a row with my reason already
// exists for this DO number", so after one revert the re-ship found the old
// STOCK_OUT and took nothing off the racks, and a second revert found the old
// STOCK_IN and put nothing back. Same cycle rule as the stock ledger
// (do-stock-cycle.ts): once every unit has come back, the ship-and-return pair is
// re-tagged DO_RACK_REVERTED_REASON, so the DO reads as never racked out. The
// re-tag is ONE update, so the pair cannot be half retired.
// ----------------------------------------------------------------------------

import { DO_RACK_OUT_REASON } from './do-shipped-from-stamp';

export const DO_RACK_IN_REASON = 'DO cancelled';
export const DO_RACK_REVERTED_REASON = 'Delivery order reverted';

type Row = { movement_type: string; quantity: number | null };

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST client or the transaction adapter */
async function readCycle(sb: any, doNo: string, companyId: number | null): Promise<{ outs: number; ins: number; outRows: number; inRows: number } | string> {
  /* The DO number is not company scope; with no company known nothing is read or re-tagged. */
  if (companyId == null) return 'no company on the delivery order';
  const { data, error } = await sb.from('warehouse_rack_movements').select('movement_type, quantity')
    .eq('company_id', companyId).eq('source_doc_no', doNo).in('reason', [DO_RACK_OUT_REASON, DO_RACK_IN_REASON]);
  if (error) return `rack ledger read failed: ${(error as { message?: string }).message ?? 'unknown error'}`;
  let outs = 0, ins = 0, outRows = 0, inRows = 0;
  for (const r of (data ?? []) as Row[]) {
    if (r.movement_type === 'STOCK_OUT') { outs += Number(r.quantity ?? 0); outRows += 1; }
    else if (r.movement_type === 'STOCK_IN') { ins += Number(r.quantity ?? 0); inRows += 1; }
  }
  return { outs, ins, outRows, inRows };
}

/** Retire the DO's returned rack cycle. null = done (or nothing to retire); otherwise why not. */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST client or the transaction adapter */
export async function retireDoRackCycle(sb: any, doNo: string, companyId: number | null): Promise<string | null> {
  const c = await readCycle(sb, doNo, companyId);
  if (typeof c === 'string') return c;
  if (c.outRows === 0 && c.inRows === 0) return null;
  if (c.ins < c.outs) return `${c.outs - c.ins} unit(s) are still off the racks for ${doNo}`;
  if (companyId == null) return 'no company on the delivery order';
  const { error } = await sb.from('warehouse_rack_movements').update({ reason: DO_RACK_REVERTED_REASON })
    .eq('company_id', companyId).eq('source_doc_no', doNo).in('movement_type', ['STOCK_OUT', 'STOCK_IN'])
    .in('reason', [DO_RACK_OUT_REASON, DO_RACK_IN_REASON]);
  return error ? `rack ledger update failed: ${(error as { message?: string }).message ?? 'unknown error'}` : null;
}

/**
 * Before a ship takes the DO's goods off the racks. 'stock_out' = no live rack
 * stock-out on file, go on; 'already_out' = a real earlier ship, no-op; a string
 * = the racks were not touched, and why.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST client or the transaction adapter */
export async function rackShipState(sb: any, doNo: string, companyId: number | null): Promise<'stock_out' | 'already_out' | string> {
  const c = await readCycle(sb, doNo, companyId);
  if (typeof c === 'string') return c;
  if (c.outRows === 0) return 'stock_out';
  if (c.inRows === 0) return 'already_out';
  const err = await retireDoRackCycle(sb, doNo, companyId);
  return err ?? 'stock_out';
}
