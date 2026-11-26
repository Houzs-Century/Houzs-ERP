import type { Hono } from 'hono';
import type { Env, Variables } from '../../env';
import { scopeToCompany } from '../../lib/companyScope';
import { normalizePhone } from '../../shared/phone';
import { pickCrossCategoryMatch, type AutoMatchCandidate } from '../../lib/cross-category-match';
import { checkCrossCategorySource, crossCatReasonText } from '../../lib/cross-category-source';

export function registerCrossCategoryRoutes(mfgSalesOrders: Hono<{ Bindings: Env; Variables: Variables }>): void {
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

mfgSalesOrders.get('/cross-category-match', async (c) => {
  const sb = c.get('supabase');
  const name = (c.req.query('name') ?? '').trim();
  const phoneRaw = (c.req.query('phone') ?? '').trim();
  const normPhone = phoneRaw ? (normalizePhone(phoneRaw) ?? phoneRaw) : null;
  if (!name || !normPhone) return c.json({ found: false });

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
