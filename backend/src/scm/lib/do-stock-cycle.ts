// ----------------------------------------------------------------------------
// scm/lib/do-stock-cycle — a delivery order reverted to Draft can ship again.
//
// A revert to Draft returns the DO's stock with rows tagged 'ADJUSTMENT' + the
// DO id, while its first OUT rows stay tagged 'DO'. Left like that, the next ship
// finds an OUT and deducts nothing. scm.fn_retire_do_stock_cycle re-tags that
// ship-and-return cycle 'DO_REVERTED' so the DO reads as never shipped; it
// refuses while stock is still out.
// ----------------------------------------------------------------------------

type Rpc = { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ error: { message?: string } | null }> };
type Head = { count: number | null; error: { message?: string } | null };
type Db = Rpc & { from: (table: string) => unknown };

/** Retire the DO's returned ship. null = done; otherwise the reason it was not. */
export async function retireDoStockCycle(db: Rpc, deliveryOrderId: string): Promise<string | null> {
  try {
    const { error } = await db.rpc('fn_retire_do_stock_cycle', { p_do_id: deliveryOrderId });
    return error ? (error.message ?? 'unknown error') : null;
  } catch (e) {
    return e instanceof Error ? e.message : 'unknown error';
  }
}

export const RESHIP_NOT_DEDUCTED =
  'Stock was NOT taken out: this delivery order was reverted to Draft earlier (its stock was returned) and its old stock record could not be cleared';

/**
 * The deduction found an OUT already on file for this DO. If a revert returned
 * that stock (a reversal row exists), retire the cycle so the ship can deduct
 * afresh. 'deduct' = go on and write the OUT; 'shipped' = a real earlier ship,
 * no-op; a string = the ship must not read as clean.
 */
export async function reshipAfterRevert(db: Db, deliveryOrderId: string): Promise<'deduct' | 'shipped' | string> {
  const q = db.from('inventory_movements') as {
    select: (c: string, o: object) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => PromiseLike<Head> } };
  };
  const { count, error } = await q.select('id', { head: true, count: 'exact' })
    .eq('source_doc_type', 'ADJUSTMENT').eq('source_doc_id', deliveryOrderId);
  if (error) return `Could not check whether an earlier revert returned this delivery order's stock: ${error.message ?? 'unknown error'}`;
  if ((count ?? 0) === 0) return 'shipped';
  const retireErr = await retireDoStockCycle(db, deliveryOrderId);
  return retireErr ? `${RESHIP_NOT_DEDUCTED} (${retireErr}). Tell IT so the stock can be adjusted by hand.` : 'deduct';
}
