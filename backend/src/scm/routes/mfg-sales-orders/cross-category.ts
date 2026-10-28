import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { scopeToCompany } from '../../lib/companyScope';
import { normalizePhone } from '../../shared/phone';
import { pickCrossCategoryMatch, type AutoMatchCandidate } from '../../lib/cross-category-match';
import { checkCrossCategorySource, crossCatReasonText } from '../../lib/cross-category-source';

/* GET /cross-category-eligibility, GET /cross-category-match — moved out of mfg-sales-orders.ts, which calls this where the block
   stood, so registration order is unchanged. The body is moved verbatim and left
   unindented on purpose: source tests anchor on `\nmfgSalesOrders.<verb>(`. */
export function registerCrossCategoryRoutes(mfgSalesOrders: Hono<{ Bindings: Env; Variables: Variables }>): void {
// GET /cross-category-eligibility?docNo&phone — live check for the handover
// preview so the cross-category delivery discount only applies for a real,
// eligible SO (sales can no longer "type anything" and get the reduced rate).
// Static path is registered before /:docNo so it isn't captured as a docNo.
mfgSalesOrders.get('/cross-category-eligibility', async (c) => {
  const sb = c.get('supabase');
  const docNo = (c.req.query('docNo') ?? '').trim();
  const phone = (c.req.query('phone') ?? '').trim();
  if (!docNo) return c.json({ eligible: false });
  const result = await checkCrossCategorySource(c, sb, docNo, phone || null);
  return c.json({
    eligible:  result.eligible,
    debtorName: result.debtorName ?? null,
    message:   result.eligible ? null : crossCatReasonText(docNo, result.reason),
  });
});

// GET /cross-category-match?name&phone — the Confirm-screen "Auto-match" button.
// Scans THIS customer's earlier sales orders and returns the most recent one
// that can still back a cross-category follow-up, so sales don't have to recall
// the SO number. "Same customer" = the (name, phone) identity key (migration
// 0144) — a shared phone with a different name is a different customer. The SO
// must not be cancelled and must not already be linked-from by another order
// (single-use; the unique index on cross_category_source_doc_no is the hard
// gate, this just keeps the button from offering a burnt SO). Read-only: it
// never mints a customer row (unlike the order POST). Registered before /:docNo
// so the static path isn't captured as a docNo.
mfgSalesOrders.get('/cross-category-match', async (c) => {
  const sb = c.get('supabase');
  const name = (c.req.query('name') ?? '').trim();
  const phoneRaw = (c.req.query('phone') ?? '').trim();
  const normPhone = phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null;
  // Both halves of the identity key are required to find a customer's orders.
  if (!name || !normPhone) return c.json({ found: false });

  // Candidate earlier SOs for this phone, newest first. Name is matched in the
  // pure helper with the same lower(trim) rule as the customers unique index.
  const { data: rows } = await scopeToCompany(
    sb
      .from('mfg_sales_orders')
      .select('doc_no, debtor_name, created_at')
      .eq('phone', normPhone)
      .not('status', 'in', '("CANCELLED","DRAFT")'),
    c,
  )
    .order('created_at', { ascending: false })
    .limit(50);
  const candidates: AutoMatchCandidate[] = ((rows ?? []) as Array<{ doc_no: string; debtor_name: string | null }>)
    .map((r) => ({ docNo: r.doc_no, debtorName: r.debtor_name }));
  if (candidates.length === 0) return c.json({ found: false });

  // Which of those candidate SOs are already linked-from by another order.
  const { data: usedRows } = await scopeToCompany(
    sb
      .from('mfg_sales_orders')
      .select('cross_category_source_doc_no')
      .in('cross_category_source_doc_no', candidates.map((c2) => c2.docNo)),
    c,
  );
  const used = ((usedRows ?? []) as Array<{ cross_category_source_doc_no: string | null }>)
    .map((r) => r.cross_category_source_doc_no)
    .filter((v): v is string => !!v);

  const match = pickCrossCategoryMatch(candidates, name, used);
  return match
    ? c.json({ found: true, docNo: match.docNo, debtorName: match.debtorName })
    : c.json({ found: false });
});
}
