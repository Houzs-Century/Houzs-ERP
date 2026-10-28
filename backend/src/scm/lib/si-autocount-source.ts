// ----------------------------------------------------------------------------
// si-autocount-source — what the AutoCount outbox is told about a Sales Invoice
// that the GENERIC create path (POST /sales-invoices) just wrote.
//
// WHY THIS EXISTS. That handler called recordParentlessCreate UNCONDITIONALLY,
// with `missing: 'no source Delivery Order'` — a claim it never checked. POST /
// accepts a source on both halves of the document: `deliveryOrderId` on the
// header and `doItemId` on every line, and the desktop "invoice from a delivery
// order" flow sends both (SalesInvoiceFromDo -> SalesInvoiceNew:360/:390 ->
// POST /). So a desktop invoice raised FROM a delivery order was filed as
// ERP-only and never enqueued, while the mobile surface went through
// POST /from-dos and was correct. HC-SI-2608-001 sits `skipped` in
// scm.autocount_outbox reading "created with no source Delivery Order", and a
// skipped TRANSFER is not re-queueable (acRowIsRequeueable), so it cannot reach
// the account book even once the transfer itself is fixed.
//
// It reads what was WRITTEN — the invoice's own header link and its persisted
// line links — not what the request asked for, so any future caller of POST /
// gets the right answer without having to remember to pass anything.
//
// THREE OUTCOMES, and the boundary between them is the whole safety argument:
//
//   enqueued            every line of this invoice came from a delivery order —
//                       one of them or several. enqueueConvert names those lines
//                       by DtlKey and names every source document they came
//                       from, so AutoCount transfers them and no others.
//                       A fourth outcome, `merged-sources`, used to sit here:
//                       lines from more than one delivery order were recorded
//                       and never sent, because AddPartialTransferDetail refuses
//                       a key array spanning two documents. The TARGET never
//                       did — the service takes `FromDocNos` and groups the keys
//                       per source — so the merge is enqueued like any other.
//   mixed-source-lines  a source exists, but some line came from no delivery at
//                       all. The ERP allows a standalone line on an invoice
//                       (see unlinkedFromDoOffenders); AutoCount's transfer
//                       would produce an invoice MISSING those lines and
//                       understate the revenue in a live account book, so this
//                       is refused rather than approximated.
//   parentless          no source at all. The original claim, now checked.
//
// NOT COVERED, exactly as on POST /from-dos: an edited quantity or price on a
// linked line. AddPartialTransferDetail takes line keys, not amounts, so
// AutoCount bills the delivery order's own figures — the documented limit of
// the SDK (readConvertSourceKeys says so at length) and the approximation the
// mobile path has always shipped on. The alternative is no invoice at all.
// ----------------------------------------------------------------------------
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
  /* Without a resolved company every write below is a no-op — enqueueAcOp
     refuses a null companyId — so there is nothing to decide and no read worth
     making. Named as its own outcome rather than reported as 'parentless':
     "we wrote nothing" and "this invoice has no parent" are different facts. */
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
    /* A READ FAULT IS NOT A VERDICT. Claiming "no source Delivery Order"
       because we could not read the lines is the exact defect this module was
       written to remove, one layer down. Recorded under the compose-failed
       class, whose remedy already says "a read fault, not a refusal". */
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
    /* supabase-js does not throw, so an unbound error here would be
       indistinguishable from "these lines came from nowhere" — and the next
       branch would then record the invoice as parentless on the strength of a
       database blip. The whole point of this module is not to assert an
       unchecked fact. */
    if (srcErr) {
      await skip(`compose failed, nothing sent: could not resolve the Delivery Order behind this invoice's lines (${srcErr.message})`);
      return 'unreadable';
    }
    for (const r of (srcData ?? []) as Array<{ delivery_order_id: string | null }>) {
      if (r.delivery_order_id) doIds.add(r.delivery_order_id);
    }
  }

  if (doIds.size === 0) {
    /* The header link is read only HERE, and only to keep the recorded sentence
       true: an invoice that declares a delivery order but took no line from it
       still has nothing to transfer, and saying "no source Delivery Order"
       about it would be the same unchecked claim in a smaller font. */
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

  /* EVERY delivery order this invoice bills, not the first one.
     `doIds.size > 1` used to be refused here with "AutoCount transfers from ONE
     source document" — a sentence that stopped being true on 2026-08-16, when
     the service learned `FromDocNos`. Taking `[0]` instead would be worse than
     the refusal was: an invoice in the book billing one delivery out of three. */
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
