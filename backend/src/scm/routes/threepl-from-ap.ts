// ----------------------------------------------------------------------------
// /threepl-do-charges/from-ap — fill the 3PL invoices tab FROM the AP invoice
// Finance already keyed (owner 2026-10-23: 「先做」, after 「其实我的ap invoice
// 本身就带有so number 或do number / 所以你要根据我的系统的do 对比supplier charge
// 我的amount对比 / 仓储，搬运不算」).
//
//   GET  /from-ap/invoices              AP invoices with a bill attached, the
//                                       3PL each supplier bills as, and what
//                                       was already brought in from each
//   POST /from-ap/:apInvoiceId/read     { carrierId? } read the attached bill,
//                                       match every line to a DO, price each
//                                       DO on the carrier's rate card — and
//                                       WRITE NOTHING: a person checks first
//   POST /from-ap/:apInvoiceId/confirm  { carrierId, rows: [{ doId, billedSen,
//                                       note }] } save what the person kept
//
// The bill is read by the production bill model (threepl-bill-read.ts); the
// rules — which number is which order, what is not a delivery, a trip's one
// price over its DOs — are threepl-bill-match.ts. Handwriting can be misread
// ("SO" as "80"), so nothing is saved until a person presses Confirm.
//
// Nothing posts to the ledger: the AP invoice already booked the cost; this
// only tallies it per DO. The AP invoice is Finance's (scm.finance.accounting,
// on top of the tab's own area). A 2990 DO is matched too — Houzs delivers
// for 2990 and bills it back (owner 2026-10-23) — and shows its company.
// Reading the same bill again replaces what it brought in, never adds to it;
// a DO another bill already charges on this carrier is shown, not overwritten.
// ----------------------------------------------------------------------------
import { requireActiveCompanyId, scopeToCompanyId, scopeToAllowedCompanies, companyCodeMap } from '../lib/companyScope';
import { chunkIn } from '../lib/paginate-all';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { toBase64 } from '../lib/scan-ocr';
import { BILL_MODEL, MAX_BILL_FILE_BYTES, MAX_FILES_PER_BILL, normalizeVendor, type BillFile } from '../../acc/bill-extract';
import { requestAiTag } from '../../services/aiUsage';
import { orderBookletTokens } from '../../routes/lib/sales-report-evidence';
import { readTransportBill } from '../lib/threepl-bill-read';
import {
  chargeNote, chargesPerDo, foldTrips, lineTotals, matchLines, orderKeys, pickDo,
  type DoCandidate, type OrderKeys,
} from '../lib/threepl-bill-match';
import { loadCarrierCards, loadDoFacts } from '../lib/threepl-charge-load';
import { expectedSen, varianceSen } from '../lib/threepl-do-charge';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client and Hono context, untyped as in every SCM route */
type Row = Record<string, any>;
const str = (v: unknown) => (v == null || v === '' ? null : String(v));

const FINANCE_ONLY = { error: 'forbidden', message: 'Bringing in a 3PL bill reads the AP invoice, which is Finance’s.' };
const mayRead = (c: any) => hasHouzsPerm(c, 'scm.finance.accounting');

/** The 3PL a supplier bills as: the carrier linked to it, else the one whose
 *  name is the supplier's (SDN BHD and punctuation aside). */
function carrierFor(supplierId: string, supplierName: string, carriers: readonly Row[]): string | null {
  const linked = carriers.find((k) => str(k.supplier_id) === supplierId);
  if (linked) return String(linked.id);
  const s = normalizeVendor(supplierName);
  if (!s) return null;
  const same = carriers.find((k) => normalizeVendor(String(k.name ?? '')) === s)
    ?? carriers.find((k) => { const n = normalizeVendor(String(k.name ?? '')); return !!n && (n.includes(s) || s.includes(n)); });
  return same ? String(same.id) : null;
}

async function loadCarriers(sb: any, companyId: number): Promise<{ ok: true; rows: Row[] } | { ok: false; reason: string }> {
  const { data, error } = await scopeToCompanyId(sb.from('threepl_companies').select('id, name, supplier_id, is_active'), companyId).order('name');
  return error ? { ok: false, reason: error.message } : { ok: true, rows: (data ?? []) as Row[] };
}

async function loadApInvoice(c: any, sb: any, companyId: number): Promise<{ inv: Row; supplierName: string } | { resp: Response }> {
  const { data, error } = await scopeToCompanyId(sb.from('ap_invoices')
    .select('id, invoice_number, supplier_invoice_ref, invoice_date, total_sen, status, supplier_id'), companyId)
    .eq('id', c.req.param('apInvoiceId')).maybeSingle();
  if (error) return { resp: c.json({ error: 'load_failed', reason: error.message }, 500) };
  if (!data) return { resp: c.json({ error: 'not_found', message: 'That AP invoice is not in the company you are working in.' }, 404) };
  if (data.status === 'CANCELLED') return { resp: c.json({ error: 'invoice_cancelled', message: `${data.invoice_number} is cancelled.` }, 409) };
  const { data: sup, error: sErr } = await scopeToCompanyId(sb.from('suppliers').select('name'), companyId).eq('id', data.supplier_id).maybeSingle();
  if (sErr) return { resp: c.json({ error: 'load_failed', reason: sErr.message }, 500) };
  return { inv: data as Row, supplierName: String(sup?.name ?? '') };
}

// ── GET /from-ap/invoices ────────────────────────────────────────────────────
export const listApBillsHandler = async (c: any) => {
  if (!mayRead(c)) return c.json(FINANCE_ONLY, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const { data: invRows, error } = await scopeToCompanyId(sb.from('ap_invoices')
    .select('id, invoice_number, supplier_invoice_ref, invoice_date, total_sen, status, supplier_id'), co.companyId)
    .neq('status', 'CANCELLED').order('invoice_date', { ascending: false }).limit(300);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const invs = (invRows ?? []) as Row[];
  const ids = invs.map((r) => String(r.id));
  const supplierIds = [...new Set(invs.map((r) => String(r.supplier_id)))];
  const [files, done, sups, carriers] = await Promise.all([
    chunkIn<Row>(ids, (b, from, to) => scopeToCompanyId(sb.from('acc_ap_invoice_files').select('ap_invoice_id'), co.companyId).in('ap_invoice_id', b).range(from, to)),
    chunkIn<Row>(ids, (b, from, to) => scopeToCompanyId(sb.from('threepl_do_charges').select('ap_invoice_id, billed_sen'), co.companyId).in('ap_invoice_id', b).range(from, to)),
    chunkIn<Row>(supplierIds, (b, from, to) => scopeToCompanyId(sb.from('suppliers').select('id, name'), co.companyId).in('id', b).range(from, to)),
    loadCarriers(sb, co.companyId),
  ]);
  const failed = files.error ?? done.error ?? sups.error;
  if (failed) return c.json({ error: 'load_failed', reason: failed.message }, 500);
  if (!carriers.ok) return c.json({ error: 'load_failed', reason: carriers.reason }, 500);
  const fileCount = new Map<string, number>();
  for (const f of files.data) fileCount.set(String(f.ap_invoice_id), (fileCount.get(String(f.ap_invoice_id)) ?? 0) + 1);
  const brought = new Map<string, { dos: number; sen: number }>();
  for (const d of done.data) {
    const k = String(d.ap_invoice_id);
    const t = brought.get(k) ?? { dos: 0, sen: 0 };
    t.dos += 1; t.sen += Number(d.billed_sen ?? 0);
    brought.set(k, t);
  }
  const supName = new Map(sups.data.map((s) => [String(s.id), String(s.name ?? '')]));
  const invoices = invs.filter((r) => (fileCount.get(String(r.id)) ?? 0) > 0).map((r) => {
    const supplierName = supName.get(String(r.supplier_id)) ?? '';
    return {
      id: String(r.id),
      invoiceNumber: String(r.invoice_number),
      supplierRef: str(r.supplier_invoice_ref),
      invoiceDate: str(r.invoice_date),
      totalSen: Number(r.total_sen ?? 0),
      status: String(r.status),
      supplierId: String(r.supplier_id),
      supplierName,
      files: fileCount.get(String(r.id)) ?? 0,
      broughtInDos: brought.get(String(r.id))?.dos ?? 0,
      broughtInSen: brought.get(String(r.id))?.sen ?? 0,
      carrierId: carrierFor(String(r.supplier_id), supplierName, carriers.rows),
    };
  });
  return c.json({ invoices, carriers: carriers.rows.map((k) => ({ id: String(k.id), name: String(k.name ?? '') })) });
};

/* ── Resolving the printed numbers ───────────────────────────────────────────
   Every SO / DO number and slip the bill names, read in a handful of queries
   across the companies the caller may see (a 2990 DO on a Houzs bill). */
type Resolved = {
  dosByNumber: Map<string, DoCandidate>;
  dosBySo: Map<string, DoCandidate[]>;
  soBySlip: Map<string, string[]>;
  soKnown: Set<string>;
};

const doOf = (d: Row): DoCandidate => ({
  id: String(d.id), doNumber: String(d.do_number), doDate: str(d.do_date)?.slice(0, 10) ?? null,
  soDocNo: str(d.so_doc_no), companyId: Number(d.company_id), customer: str(d.debtor_name),
});
const DO_COLS = 'id, do_number, do_date, so_doc_no, company_id, debtor_name, status';

async function resolveNumbers(c: any, sb: any, keys: readonly OrderKeys[]): Promise<{ ok: true; r: Resolved } | { ok: false; reason: string }> {
  const soNos = [...new Set(keys.flatMap((k) => k.soNos))];
  const doNos = [...new Set(keys.flatMap((k) => k.doNos))];
  const slips = [...new Set(keys.flatMap((k) => k.slips))];
  const sos = await chunkIn<Row>(soNos, (b, from, to) => scopeToAllowedCompanies(sb.from('mfg_sales_orders').select('doc_no, status'), c).in('doc_no', b).range(from, to));
  if (sos.error) return { ok: false, reason: sos.error.message };
  const soKnown = new Set(sos.data.filter((s) => s.status !== 'CANCELLED').map((s) => String(s.doc_no)));
  /* A slip is the order's Ref No. — typed by hand, so read the candidates by
     its digits and keep the orders whose own Ref No. tokens include it. */
  const soBySlip = new Map<string, string[]>();
  for (let i = 0; i < slips.length; i += 8) {
    const batch = slips.slice(i, i + 8);
    const digits = [...new Set(batch.map((t) => t.replace(/\D/g, '')).filter((d) => d.length >= 4))];
    if (!digits.length) continue;
    const { data, error } = await scopeToAllowedCompanies(sb.from('mfg_sales_orders').select('doc_no, status, customer_so_no, ref'), c)
      .or(digits.flatMap((d) => [`customer_so_no.ilike.%${d}%`, `ref.ilike.%${d}%`]).join(','));
    if (error) return { ok: false, reason: error.message };
    for (const so of (data ?? []) as Row[]) {
      if (so.status === 'CANCELLED') continue;
      const tokens = new Set(orderBookletTokens(so));
      for (const t of batch) {
        if (!tokens.has(t)) continue;
        soBySlip.set(t, [...new Set([...(soBySlip.get(t) ?? []), String(so.doc_no)])]);
      }
    }
  }
  const allSos = [...new Set([...soKnown, ...[...soBySlip.values()].flat()])];
  const [byNo, bySo] = await Promise.all([
    chunkIn<Row>(doNos, (b, from, to) => scopeToAllowedCompanies(sb.from('delivery_orders').select(DO_COLS), c).in('do_number', b).range(from, to)),
    chunkIn<Row>(allSos, (b, from, to) => scopeToAllowedCompanies(sb.from('delivery_orders').select(DO_COLS), c).in('so_doc_no', b).range(from, to)),
  ]);
  const err = byNo.error ?? bySo.error;
  if (err) return { ok: false, reason: err.message };
  const dosByNumber = new Map(byNo.data.filter((d) => d.status !== 'CANCELLED').map((d) => [String(d.do_number), doOf(d)] as const));
  const dosBySo = new Map<string, DoCandidate[]>();
  for (const d of bySo.data) {
    if (d.status === 'CANCELLED') continue;
    const k = String(d.so_doc_no);
    dosBySo.set(k, [...(dosBySo.get(k) ?? []), doOf(d)]);
  }
  return { ok: true, r: { dosByNumber, dosBySo, soBySlip, soKnown } };
}

/** The DOs one printed order stands for: its DO number when the system has
 *  it, else each order it names (SO number or slip) → that order's DO dated
 *  nearest the line. */
function resolverFor(r: Resolved) {
  return (k: OrderKeys, lineDate: string | null): DoCandidate[] => {
    const exact = k.doNos.map((n) => r.dosByNumber.get(n)).filter((d): d is DoCandidate => !!d);
    if (exact.length) return exact;
    const orders = [...new Set([...k.soNos.filter((s) => r.soKnown.has(s)), ...k.slips.flatMap((s) => r.soBySlip.get(s) ?? [])])];
    return orders.map((so) => pickDo(r.dosBySo.get(so) ?? [], lineDate)).filter((d): d is DoCandidate => !!d);
  };
}

// ── POST /from-ap/:apInvoiceId/read ─────────────────────────────────────────
export const readApBillHandler = async (c: any) => {
  if (!mayRead(c)) return c.json(FINANCE_ONLY, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  let body: Row = {};
  try { body = await c.req.json(); } catch { /* no body: the carrier is the supplier's */ }
  const got = await loadApInvoice(c, sb, co.companyId);
  if ('resp' in got) return got.resp;
  const { inv, supplierName } = got;

  const { data: fileRows, error: fErr } = await scopeToCompanyId(sb.from('acc_ap_invoice_files')
    .select('file_key, file_name, mime, size_bytes, sort_no'), co.companyId).eq('ap_invoice_id', String(inv.id)).order('sort_no');
  if (fErr) return c.json({ error: 'load_failed', reason: fErr.message }, 500);
  const list = ((fileRows ?? []) as Row[]).slice(0, MAX_FILES_PER_BILL);
  if (list.length === 0) {
    return c.json({ error: 'no_files', message: `${inv.invoice_number} has no bill attached — attach the transport company's bill to the AP invoice first.` }, 409);
  }
  const bucket = (c.env as { SLIPS?: { get: (k: string) => Promise<any> } }).SLIPS;
  if (!bucket) return c.json({ error: 'file_store_missing', message: 'The file store is not configured here — the bill cannot be read.' }, 503);
  const apiKey = c.env?.ANTHROPIC_API_KEY;
  if (!apiKey) return c.json({ error: 'reader_missing', message: 'The bill reader is not configured here.' }, 503);
  const files: BillFile[] = [];
  for (const f of list) {
    if (Number(f.size_bytes ?? 0) > MAX_BILL_FILE_BYTES) continue;
    const obj = await bucket.get(String(f.file_key));
    if (!obj) continue;
    const bytes: ArrayBuffer = typeof obj.arrayBuffer === 'function' ? await obj.arrayBuffer() : await new Response(obj.body).arrayBuffer();
    files.push({ name: String(f.file_name), mime: String(f.mime), dataBase64: toBase64(bytes) });
  }
  if (files.length === 0) return c.json({ error: 'no_files', message: 'The attached bill could not be opened.' }, 409);

  const read = await readTransportBill(apiKey, files, requestAiTag(c, 'threepl_bill_read', BILL_MODEL));
  if (!read.ok) return c.json({ error: 'read_failed', message: read.reason }, 502);

  const carriers = await loadCarriers(sb, co.companyId);
  if (!carriers.ok) return c.json({ error: 'load_failed', reason: carriers.reason }, 500);
  const asked = str(body.carrierId);
  const carrierId = asked && carriers.rows.some((k) => String(k.id) === asked) ? asked : carrierFor(String(inv.supplier_id), supplierName, carriers.rows);

  const keys = read.lines.flatMap((l) => l.orders.map(orderKeys));
  const resolved = await resolveNumbers(c, sb, keys);
  if (!resolved.ok) return c.json({ error: 'load_failed', reason: resolved.reason }, 500);
  const lines = foldTrips(matchLines(read.lines, resolverFor(resolved.r)));
  const dos = new Map<string, DoCandidate>();
  for (const l of lines) for (const d of l.dos) dos.set(d.id, d);

  const [cards, facts] = await Promise.all([
    loadCarrierCards(sb, co.companyId),
    loadDoFacts(c, sb, [...dos.values()].map((d) => ({ id: d.id, soDocNo: d.soDocNo }))),
  ]);
  if (!cards.ok) return c.json({ error: 'load_failed', reason: cards.reason }, 500);
  if (!facts.ok) return c.json({ error: 'load_failed', reason: facts.reason }, 500);
  const spec = carrierId ? cards.cards.specByCarrier.get(carrierId)?.spec ?? null : null;
  const expectedOf = (doId: string): number | null => {
    const f = facts.facts.get(doId);
    return f ? expectedSen(spec, f) : null;
  };
  const charges = chargesPerDo(lines, expectedOf);

  /* A DO another bill (or a hand entry) already charges on this carrier. */
  const elsewhere = new Map<string, { invoiceNo: string | null; billedSen: number }>();
  if (carrierId && charges.length) {
    const prior = await chunkIn<Row>(charges.map((ch) => ch.doId), (b, from, to) => scopeToCompanyId(sb.from('threepl_do_charges')
      .select('do_id, ap_invoice_id, invoice_no, billed_sen'), co.companyId).eq('threepl_company_id', carrierId).in('do_id', b).range(from, to));
    if (prior.error) return c.json({ error: 'load_failed', reason: prior.error.message }, 500);
    for (const p of prior.data) {
      if (str(p.ap_invoice_id) === String(inv.id)) continue;
      elsewhere.set(String(p.do_id), { invoiceNo: str(p.invoice_no), billedSen: Number(p.billed_sen ?? 0) });
    }
  }

  const codes = companyCodeMap(c);
  const apNo = String(inv.invoice_number);
  return c.json({
    invoice: {
      id: String(inv.id), invoiceNumber: apNo, supplierRef: str(inv.supplier_invoice_ref), invoiceDate: str(inv.invoice_date),
      totalSen: Number(inv.total_sen ?? 0), supplierId: String(inv.supplier_id), supplierName,
    },
    carrierId,
    carriers: carriers.rows.map((k) => ({ id: String(k.id), name: String(k.name ?? '') })),
    dos: charges.map((ch) => {
      const d = dos.get(ch.doId)!;
      const expected = expectedOf(ch.doId);
      return {
        doId: ch.doId, doNumber: d.doNumber, doDate: d.doDate, soDocNo: d.soDocNo, customer: d.customer,
        companyCode: codes.get(d.companyId) ?? null,
        billedSen: ch.billedSen, expectedSen: expected, varianceSen: varianceSen(ch.billedSen, expected),
        split: ch.split, lines: ch.lines, note: chargeNote(ch, apNo),
        alreadyOn: elsewhere.get(ch.doId) ?? null,
      };
    }),
    lines: lines.map((l) => ({
      index: l.index, text: l.text, date: l.date, kind: l.kind, amountSen: l.amountSen, printed: l.printed,
      status: l.status, dos: l.dos.map((d) => d.doNumber),
    })),
    totals: lineTotals(lines),
  });
};

// ── POST /from-ap/:apInvoiceId/confirm ──────────────────────────────────────
export const confirmApBillHandler = async (c: any) => {
  if (!mayRead(c)) return c.json(FINANCE_ONLY, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const carrierId = str(body.carrierId);
  const rows = Array.isArray(body.rows) ? (body.rows as Row[]) : null;
  if (!carrierId) return c.json({ error: 'carrier_required', message: 'Choose the 3PL this bill is from.' }, 400);
  if (!rows || rows.length === 0 || rows.length > 500) return c.json({ error: 'rows_required', message: 'Keep 1 to 500 delivery orders.' }, 400);
  const clean = rows.map((r) => ({ doId: str(r.doId), billedSen: Number(r.billedSen), note: str(r.note)?.slice(0, 500) ?? null }));
  if (clean.some((r) => !r.doId || !Number.isInteger(r.billedSen) || r.billedSen < 0)) {
    return c.json({ error: 'invalid_rows', message: 'Each row needs its DO and an amount in sen of 0 or more.' }, 400);
  }
  const doIds = [...new Set(clean.map((r) => r.doId as string))];
  if (doIds.length !== clean.length) return c.json({ error: 'duplicate_do', message: 'A delivery order is on the list twice.' }, 400);

  const got = await loadApInvoice(c, sb, co.companyId);
  if ('resp' in got) return got.resp;
  const { inv } = got;
  const { data: carrier, error: cErr } = await scopeToCompanyId(sb.from('threepl_companies').select('id, supplier_id'), co.companyId).eq('id', carrierId).maybeSingle();
  if (cErr) return c.json({ error: 'load_failed', reason: cErr.message }, 500);
  if (!carrier) return c.json({ error: 'carrier_not_found', message: 'That 3PL is not in the company you are working in.' }, 404);

  const live = await chunkIn<Row>(doIds, (b, from, to) => scopeToAllowedCompanies(sb.from('delivery_orders').select('id, status'), c).in('id', b).range(from, to));
  if (live.error) return c.json({ error: 'load_failed', reason: live.error.message }, 500);
  const liveIds = new Set(live.data.filter((d) => d.status !== 'CANCELLED').map((d) => String(d.id)));
  const gone = doIds.filter((id) => !liveIds.has(id));
  if (gone.length) return c.json({ error: 'do_not_found', message: `${gone.length} delivery order(s) are cancelled or not yours to see.` }, 409);

  /* A DO this carrier already charges on ANOTHER bill (or by hand) stays as
     it is — overwriting it would lose that bill's amount. */
  const prior = await chunkIn<Row>(doIds, (b, from, to) => scopeToCompanyId(sb.from('threepl_do_charges')
    .select('id, do_id, ap_invoice_id, invoice_no'), co.companyId).eq('threepl_company_id', carrierId).in('do_id', b).range(from, to));
  if (prior.error) return c.json({ error: 'load_failed', reason: prior.error.message }, 500);
  const skipped = prior.data.filter((p) => str(p.ap_invoice_id) !== String(inv.id)).map((p) => ({ doId: String(p.do_id), invoiceNo: str(p.invoice_no) }));
  const skip = new Set(skipped.map((s) => s.doId));
  const keep = clean.filter((r) => !skip.has(r.doId as string));

  /* Reading the bill again REPLACES what it brought in: its earlier rows that
     are no longer kept (another DO, another carrier) go. */
  const { data: mine, error: mErr } = await scopeToCompanyId(sb.from('threepl_do_charges').select('id, do_id, threepl_company_id'), co.companyId)
    .eq('ap_invoice_id', String(inv.id));
  if (mErr) return c.json({ error: 'load_failed', reason: mErr.message }, 500);
  const keepIds = new Set(keep.map((r) => r.doId as string));
  const drop = ((mine ?? []) as Row[]).filter((m) => String(m.threepl_company_id) !== carrierId || !keepIds.has(String(m.do_id))).map((m) => String(m.id));
  if (drop.length) {
    const { error: dErr } = await scopeToCompanyId(sb.from('threepl_do_charges').delete(), co.companyId).in('id', drop);
    if (dErr) return c.json({ error: 'save_failed', reason: dErr.message }, 500);
  }
  if (keep.length) {
    const now = new Date().toISOString();
    const { error: uErr } = await sb.from('threepl_do_charges').upsert(keep.map((r) => ({
      company_id: co.companyId,
      do_id: r.doId,
      threepl_company_id: carrierId,
      invoice_no: str(inv.supplier_invoice_ref) ?? String(inv.invoice_number),
      invoice_date: str(inv.invoice_date),
      billed_sen: r.billedSen,
      note: r.note,
      ap_invoice_id: String(inv.id),
      created_by: c.get('houzsUser')?.id ?? null,
      updated_at: now,
    })), { onConflict: 'company_id,do_id,threepl_company_id' });
    if (uErr) return c.json({ error: 'save_failed', reason: uErr.message }, 500);
  }
  /* The next bill from this supplier picks this 3PL by itself. */
  if (!str(carrier.supplier_id)) {
    const { error: lErr } = await scopeToCompanyId(sb.from('threepl_companies').update({ supplier_id: String(inv.supplier_id) }), co.companyId)
      .eq('id', carrierId).is('supplier_id', null);
    if (lErr) return c.json({ error: 'save_failed', reason: lErr.message }, 500);
  }
  return c.json({ saved: keep.length, skipped });
};
