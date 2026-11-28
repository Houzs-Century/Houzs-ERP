
export type AllocationSettleOutcome = {
  ok: boolean;
  appliedSen: number;
  askedSen: number;
  alreadySettled: boolean;
  reason: string | null;
};

type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };

const firstRow = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

export async function settlePvAllocation(sb: RpcClient, allocId: string): Promise<AllocationSettleOutcome> {
  const { data, error } = await sb.rpc('settle_pv_allocation', { p_alloc_id: allocId });
  if (error) return { ok: false, appliedSen: 0, askedSen: 0, alreadySettled: false, reason: error.message };
  const row = firstRow<{ applied?: number; asked?: number; already_settled?: boolean; reason?: string | null }>(data);
  if (!row) return { ok: false, appliedSen: 0, askedSen: 0, alreadySettled: false, reason: 'settle_pv_allocation returned no row' };
  if (row.reason === 'not_found') return { ok: false, appliedSen: 0, askedSen: 0, alreadySettled: false, reason: 'allocation not found' };
  return {
    ok: true,
    appliedSen: Number(row.applied ?? 0),
    askedSen: Number(row.asked ?? 0),
    alreadySettled: row.already_settled === true,
    reason: row.reason ?? null,
  };
}

export async function unsettlePvAllocation(
  sb: RpcClient,
  allocId: string,
): Promise<{ ok: boolean; reversedSen: number; recordedSen: number; reason: string | null }> {
  const { data, error } = await sb.rpc('unsettle_pv_allocation', { p_alloc_id: allocId });
  if (error) return { ok: false, reversedSen: 0, recordedSen: 0, reason: error.message };
  const row = firstRow<{ reversed?: number; recorded?: number; reason?: string | null }>(data);
  if (!row) return { ok: false, reversedSen: 0, recordedSen: 0, reason: 'unsettle_pv_allocation returned no row' };
  if (row.reason === 'not_found') return { ok: false, reversedSen: 0, recordedSen: 0, reason: 'allocation not found' };
  return { ok: true, reversedSen: Number(row.reversed ?? 0), recordedSen: Number(row.recorded ?? 0), reason: row.reason ?? null };
}

/** The voucher's advance: what it paid beyond what its invoices actually took. Counted from applied_sen, never
    amount_sen - money an invoice refused (the clamp) is still in AP, so it belongs to the advance, not to nobody. */
export function voucherAdvanceSen(totalSen: number, allocations: Array<{ applied_sen: number | null; from_advance: boolean | null }>): number {
  const applied = allocations
    .filter((a) => a.from_advance !== true)
    .reduce((s, a) => s + Math.max(0, Number(a.applied_sen ?? 0)), 0);
  return Math.max(0, Number(totalSen) - applied);
}
