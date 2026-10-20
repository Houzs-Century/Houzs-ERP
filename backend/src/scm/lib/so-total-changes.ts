// ----------------------------------------------------------------------------
// so-total-changes.ts — one row in scm.so_total_changes each time an order's
// goods or total change (owner 2026-10-20: the upsales / drop sales Event
// Commission shows under each order, recorded from go-live).
//
// Written from the ONE place every line change already rolls the header up —
// routes/mfg-sales-orders.ts recomputeTotals — so a direct edit, an approved
// amendment and a free-gift reconcile all land here without each route knowing.
// The roll-up reads the header BEFORE it writes (snapshotSoTotals) and hands the
// figures it wrote; a change is recorded only when one actually moved.
//
// Best-effort like the roll-up itself: a failed read or write is logged and the
// edit stands — except inside an atomic command, where a failed statement has
// already doomed the transaction, so it rethrows like the roll-up's own write.
// ----------------------------------------------------------------------------

export type SoTotalsSnapshot = { companyId: number; goodsSen: number; totalSen: number };

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/** The order's goods (the four goods buckets — delivery and service are not
 *  goods) and its total, as the header holds them now. Null when unread. */
export async function snapshotSoTotals(sb: any, docNo: string): Promise<SoTotalsSnapshot | null> {
  const { data, error } = await sb.from('mfg_sales_orders')
    .select('company_id, mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen, local_total_sen')
    .eq('doc_no', docNo).maybeSingle();
  if (error || !data) return null;
  return {
    companyId: n(data.company_id),
    goodsSen: n(data.mattress_sofa_sen) + n(data.bedframe_sen) + n(data.accessories_sen) + n(data.others_sen),
    totalSen: n(data.local_total_sen),
  };
}

/** What kind of request changed the order — the path names an amendment. */
export function changeSourceOf(c: any): 'edit' | 'amendment' | 'system' {
  const path = String(c?.req?.path ?? '');
  if (!path) return 'system';
  return /\/amendments?(\/|$)/.test(path) ? 'amendment' : 'edit';
}

/** Record the change from `before` to the figures the roll-up just wrote, if
 *  any moved. Never throws outside an atomic command. */
export async function recordSoTotalChange(
  sb: any,
  c: any,
  docNo: string,
  before: SoTotalsSnapshot | null,
  after: { goodsSen: number; totalSen: number },
): Promise<void> {
  if (!before) return;
  if (before.goodsSen === after.goodsSen && before.totalSen === after.totalSen) return;
  const { error } = await sb.from('so_total_changes').insert({
    company_id: before.companyId,
    so_doc_no: docNo,
    before_goods_sen: before.goodsSen,
    after_goods_sen: after.goodsSen,
    before_total_sen: before.totalSen,
    after_total_sen: after.totalSen,
    source: changeSourceOf(c),
    changed_by: (c?.get?.('houzsUser')?.name as string | undefined) ?? null,
  });
  if (!error) return;
  if (sb?.__atomicCommand === true) throw new Error(`SO total change not recorded: ${error.message}`);
  /* eslint-disable-next-line no-console */
  console.error('[so-total-changes] not recorded:', docNo, error.message);
}
