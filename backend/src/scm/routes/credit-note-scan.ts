// ----------------------------------------------------------------------------
// POST /credit-notes/scan — read a supplier's credit note and hand back the
// Supplier Credit Note it should become (owner 2026-10-01: supplier 给我 cn，我要
// 做 ocr for cn；这个 cn 可能会 link 去相对应的 supplier invoice). The paper is
// read by acc/cn-extract.ts; the supplier, the accounts, the amounts and the
// invoice each line credits are decided by scm/lib/scn-scan.ts in plain code.
// NOTHING is written: Finance checks the form, saves the note (POST /credit-notes)
// and posts it — the scan's files are attached to the saved note by the page.
//
//   body  { files: [{ name, mime, dataBase64 }] }   the pages of ONE credit note
//   200   { read, supplier, lines, invoices, suggested, duplicates, notes }
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId, scopeToCompany } from '../lib/companyScope';
import { resolveRoles } from '../../acc/rules';
import { BILL_IMAGE_MIMES, MAX_BILL_FILE_BYTES, MAX_FILES_PER_BILL, matchSupplier, type BillFile } from '../../acc/bill-extract';
import { extractOneCreditNote } from '../../acc/cn-extract';
import { pickCreditedDocs, scnAccountFor, spreadToTotal, type PurchaseDoc } from '../lib/scn-scan';
import { fmtSen } from '../shared/format';

type Row = Record<string, any>;

export const scanSupplierCreditNoteHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.create')) {
    return c.json({ error: "You don't have permission to do that." }, 403);
  }
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const apiKey = c.env?.ANTHROPIC_API_KEY;
  if (!apiKey) return c.json({ error: 'anthropic_key_missing', reason: 'Run: npx wrangler secret put ANTHROPIC_API_KEY' }, 503);

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const raw = Array.isArray(body?.files) ? body.files : [];
  if (raw.length === 0) return c.json({ error: 'no_files', message: 'Send the credit note — a PDF or photos of its pages.' }, 400);
  if (raw.length > MAX_FILES_PER_BILL) {
    return c.json({ error: 'too_many_pages', message: `A credit note takes at most ${MAX_FILES_PER_BILL} pages.` }, 400);
  }
  const files: BillFile[] = [];
  for (const f of raw) {
    const mime = String(f?.mime ?? '');
    if (!BILL_IMAGE_MIMES.has(mime) && mime !== 'application/pdf') {
      return c.json({ error: 'bad_file_type', message: `${mime || 'unknown type'} — JPEG / PNG / WebP / PDF only.` }, 400);
    }
    const dataBase64 = String(f?.dataBase64 ?? '');
    if (!dataBase64 || Math.floor(dataBase64.length * 0.75) > MAX_BILL_FILE_BYTES) {
      return c.json({ error: 'file_too_big', message: `A file is empty or over ${Math.round(MAX_BILL_FILE_BYTES / 1024 / 1024)}MB.` }, 400);
    }
    files.push({ name: String(f?.name ?? 'credit-note'), mime, dataBase64 });
  }

  const read = await extractOneCreditNote(apiKey, files);
  if (!read.ok) return c.json({ error: 'read_failed', message: read.reason }, 502);
  const ex = read.extraction;
  const sb = c.get('supabase');

  /* The issuer, among the company's active suppliers — in code, never the model. */
  const { data: supRaw, error: supErr } = await scopeToCompany(sb.from('suppliers').select('id, code, name').eq('status', 'ACTIVE'), c);
  if (supErr) return c.json({ error: 'load_failed', reason: supErr.message }, 500);
  const match = matchSupplier(ex.vendorName, (supRaw ?? []) as Array<{ id: string; code: string | null; name: string }>);

  /* The owner's accounts, where this company's chart has them active. */
  const roles = await resolveRoles(sb, co.companyId);
  const proposed = ex.lines.map((l) => scnAccountFor(l.description, ex.remark));
  const codes = [...new Set([...proposed.filter((p) => p != null).map((p) => p!.code), roles.PURCHASE_RETURNS])];
  const { data: acctRaw, error: acctErr } = await sb.from('accounts').select('account_code, account_name, is_active')
    .eq('company_id', co.companyId).in('account_code', codes);
  if (acctErr) return c.json({ error: 'load_failed', reason: acctErr.message }, 500);
  const active = new Map(((acctRaw ?? []) as Row[]).filter((a) => a.is_active !== false).map((a) => [String(a.account_code), String(a.account_name ?? '')]));

  /* The amounts the note credits: as printed, grown to the printed total when
     the paper adds tax on top (scn-scan.ts spreadToTotal). */
  const amounts = spreadToTotal(ex.lines.map((l) => l.amountSen ?? 0), ex.totalSen);

  /* The documents the note credits: this supplier's purchase invoices and AP
     invoices keyed with an invoice number the note prints. */
  const docs: PurchaseDoc[] = [];
  if (match && ex.invoiceNumbers.length > 0) {
    const supplierId = match.supplier.id;
    const [pis, apis] = await Promise.all([
      sb.from('purchase_invoices').select('id, invoice_number, supplier_invoice_ref, invoice_date, total_sen, paid_sen, status')
        .eq('company_id', co.companyId).eq('supplier_id', supplierId).in('supplier_invoice_ref', ex.invoiceNumbers),
      sb.from('ap_invoices').select('id, invoice_number, supplier_invoice_ref, invoice_date, total_sen, paid_sen, status')
        .eq('company_id', co.companyId).eq('supplier_id', supplierId).in('supplier_invoice_ref', ex.invoiceNumbers),
    ]);
    const dErr = pis.error ?? apis.error;
    if (dErr) return c.json({ error: 'load_failed', reason: dErr.message }, 500);
    const piRows = ((pis.data ?? []) as Row[]).filter((r) => r.status !== 'CANCELLED');
    const apiRows = ((apis.data ?? []) as Row[]).filter((r) => r.status !== 'CANCELLED');
    const itemsBy = new Map<string, string[]>();
    if (piRows.length > 0) {
      const { data: items, error: iErr } = await sb.from('purchase_invoice_items')
        .select('purchase_invoice_id, item_code, material_name, description').eq('company_id', co.companyId).in('purchase_invoice_id', piRows.map((r) => r.id));
      if (iErr) return c.json({ error: 'load_failed', reason: iErr.message }, 500);
      for (const it of (items ?? []) as Row[]) {
        const k = String(it.purchase_invoice_id);
        itemsBy.set(k, [...(itemsBy.get(k) ?? []), [it.item_code, it.material_name, it.description].filter(Boolean).join(' ')]);
      }
    }
    if (apiRows.length > 0) {
      const { data: lines, error: lErr } = await sb.from('ap_invoice_lines')
        .select('ap_invoice_id, description').eq('company_id', co.companyId).in('ap_invoice_id', apiRows.map((r) => r.id));
      if (lErr) return c.json({ error: 'load_failed', reason: lErr.message }, 500);
      for (const l of (lines ?? []) as Row[]) {
        const k = String(l.ap_invoice_id);
        itemsBy.set(k, [...(itemsBy.get(k) ?? []), String(l.description ?? '')]);
      }
    }
    const asDoc = (kind: 'PI' | 'API') => (r: Row): PurchaseDoc => ({
      kind, id: String(r.id), number: String(r.invoice_number), invoiceRef: r.supplier_invoice_ref ?? null,
      invoiceDate: r.invoice_date ?? null, totalSen: Number(r.total_sen ?? 0), paidSen: Number(r.paid_sen ?? 0),
      status: String(r.status), itemTexts: itemsBy.get(String(r.id)) ?? [],
    });
    docs.push(...piRows.map(asDoc('PI')), ...apiRows.map(asDoc('API')));
  }
  const picks = pickCreditedDocs(ex.lines.map((l) => ({ text: [l.itemCode, l.description].filter(Boolean).join(' '), invoiceNo: l.invoiceNo })), docs, ex.invoiceNumbers);

  /* The same paper recorded before (owner 2026-10-01: same bill is said, never blocked). */
  let duplicates: Array<{ noteNumber: string; status: string }> = [];
  if (match && ex.cnNumber) {
    const { data: dup, error: dupErr } = await sb.from('acc_credit_notes').select('note_number, status')
      .eq('company_id', co.companyId).eq('kind', 'SCN').eq('supplier_id', match.supplier.id).eq('source_doc_no', ex.cnNumber);
    if (dupErr) return c.json({ error: 'load_failed', reason: dupErr.message }, 500);
    duplicates = ((dup ?? []) as Row[]).filter((d) => d.status !== 'CANCELLED').map((d) => ({ noteNumber: String(d.note_number), status: String(d.status) }));
  }

  const notes: string[] = [];
  if (!ex.isCreditNote) notes.push('This paper does not read as a credit note — check it before saving.');
  if (!match) notes.push(ex.vendorName ? `The issuer "${ex.vendorName}" is not one of the suppliers here — pick the supplier.` : 'The issuer could not be read — pick the supplier.');
  if ((ex.sstSen ?? 0) > 0 && ex.totalSen != null && amounts.reduce((s, a) => s + a, 0) === ex.totalSen) {
    notes.push(`SST ${fmtSen(ex.sstSen ?? 0)} is spread over the lines — the purchase was booked with its SST.`);
  }
  if (match && ex.invoiceNumbers.length > 0 && docs.length === 0) {
    notes.push(`${ex.invoiceNumbers.join(', ')} is not a purchase invoice or AP invoice of ${match.supplier.name} here.`);
  }
  for (const d of duplicates) notes.push(`${ex.cnNumber} is already recorded as ${d.noteNumber} (${d.status.toLowerCase()}).`);

  return c.json({
    ok: true,
    read: {
      isCreditNote: ex.isCreditNote, vendorName: ex.vendorName, vendorRegNo: ex.vendorRegNo, cnNumber: ex.cnNumber, cnDate: ex.cnDate,
      invoiceNumbers: ex.invoiceNumbers, subtotalSen: ex.subtotalSen, sstSen: ex.sstSen, totalSen: ex.totalSen, remark: ex.remark,
    },
    supplier: match ? { id: match.supplier.id, code: match.supplier.code, name: match.supplier.name, confidence: match.confidence } : null,
    lines: ex.lines.map((l, i) => {
      const rule = proposed[i];
      const code = rule && active.has(rule.code) ? rule.code : null;
      return {
        description: [l.description, l.invoiceNo ? `inv. ${l.invoiceNo}` : null].filter(Boolean).join(' · ') || null,
        itemCode: l.itemCode, qty: l.qty, printedSen: l.amountSen, amountSen: amounts[i] ?? 0,
        accountCode: code, accountName: code ? active.get(code) ?? null : null, rule: code ? rule!.label : null,
        creditsDocId: picks.perLine[i] ?? null,
      };
    }),
    invoices: docs.map(({ itemTexts: _items, ...d }) => ({ ...d, outstandingSen: Math.max(0, d.totalSen - d.paidSen) })),
    suggested: picks.suggested ? { kind: picks.suggested.kind, id: picks.suggested.id, number: picks.suggested.number } : null,
    duplicates,
    notes,
  });
};
