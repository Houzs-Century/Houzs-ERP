import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueueConvert, recordConvertSkipped, recordParentlessCreate } from './autocount-outbox';
import { scopeToCompanyId } from './companyScope';

type Sb = SupabaseClient;

/** What was recorded. Returned so a caller — and the tests — can assert it. */
export type SiAcSourceOutcome =
  | 'no-company'
  | 'unreadable'
  | 'enqueued'
  | 'mixed-source-lines'
  | 'parentless';

interface SiLineRow { id: string; item_code: string | null; do_item_id: string | null }

/**
 * Decide, and WRITE, what AutoCount is told about a freshly created Sales
 * Invoice. Never throws: the caller has already committed the user's document.
 *
 * `companyId` and `createdBy` are required rather than optional — both DECIDE
 * something here (the first decides whether anything is written at all), and
 * CLAUDE.md's optional-param-noop rule wants the compiler to enumerate the call
 * sites rather than let a caller keep the old behaviour by saying nothing.
 */
export async function recordSiAutoCountSource(
  sb: Sb,
  opts: {
    companyId: number | null | undefined;
    invoiceId: string;
    invoiceNumber: string;
    createdBy: number | null;
  },
): Promise<SiAcSourceOutcome> {
  const companyId = Number(opts.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) return 'no-company';

  const skip = async (reason: string): Promise<void> => {
    await recordConvertSkipped(sb, {
      companyId,
      op: 'do_to_iv',
      docType: 'IV',
      docNo: opts.invoiceNumber,
      docId: opts.invoiceId,
      reason,
      createdBy: opts.createdBy,
    });
  };

  const { data: lineData, error: lineErr } = await scopeToCompanyId(
    sb.from('sales_invoice_items')
      .select('id, item_code, do_item_id')
      .eq('sales_invoice_id', opts.invoiceId),
    companyId,
  );
  if (lineErr) {
    await skip(`compose failed, nothing sent: could not read this invoice's lines to resolve its source Delivery Order (${lineErr.message})`);
    return 'unreadable';
  }
  const lines = (lineData ?? []) as SiLineRow[];
  const linkedIds = [...new Set(
    lines.map((l) => l.do_item_id).filter((v): v is string => typeof v === 'string' && v.length > 0),
  )];

  const doIds = new Set<string>();
  if (linkedIds.length > 0) {
    const { data: srcData, error: srcErr } = await scopeToCompanyId(
      sb.from('delivery_order_items').select('id, delivery_order_id').in('id', linkedIds),
      companyId,
    );
    if (srcErr) {
      await skip(`compose failed, nothing sent: could not resolve the Delivery Order behind this invoice's lines (${srcErr.message})`);
      return 'unreadable';
    }
    for (const r of (srcData ?? []) as Array<{ delivery_order_id: string | null }>) {
      if (r.delivery_order_id) doIds.add(r.delivery_order_id);
    }
  }

  if (doIds.size === 0) {
    const { data: hdr, error: hdrErr } = await scopeToCompanyId(
      sb.from('sales_invoices').select('id, delivery_order_id').eq('id', opts.invoiceId),
      companyId,
    ).maybeSingle();
    if (hdrErr) {
      await skip(`compose failed, nothing sent: could not read this invoice's own header to say what it declares (${hdrErr.message})`);
      return 'unreadable';
    }
    const headerDoId = (hdr as { delivery_order_id: string | null } | null)?.delivery_order_id ?? null;
    await recordParentlessCreate(sb, {
      companyId,
      docType: 'IV',
      docNo: opts.invoiceNumber,
      docId: opts.invoiceId,
      missing: headerDoId
        ? 'a source Delivery Order on its header but not one line taken from it'
        : 'no source Delivery Order',
      createdBy: opts.createdBy,
    });
    return 'parentless';
  }

  const unlinked = lines.filter((l) => !l.do_item_id);
  if (unlinked.length > 0) {
    const codes = [...new Set(unlinked.map((l) => l.item_code ?? '(no item code)'))].sort();
    await skip(`${unlinked.length} of ${lines.length} line(s) on this invoice came from no source document (${codes.join(', ')}) — AutoCount builds an invoice only by transferring a Delivery Order's lines, so the transfer would produce an invoice MISSING them and understate the revenue in the account book`);
    return 'mixed-source-lines';
  }

  await enqueueConvert(sb, {
    companyId,
    op: 'do_to_iv',
    from: [...doIds].map((id) => ({ table: 'delivery_orders' as const, keyCol: 'id', key: id })),
    to: { table: 'sales_invoices', keyCol: 'id', key: opts.invoiceId },
    docType: 'IV',
    docNo: opts.invoiceNumber,
    docId: opts.invoiceId,
    createdBy: opts.createdBy,
  });
  return 'enqueued';
}
