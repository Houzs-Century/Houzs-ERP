/* The three functions of migration 20261122T0100_scm_pv_allocation_settle_once, answered over in-memory tables the way PostgreSQL answers them, for route tests
   whose fake client already answers settle_pi_paid_sen / settle_api_paid_sen. Wrap that rpc with this one.
   The real functions are proven against PostgreSQL in tests-pg/pvAllocationSettleOnce.pg.test.ts. */
type Row = Record<string, any>;
type Rpc = (fn: string, args: Row) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;

const first = (data: unknown): Row => ((Array.isArray(data) ? data[0] : data) ?? {}) as Row;

export function withPvAllocationRpcs(tables: Record<string, Row[]>, base: Rpc): Rpc {
  const settle = async (alloc: Row, delta: number): Promise<{ applied: number; reason: string | null }> => {
    const r = alloc.ap_invoice_id
      ? await base('settle_api_paid_sen', { p_id: alloc.ap_invoice_id, p_delta: delta })
      : await base('settle_pi_paid_sen', { p_pi_id: alloc.pi_id, p_delta: delta });
    if (r.error) throw new Error(r.error.message);
    const row = first(r.data);
    return { applied: Number(row.applied_sen ?? 0), reason: row.reason ?? null };
  };
  return async (fn, args) => {
    try { return await answer(fn, args); } catch (e) {
      /* A raised error rolls the whole function back: nothing above changed, the caller gets the error. */
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  };
  async function answer(fn: string, args: Row): ReturnType<Rpc> {
    const allocs = (tables.pv_allocations ||= []);
    if (fn === 'settle_pv_allocation') {
      const a = allocs.find((x) => x.id === args.p_alloc_id);
      if (!a) return { data: [{ applied: 0, asked: 0, already_settled: false, reason: 'not_found' }], error: null };
      if (a.settled_at) return { data: [{ applied: a.applied_sen, asked: a.amount_sen, already_settled: true, reason: null }], error: null };
      const amount = Number(a.amount_sen ?? 0);
      const s = amount > 0 && (a.pi_id || a.ap_invoice_id) ? await settle(a, amount) : { applied: 0, reason: null };
      a.applied_sen = s.applied;
      a.settled_at = new Date().toISOString();
      return { data: [{ applied: s.applied, asked: amount, already_settled: false, reason: s.reason }], error: null };
    }
    if (fn === 'unsettle_pv_allocation') {
      const a = allocs.find((x) => x.id === args.p_alloc_id);
      if (!a) return { data: [{ reversed: 0, recorded: 0, reason: 'not_found' }], error: null };
      const applied = Number(a.applied_sen ?? 0);
      if (applied <= 0) { a.settled_at = null; return { data: [{ reversed: 0, recorded: 0, reason: null }], error: null }; }
      const s = await settle(a, -applied);
      a.applied_sen = 0;
      a.settled_at = null;
      return { data: [{ reversed: -s.applied, recorded: applied, reason: s.reason }], error: null };
    }
    if (fn === 'apply_supplier_advance') {
      const adv = (tables.acc_supplier_advances ?? []).find((x) => String(x.pv_id) === String(args.p_pv_id) && Number(x.company_id) === Number(args.p_company_id));
      if (!adv) return { data: null, error: { message: 'This voucher holds no advance.', code: 'P0415' } };
      const pv = (tables.payment_vouchers ?? []).find((x) => x.id === args.p_pv_id);
      if (pv && pv.status !== 'POSTED') return { data: null, error: { message: "Only a posted voucher's advance can be applied.", code: 'P0415' } };
      const wants = (args.p_wants ?? []) as Row[];
      const asked = wants.reduce((s, w) => s + Math.max(0, Number(w.amount_sen ?? 0)), 0);
      const remaining = Number(adv.amount_sen) - Number(adv.applied_sen);
      if (asked > remaining) return { data: null, error: { message: `Only ${remaining} sen of this advance remains; ${asked} sen was asked.`, code: 'P0415' } };
      const out: Row[] = [];
      let total = 0;
      for (const w of wants) {
        const amount = Number(w.amount_sen ?? 0);
        if (amount <= 0 || (!w.pi_id && !w.ap_invoice_id)) continue;
        const s = await settle({ pi_id: w.ap_invoice_id ? null : w.pi_id, ap_invoice_id: w.ap_invoice_id ?? null }, amount);
        if (s.applied > 0) {
          allocs.push({
            id: `adv-alloc-${allocs.length + 1}`, company_id: args.p_company_id, pv_id: args.p_pv_id,
            pi_id: w.ap_invoice_id ? null : w.pi_id, ap_invoice_id: w.ap_invoice_id ?? null,
            amount_sen: s.applied, applied_sen: s.applied, from_advance: true, settled_at: new Date().toISOString(),
          });
          total += s.applied;
        }
        out.push({ pi_id: w.ap_invoice_id ? null : w.pi_id, ap_invoice_id: w.ap_invoice_id ?? null, asked: amount, applied: s.applied, remaining: null });
      }
      adv.applied_sen = Number(adv.applied_sen) + total;
      out.push({ pi_id: null, ap_invoice_id: null, asked, applied: total, remaining: remaining - total });
      return { data: out, error: null };
    }
    return base(fn, args);
  }
}
