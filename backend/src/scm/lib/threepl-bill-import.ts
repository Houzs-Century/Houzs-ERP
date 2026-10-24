// ----------------------------------------------------------------------------
// threepl-bill-import — read a transport bill off its AP invoice and KEEP it:
// every line, where it went, and the per-DO charges the DO lines make (owner
// 2026-10-24: 「做，好了叫我」 on — 自动读 · 手动还是要保留 · 对不上的 … 我想要assign
// 看这个是去哪里，可能是service, 可能是setup dismantle，可能不算).
//
// No Hono context here: the routes (scm/routes/threepl-from-ap.ts) and the */30
// cron (autoReadBills) share it. The caller says which company pays (the AP
// invoice's) and which companies' DOs a bill may name — a request's allowed
// companies, every company in the cron (Houzs delivers for 2990).
//
//   readBill          files → the reader → lines matched to DOs, priced on the
//                     3PL's rate card. Writes NOTHING (the preview).
//   saveBill          a reading kept: its lines replace the bill's earlier
//                     ones, the DO charges are summed from its DO lines, the
//                     read is logged (which files it saw) and the 3PL learns
//                     its supplier.
//   rederiveCharges   a line re-assigned: the bill's DO charges summed again.
//                     A DO amount a person corrected keeps that amount.
//   autoReadBills     the cron: each company's AP invoices from a 3PL supplier
//                     with a bill attached that no reading has seen yet — or
//                     whose files changed since — read and kept, four a run. A
//                     line a person had assigned keeps their choice; a
//                     cancelled AP invoice's bill stops counting.
//
// A DO another bill (or a hand entry) already charges on that 3PL is left as it
// is. Nothing posts to the ledger: the AP invoice already booked the cost.
// ----------------------------------------------------------------------------
import { BILL_MODEL, MAX_BILL_FILE_BYTES, MAX_FILES_PER_BILL, normalizeVendor, type BillFile } from '../../acc/bill-extract';
import { getSupabaseService } from '../../db/supabase';
import type { AiUsageTag } from '../../services/aiUsage';
import type { Env } from '../env';
import { orderBookletTokens } from '../../routes/lib/sales-report-evidence';
import { chunkIn, paginateAll } from './paginate-all';
import { scopeToCompanyId } from './companyScope';
import { toBase64 } from './scan-ocr';
import { readTransportBill } from './threepl-bill-read';
import {
  billBreakdown, chargeNote, chargesPerDo, foldTrips, matchLines, orderKeys, pickDo, preselect,
  type Assignment, type DoCandidate, type LineAssign, type MatchedLine, type OrderKeys,
} from './threepl-bill-match';
import { loadCarrierCards, loadDoFacts, type CompanyScopeFn } from './threepl-charge-load';
import { expectedSen } from './threepl-do-charge';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped as in every SCM lib */
type Row = Record<string, any>;
const str = (v: unknown) => (v == null || v === '' ? null : String(v));
/** A real calendar day or null — a misread "2026-13-45" must not sink the whole bill. */
const dayOrNull = (v: string | null): string | null => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
};

export type BillDeps = {
  sb: any;
  /** The paying company — the AP invoice's. */
  companyId: number;
  /** The companies whose DOs a bill may name. */
  allowedIds: readonly number[];
  bucket?: { get(k: string): Promise<any> };
  apiKey?: string;
  usage: AiUsageTag | null;
};
export type BillFail = { ok: false; status: 400 | 404 | 409 | 500 | 502 | 503; error: string; message: string };
const fail = (status: BillFail['status'], error: string, message: string): BillFail => ({ ok: false, status, error, message });

const scopeOf = (deps: BillDeps): CompanyScopeFn => (q) => (q as any).in('company_id', [...deps.allowedIds]);

/** The paying company's 3PLs, with the supplier each bills as. */
export async function loadCarriers(sb: any, companyId: number): Promise<{ ok: true; rows: Row[] } | { ok: false; reason: string }> {
  const { data, error } = await scopeToCompanyId(sb.from('threepl_companies').select('id, name, supplier_id, is_active'), companyId).order('name');
  return error ? { ok: false, reason: error.message } : { ok: true, rows: (data ?? []) as Row[] };
}

/** The 3PL a supplier bills as: the one linked to it, else the one whose name
 *  is the supplier's (SDN BHD and punctuation aside). */
export function carrierFor(supplierId: string, supplierName: string, carriers: readonly Row[]): string | null {
  const linked = carriers.find((k) => str(k.supplier_id) === supplierId);
  if (linked) return String(linked.id);
  const s = normalizeVendor(supplierName);
  if (!s) return null;
  const same = carriers.find((k) => normalizeVendor(String(k.name ?? '')) === s)
    ?? carriers.find((k) => { const n = normalizeVendor(String(k.name ?? '')); return !!n && (n.includes(s) || s.includes(n)); });
  return same ? String(same.id) : null;
}

export type ApBill = { inv: Row; supplierName: string };

export async function loadApBill(deps: BillDeps, apInvoiceId: string): Promise<({ ok: true } & ApBill) | BillFail> {
  const { sb, companyId } = deps;
  const { data, error } = await scopeToCompanyId(sb.from('ap_invoices')
    .select('id, invoice_number, supplier_invoice_ref, invoice_date, total_sen, status, supplier_id'), companyId)
    .eq('id', apInvoiceId).maybeSingle();
  if (error) return fail(500, 'load_failed', error.message);
  if (!data) return fail(404, 'not_found', 'That AP invoice is not in the company you are working in.');
  if (data.status === 'CANCELLED') return fail(409, 'invoice_cancelled', `${data.invoice_number} is cancelled.`);
  const { data: sup, error: sErr } = await scopeToCompanyId(sb.from('suppliers').select('name'), companyId).eq('id', data.supplier_id).maybeSingle();
  if (sErr) return fail(500, 'load_failed', sErr.message);
  return { ok: true, inv: data as Row, supplierName: String(sup?.name ?? '') };
}

/** Which files a reading saw: how many, and the newest. */
export type FileStamp = { count: number; latest: string | null };

/** The AP invoice's files as they stand now — what a person's Save saw. */
export async function fileStampOf(deps: BillDeps, inv: Row): Promise<{ ok: true; stamp: FileStamp } | BillFail> {
  const { data, error } = await scopeToCompanyId(deps.sb.from('acc_ap_invoice_files').select('created_at'), deps.companyId).eq('ap_invoice_id', String(inv.id));
  if (error) return fail(500, 'load_failed', error.message);
  const rows = (data ?? []) as Row[];
  return { ok: true, stamp: { count: rows.length, latest: rows.reduce<string | null>((m, r) => (str(r.created_at) && (!m || String(r.created_at) > m) ? String(r.created_at) : m), null) } };
}

async function loadBillFiles(deps: BillDeps, inv: Row): Promise<{ ok: true; files: BillFile[]; stamp: FileStamp } | BillFail> {
  const { sb, companyId } = deps;
  const { data: fileRows, error } = await scopeToCompanyId(sb.from('acc_ap_invoice_files')
    .select('file_key, file_name, mime, size_bytes, sort_no, created_at'), companyId).eq('ap_invoice_id', String(inv.id)).order('sort_no');
  if (error) return fail(500, 'load_failed', error.message);
  const rows = (fileRows ?? []) as Row[];
  const stamp: FileStamp = { count: rows.length, latest: rows.reduce<string | null>((m, r) => (str(r.created_at) && (!m || String(r.created_at) > m) ? String(r.created_at) : m), null) };
  if (rows.length === 0) return fail(409, 'no_files', `${inv.invoice_number} has no bill attached — attach the transport company's bill to the AP invoice first.`);
  if (!deps.bucket) return fail(503, 'file_store_missing', 'The file store is not configured here — the bill cannot be read.');
  const files: BillFile[] = [];
  for (const f of rows.slice(0, MAX_FILES_PER_BILL)) {
    if (Number(f.size_bytes ?? 0) > MAX_BILL_FILE_BYTES) continue;
    const obj = await deps.bucket.get(String(f.file_key));
    if (!obj) continue;
    const bytes: ArrayBuffer = typeof obj.arrayBuffer === 'function' ? await obj.arrayBuffer() : await new Response(obj.body).arrayBuffer();
    files.push({ name: String(f.file_name), mime: String(f.mime), dataBase64: toBase64(bytes) });
  }
  if (files.length === 0) return fail(409, 'no_files', 'The attached bill could not be opened.');
  return { ok: true, files, stamp };
}

/* ── Resolving the printed numbers ───────────────────────────────────────────
   Every SO / DO number and slip the bill names, read in a handful of queries
   across the companies the bill may name. */
type Resolved = { dosByNumber: Map<string, DoCandidate>; dosBySo: Map<string, DoCandidate[]>; soBySlip: Map<string, string[]>; soKnown: Set<string> };
const DO_COLS = 'id, do_number, do_date, so_doc_no, company_id, debtor_name, status';
export const doOf = (d: Row): DoCandidate => ({
  id: String(d.id), doNumber: String(d.do_number), doDate: str(d.do_date)?.slice(0, 10) ?? null,
  soDocNo: str(d.so_doc_no), companyId: Number(d.company_id), customer: str(d.debtor_name),
});

async function resolveNumbers(deps: BillDeps, keys: readonly OrderKeys[]): Promise<{ ok: true; r: Resolved } | { ok: false; reason: string }> {
  const { sb } = deps;
  const scope = scopeOf(deps);
  const soNos = [...new Set(keys.flatMap((k) => k.soNos))];
  const doNos = [...new Set(keys.flatMap((k) => k.doNos))];
  const slips = [...new Set(keys.flatMap((k) => k.slips))];
  const sos = await chunkIn<Row>(soNos, (b, from, to) => scope(sb.from('mfg_sales_orders').select('doc_no, status')).in('doc_no', b).range(from, to));
  if (sos.error) return { ok: false, reason: sos.error.message };
  const soKnown = new Set(sos.data.filter((s) => s.status !== 'CANCELLED').map((s) => String(s.doc_no)));
  /* A slip is the order's Ref No. — typed by hand, so read the candidates by
     its digits and keep the orders whose own Ref No. tokens include it. */
  const soBySlip = new Map<string, string[]>();
  for (let i = 0; i < slips.length; i += 8) {
    const batch = slips.slice(i, i + 8);
    const digits = [...new Set(batch.map((t) => t.replace(/\D/g, '')).filter((d) => d.length >= 4))];
    if (!digits.length) continue;
    const { data, error } = await scope(sb.from('mfg_sales_orders').select('doc_no, status, customer_so_no, ref'))
      .or(digits.flatMap((d) => [`customer_so_no.ilike.%${d}%`, `ref.ilike.%${d}%`]).join(','));
    if (error) return { ok: false, reason: error.message };
    for (const so of (data ?? []) as Row[]) {
      if (so.status === 'CANCELLED') continue;
      const tokens = new Set(orderBookletTokens(so));
      for (const t of batch) if (tokens.has(t)) soBySlip.set(t, [...new Set([...(soBySlip.get(t) ?? []), String(so.doc_no)])]);
    }
  }
  const allSos = [...new Set([...soKnown, ...[...soBySlip.values()].flat()])];
  const [byNo, bySo] = await Promise.all([
    chunkIn<Row>(doNos, (b, from, to) => scope(sb.from('delivery_orders').select(DO_COLS)).in('do_number', b).range(from, to)),
    chunkIn<Row>(allSos, (b, from, to) => scope(sb.from('delivery_orders').select(DO_COLS)).in('so_doc_no', b).range(from, to)),
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

/** The rate card amount of each DO on one 3PL's card (null without a card). */
async function pricer(deps: BillDeps, carrierId: string | null, dos: readonly DoCandidate[]): Promise<{ ok: true; expectedOf: (doId: string) => number | null } | { ok: false; reason: string }> {
  const [cards, facts] = await Promise.all([
    loadCarrierCards(deps.sb, deps.companyId),
    loadDoFacts(scopeOf(deps), deps.sb, dos.map((d) => ({ id: d.id, soDocNo: d.soDocNo }))),
  ]);
  if (!cards.ok) return cards;
  if (!facts.ok) return facts;
  const spec = carrierId ? cards.cards.specByCarrier.get(carrierId)?.spec ?? null : null;
  return { ok: true, expectedOf: (doId) => { const f = facts.facts.get(doId); return f ? expectedSen(spec, f) : null; } };
}

/** The AP invoice's own lines: their amounts and fairs, for the setup /
 *  dismantle a bill line names (preselect). */
async function apLinesOf(deps: BillDeps, inv: Row): Promise<{ ok: true; rows: Array<{ amountSen: number | null; projectId: number | null }> } | { ok: false; reason: string }> {
  const { data, error } = await scopeToCompanyId(deps.sb.from('ap_invoice_lines').select('amount_sen, project_id'), deps.companyId).eq('invoice_id', String(inv.id));
  if (error) return { ok: false, reason: error.message };
  return { ok: true, rows: ((data ?? []) as Row[]).map((l) => ({ amountSen: l.amount_sen == null ? null : Number(l.amount_sen), projectId: l.project_id == null ? null : Number(l.project_id) })) };
}

export type BillReading = {
  carrierId: string | null;
  carriers: Row[];
  lines: MatchedLine[];
  /** Each line's assignment as the reader sees it. */
  assignments: Assignment[];
  dos: Map<string, DoCandidate>;
  expectedOf: (doId: string) => number | null;
  /** DOs another bill or a hand entry already charges on this 3PL. */
  elsewhere: Map<string, { invoiceNo: string | null; billedSen: number }>;
  stamp: FileStamp;
};

/** Read the bill attached to an AP invoice and match it. Writes NOTHING. */
export async function readBill(deps: BillDeps, bill: ApBill, askedCarrierId: string | null): Promise<({ ok: true } & BillReading) | BillFail> {
  const { inv, supplierName } = bill;
  const files = await loadBillFiles(deps, inv);
  if (!files.ok) return files;
  if (!deps.apiKey) return fail(503, 'reader_missing', 'The bill reader is not configured here.');
  const read = await readTransportBill(deps.apiKey, files.files, deps.usage);
  if (!read.ok) return fail(502, 'read_failed', read.reason);

  const carriers = await loadCarriers(deps.sb, deps.companyId);
  if (!carriers.ok) return fail(500, 'load_failed', carriers.reason);
  const carrierId = askedCarrierId && carriers.rows.some((k) => String(k.id) === askedCarrierId)
    ? askedCarrierId : carrierFor(String(inv.supplier_id), supplierName, carriers.rows);

  const resolved = await resolveNumbers(deps, read.lines.flatMap((l) => l.orders.map(orderKeys)));
  if (!resolved.ok) return fail(500, 'load_failed', resolved.reason);
  const lines = foldTrips(matchLines(read.lines, resolverFor(resolved.r)));
  const dos = new Map<string, DoCandidate>();
  for (const l of lines) for (const d of l.dos) dos.set(d.id, d);
  const [priced, apLines] = await Promise.all([pricer(deps, carrierId, [...dos.values()]), apLinesOf(deps, inv)]);
  if (!priced.ok) return fail(500, 'load_failed', priced.reason);
  if (!apLines.ok) return fail(500, 'load_failed', apLines.reason);

  const elsewhere = new Map<string, { invoiceNo: string | null; billedSen: number }>();
  if (carrierId && dos.size) {
    const prior = await chunkIn<Row>([...dos.keys()], (b, from, to) => scopeToCompanyId(deps.sb.from('threepl_do_charges')
      .select('do_id, ap_invoice_id, invoice_no, billed_sen'), deps.companyId).eq('threepl_company_id', carrierId).in('do_id', b).range(from, to));
    if (prior.error) return fail(500, 'load_failed', prior.error.message);
    for (const p of prior.data) {
      if (str(p.ap_invoice_id) === String(inv.id)) continue;
      elsewhere.set(String(p.do_id), { invoiceNo: str(p.invoice_no), billedSen: Number(p.billed_sen ?? 0) });
    }
  }
  return {
    ok: true, carrierId, carriers: carriers.rows, lines,
    assignments: lines.map((l) => preselect(l, apLines.rows)),
    dos, expectedOf: priced.expectedOf, elsewhere, stamp: files.stamp,
  };
}

/** One line as kept. */
export type KeptLine = {
  lineNo: number; text: string; date: string | null; kind: string; amountSen: number | null;
  printed: string[]; readStatus: string; assignment: Assignment;
  /** Who put the line where it is, when not the saver (a person's choice kept through a re-read). */
  assignedBy?: string | null; assignedAt?: string | null;
};

/** A reading kept: its lines REPLACE the bill's earlier ones, the DO charges
 *  are summed from its DO lines (a DO amount the person typed in wins and is
 *  remembered as theirs), the read is logged and the 3PL learns its supplier. */
export async function saveBill(deps: BillDeps, bill: ApBill, args: {
  carrierId: string;
  lines: readonly KeptLine[];
  stamp: FileStamp;
  readBy: 'auto' | 'person';
  /** Who assigned what the reader did not ('auto' for the cron). */
  actor: string;
  /** DO amounts the person corrected, by DO id. */
  doAmounts?: ReadonlyMap<string, number>;
}): Promise<{ ok: true; saved: number; skipped: Array<{ doId: string; invoiceNo: string | null }> } | BillFail> {
  const { sb, companyId } = deps;
  const { inv } = bill;
  const now = new Date().toISOString();
  const { error: dErr } = await scopeToCompanyId(sb.from('threepl_bill_lines').delete(), companyId).eq('ap_invoice_id', String(inv.id));
  if (dErr) return fail(500, 'save_failed', dErr.message);
  if (args.lines.length) {
    const { error: iErr } = await sb.from('threepl_bill_lines').insert(args.lines.map((l) => ({
      company_id: companyId, ap_invoice_id: String(inv.id), threepl_company_id: args.carrierId,
      line_no: l.lineNo, text: l.text.slice(0, 300), line_date: dayOrNull(l.date), kind: l.kind, amount_sen: l.amountSen,
      printed: l.printed.slice(0, 40), read_status: l.readStatus,
      assign: l.assignment.assign, do_ids: l.assignment.doIds, service_ref: l.assignment.serviceRef, project_id: l.assignment.projectId,
      assigned_by: l.assignment.assign ? l.assignedBy ?? args.actor : null, assigned_at: l.assignment.assign ? l.assignedAt ?? now : null,
      updated_at: now,
    })));
    if (iErr) return fail(500, 'save_failed', iErr.message);
  }
  const charges = await rederiveCharges(deps, bill, args.carrierId, args.doAmounts);
  if (!charges.ok) return charges;
  /* The next bill from this supplier picks this 3PL by itself. */
  const { data: carrier, error: cErr } = await scopeToCompanyId(sb.from('threepl_companies').select('id, supplier_id'), companyId).eq('id', args.carrierId).maybeSingle();
  if (cErr) return fail(500, 'save_failed', cErr.message);
  if (carrier && !str(carrier.supplier_id)) {
    const { error: lErr } = await scopeToCompanyId(sb.from('threepl_companies').update({ supplier_id: String(inv.supplier_id) }), companyId)
      .eq('id', args.carrierId).is('supplier_id', null);
    if (lErr) return fail(500, 'save_failed', lErr.message);
  }
  const logged = await logRead(deps, inv, { carrierId: args.carrierId, readBy: args.readBy, stamp: args.stamp, error: null });
  if (!logged.ok) return logged;
  return charges;
}

/** The read log: which files a reading saw, so a file added later is read again. */
export async function logRead(deps: BillDeps, inv: Row, r: { carrierId: string | null; readBy: 'auto' | 'person'; stamp: FileStamp; error: string | null; attempts?: number }): Promise<{ ok: true } | BillFail> {
  const { error } = await deps.sb.from('threepl_bill_reads').upsert({
    ap_invoice_id: String(inv.id), company_id: deps.companyId, threepl_company_id: r.carrierId, read_by: r.readBy,
    files_count: r.stamp.count, files_latest: r.stamp.latest, attempts: r.attempts ?? 0, error: r.error?.slice(0, 300) ?? null,
    read_at: new Date().toISOString(),
  }, { onConflict: 'ap_invoice_id' });
  return error ? fail(500, 'save_failed', error.message) : { ok: true };
}

/** The bill's DO charges summed again from its DO lines: one row per DO on the
 *  bill's 3PL, against the AP invoice. A DO no DO line names any more goes; a
 *  DO another bill or a hand entry charges is left as it is; an amount the
 *  person corrected stays theirs (billed_by_hand). */
export async function rederiveCharges(deps: BillDeps, bill: ApBill, carrierId: string, doAmounts?: ReadonlyMap<string, number>): Promise<{ ok: true; saved: number; skipped: Array<{ doId: string; invoiceNo: string | null }> } | BillFail> {
  const { sb, companyId } = deps;
  const { inv } = bill;
  const { data: lineRows, error: lErr } = await scopeToCompanyId(sb.from('threepl_bill_lines')
    .select('line_no, text, amount_sen, printed, assign, do_ids'), companyId).eq('ap_invoice_id', String(inv.id)).order('line_no');
  if (lErr) return fail(500, 'load_failed', lErr.message);
  const doLines = ((lineRows ?? []) as Row[]).filter((l) => l.assign === 'do' && Array.isArray(l.do_ids) && l.do_ids.length > 0);
  const doIds = [...new Set(doLines.flatMap((l) => (l.do_ids as unknown[]).map(String)))];
  const dos = await chunkIn<Row>(doIds, (b, from, to) => scopeOf(deps)(sb.from('delivery_orders').select(DO_COLS)).in('id', b).range(from, to));
  if (dos.error) return fail(500, 'load_failed', dos.error.message);
  const live = new Map(dos.data.filter((d) => d.status !== 'CANCELLED').map((d) => [String(d.id), doOf(d)] as const));
  const priced = await pricer(deps, carrierId, [...live.values()]);
  if (!priced.ok) return fail(500, 'load_failed', priced.reason);
  const asMatched: MatchedLine[] = doLines.map((l) => ({
    index: Number(l.line_no), text: String(l.text ?? ''), date: null, kind: 'delivery', amountSen: l.amount_sen == null ? null : Number(l.amount_sen),
    printed: (l.printed as string[] | null) ?? [], status: 'matched',
    dos: (l.do_ids as unknown[]).map(String).map((id) => live.get(id)).filter((d): d is DoCandidate => !!d),
  }));
  const charges = chargesPerDo(asMatched, priced.expectedOf);

  const [mine, prior] = await Promise.all([
    scopeToCompanyId(sb.from('threepl_do_charges').select('id, do_id, threepl_company_id, billed_sen, billed_by_hand'), companyId).eq('ap_invoice_id', String(inv.id)),
    chunkIn<Row>(charges.map((ch) => ch.doId), (b, from, to) => scopeToCompanyId(sb.from('threepl_do_charges')
      .select('do_id, ap_invoice_id, invoice_no'), companyId).eq('threepl_company_id', carrierId).in('do_id', b).range(from, to)),
  ]);
  if (mine.error) return fail(500, 'load_failed', mine.error.message);
  if (prior.error) return fail(500, 'load_failed', prior.error.message);
  const skipped = prior.data.filter((p) => str(p.ap_invoice_id) !== String(inv.id)).map((p) => ({ doId: String(p.do_id), invoiceNo: str(p.invoice_no) }));
  const skip = new Set(skipped.map((s) => s.doId));
  const keep = charges.filter((ch) => !skip.has(ch.doId));
  const keepIds = new Set(keep.map((ch) => ch.doId));
  const mineRows = (mine.data ?? []) as Row[];
  const drop = mineRows.filter((m) => String(m.threepl_company_id) !== carrierId || !keepIds.has(String(m.do_id))).map((m) => String(m.id));
  if (drop.length) {
    const { error } = await scopeToCompanyId(sb.from('threepl_do_charges').delete(), companyId).in('id', drop);
    if (error) return fail(500, 'save_failed', error.message);
  }
  if (keep.length) {
    const byHand = new Map(mineRows.filter((m) => m.billed_by_hand === true && String(m.threepl_company_id) === carrierId).map((m) => [String(m.do_id), Number(m.billed_sen ?? 0)] as const));
    const now = new Date().toISOString();
    const { error } = await sb.from('threepl_do_charges').upsert(keep.map((ch) => {
      const typed = doAmounts?.get(ch.doId);
      const hand = typed != null ? typed !== ch.billedSen : byHand.has(ch.doId);
      return {
        company_id: companyId, do_id: ch.doId, threepl_company_id: carrierId,
        invoice_no: str(inv.supplier_invoice_ref) ?? String(inv.invoice_number), invoice_date: str(inv.invoice_date),
        billed_sen: typed ?? byHand.get(ch.doId) ?? ch.billedSen, billed_by_hand: hand,
        note: chargeNote(ch, String(inv.invoice_number)), ap_invoice_id: String(inv.id), updated_at: now,
      };
    }), { onConflict: 'company_id,do_id,threepl_company_id' });
    if (error) return fail(500, 'save_failed', error.message);
  }
  return { ok: true, saved: keep.length, skipped };
}

/** A reading turned into the lines to keep, with the reader's assignments. */
export function keptLines(reading: Pick<BillReading, 'lines' | 'assignments'>): KeptLine[] {
  return reading.lines.map((l, i) => ({
    lineNo: i + 1, text: l.text, date: l.date, kind: l.kind, amountSen: l.amountSen, printed: l.printed,
    readStatus: l.status, assignment: reading.assignments[i]!,
  }));
}

export const AUTO_READS_PER_RUN = 4;
const AUTO_ATTEMPTS = 3;
/** The companies the cron reads bills for: Houzs Century (1) and 2990 (2), the
 *  two tenants (as MRP_REFRESH_COMPANY_IDS). Either may name the other's DOs. */
export const AUTO_READ_COMPANY_IDS: readonly number[] = [1, 2];

/** The bills of ONE company the cron should read now: an AP invoice from a
 *  supplier that is a 3PL, not cancelled, with a bill attached, that no reading
 *  has seen — or whose files changed since (BRIGHTSUN's goods list attached
 *  later). A bill that failed three times waits for its files to change; one a
 *  person brought in before readings were logged is theirs and left alone. */
export async function billsToRead(deps: BillDeps): Promise<{ ok: true; ids: string[] } | { ok: false; reason: string }> {
  const { sb, companyId } = deps;
  const carriers = await loadCarriers(sb, companyId);
  if (!carriers.ok) return carriers;
  if (carriers.rows.length === 0) return { ok: true, ids: [] };
  const sups = await paginateAll<Row>((from, to) => scopeToCompanyId(sb.from('suppliers').select('id, name'), companyId).range(from, to));
  if (sups.error) return { ok: false, reason: sups.error.message };
  const transport = (sups.data ?? []).filter((s) => carrierFor(String(s.id), String(s.name ?? ''), carriers.rows) != null).map((s) => String(s.id));
  if (transport.length === 0) return { ok: true, ids: [] };
  const invs = await chunkIn<Row>(transport, (b, from, to) => scopeToCompanyId(sb.from('ap_invoices').select('id, status, invoice_date'), companyId)
    .in('supplier_id', b).neq('status', 'CANCELLED').range(from, to));
  if (invs.error) return { ok: false, reason: invs.error.message };
  const ids = invs.data.map((i) => String(i.id));
  const [files, reads, saved] = await Promise.all([
    chunkIn<Row>(ids, (b, from, to) => scopeToCompanyId(sb.from('acc_ap_invoice_files').select('ap_invoice_id, created_at'), companyId).in('ap_invoice_id', b).range(from, to)),
    chunkIn<Row>(ids, (b, from, to) => scopeToCompanyId(sb.from('threepl_bill_reads').select('ap_invoice_id, files_count, files_latest, attempts, error'), companyId).in('ap_invoice_id', b).range(from, to)),
    chunkIn<Row>(ids, (b, from, to) => scopeToCompanyId(sb.from('threepl_do_charges').select('ap_invoice_id'), companyId).in('ap_invoice_id', b).range(from, to)),
  ]);
  if (files.error) return { ok: false, reason: files.error.message };
  if (reads.error) return { ok: false, reason: reads.error.message };
  if (saved.error) return { ok: false, reason: saved.error.message };
  const stampOf = new Map<string, FileStamp>();
  for (const f of files.data) {
    const k = String(f.ap_invoice_id);
    const s = stampOf.get(k) ?? { count: 0, latest: null };
    s.count += 1;
    if (str(f.created_at) && (!s.latest || String(f.created_at) > s.latest)) s.latest = String(f.created_at);
    stampOf.set(k, s);
  }
  const readOf = new Map(reads.data.map((r) => [String(r.ap_invoice_id), r] as const));
  const byHand = new Set(saved.data.map((r) => String(r.ap_invoice_id)));
  const due = invs.data
    .filter((i) => {
      const s = stampOf.get(String(i.id));
      if (!s || s.count === 0) return false;
      const r = readOf.get(String(i.id));
      if (!r) return !byHand.has(String(i.id));
      const changed = Number(r.files_count) !== s.count || (s.latest != null && (!str(r.files_latest) || Date.parse(s.latest) > Date.parse(String(r.files_latest))));
      if (changed) return true;
      return !!str(r.error) && Number(r.attempts ?? 0) < AUTO_ATTEMPTS;
    })
    .sort((a, b) => String(b.invoice_date ?? '').localeCompare(String(a.invoice_date ?? '')));
  return { ok: true, ids: due.map((i) => String(i.id)) };
}

const sameLine = (l: { text: string; amountSen: number | null; date: string | null }) =>
  `${l.text.trim().replace(/\s+/g, ' ').toLowerCase()}|${l.amountSen ?? ''}|${l.date ?? ''}`;

/** A re-read keeps what a person decided: a line with the same words, amount
 *  and day as one they assigned stays where they put it. */
export async function keepPersonChoices(deps: BillDeps, apInvoiceId: string, lines: readonly KeptLine[]): Promise<{ ok: true; lines: KeptLine[] } | BillFail> {
  const { data, error } = await scopeToCompanyId(deps.sb.from('threepl_bill_lines')
    .select('text, amount_sen, line_date, assign, do_ids, service_ref, project_id, assigned_by, assigned_at'), deps.companyId)
    .eq('ap_invoice_id', apInvoiceId).order('line_no');
  if (error) return fail(500, 'load_failed', error.message);
  const theirs = new Map<string, Row[]>();
  for (const o of (data ?? []) as Row[]) {
    if (!str(o.assigned_by) || o.assigned_by === 'auto') continue;
    const k = sameLine({ text: String(o.text ?? ''), amountSen: o.amount_sen == null ? null : Number(o.amount_sen), date: str(o.line_date) });
    theirs.set(k, [...(theirs.get(k) ?? []), o]);
  }
  return {
    ok: true,
    lines: lines.map((l) => {
      const o = theirs.get(sameLine(l))?.shift();
      if (!o) return l;
      return {
        ...l,
        assignment: {
          assign: str(o.assign) as LineAssign | null, doIds: Array.isArray(o.do_ids) ? (o.do_ids as unknown[]).map(String) : [],
          serviceRef: str(o.service_ref), projectId: o.project_id == null ? null : Number(o.project_id),
        },
        assignedBy: str(o.assigned_by), assignedAt: str(o.assigned_at),
      };
    }),
  };
}

/** Read and keep one bill the way the cron does: the reader's assignments
 *  stand, a person's earlier choices are kept, a person sees the rest under
 *  "To check". A failure is logged. */
export async function autoReadBill(deps: BillDeps, apInvoiceId: string): Promise<{ ok: true; saved: number } | BillFail> {
  const bill = await loadApBill(deps, apInvoiceId);
  if (!bill.ok) return bill;
  const reading = await readBill(deps, bill, null);
  if (!reading.ok) {
    const { data: prev, error: pErr } = await scopeToCompanyId(deps.sb.from('threepl_bill_reads').select('attempts, threepl_company_id, files_count, files_latest'), deps.companyId)
      .eq('ap_invoice_id', apInvoiceId).maybeSingle();
    if (pErr) return fail(500, 'load_failed', pErr.message);
    /* The files it failed on are stamped, so a new file is read at once and the
       same files are tried AUTO_ATTEMPTS times in all. */
    const now = await fileStampOf(deps, bill.inv);
    const logged = await logRead(deps, bill.inv, {
      carrierId: str(prev?.threepl_company_id), readBy: 'auto', error: reading.message, attempts: Number(prev?.attempts ?? 0) + 1,
      stamp: now.ok ? now.stamp : { count: Number(prev?.files_count ?? 0), latest: str(prev?.files_latest) },
    });
    return logged.ok ? reading : logged;
  }
  if (!reading.carrierId) {
    const logged = await logRead(deps, bill.inv, { carrierId: null, readBy: 'auto', stamp: reading.stamp, error: 'No 3PL company bills as this supplier.', attempts: AUTO_ATTEMPTS });
    return logged.ok ? fail(409, 'no_carrier', 'No 3PL company bills as this supplier.') : logged;
  }
  const kept = await keepPersonChoices(deps, apInvoiceId, keptLines(reading));
  if (!kept.ok) return kept;
  const saved = await saveBill(deps, bill, { carrierId: reading.carrierId, lines: kept.lines, stamp: reading.stamp, readBy: 'auto', actor: 'auto' });
  return saved.ok ? { ok: true, saved: saved.saved } : saved;
}

/** A cancelled AP invoice's bill stops counting: its DO charges, kept lines and
 *  read log go, so the bill keyed again in its place is not "already on" it. */
export async function releaseCancelled(deps: BillDeps): Promise<{ ok: true; released: number } | { ok: false; reason: string }> {
  const { sb, companyId } = deps;
  const [charged, read] = await Promise.all([
    paginateAll<Row>((from, to) => scopeToCompanyId(sb.from('threepl_do_charges').select('ap_invoice_id'), companyId).not('ap_invoice_id', 'is', null).range(from, to)),
    paginateAll<Row>((from, to) => scopeToCompanyId(sb.from('threepl_bill_reads').select('ap_invoice_id'), companyId).range(from, to)),
  ]);
  if (charged.error) return { ok: false, reason: charged.error.message };
  if (read.error) return { ok: false, reason: read.error.message };
  const ids = [...new Set([...(charged.data ?? []), ...(read.data ?? [])].map((r) => String(r.ap_invoice_id)))];
  const gone = await chunkIn<Row>(ids, (b, from, to) => scopeToCompanyId(sb.from('ap_invoices').select('id'), companyId).in('id', b).eq('status', 'CANCELLED').range(from, to));
  if (gone.error) return { ok: false, reason: gone.error.message };
  const cancelled = gone.data.map((i) => String(i.id));
  for (const table of ['threepl_do_charges', 'threepl_bill_lines', 'threepl_bill_reads']) {
    if (!cancelled.length) break;
    const { error } = await scopeToCompanyId(sb.from(table).delete(), companyId).in('ap_invoice_id', cancelled);
    if (error) return { ok: false, reason: error.message };
  }
  return { ok: true, released: cancelled.length };
}

export type AutoReadRun = { due: number; read: number; failed: number; released: number; errors: string[] };

/** The half-hourly cron: each company's due bills, AUTO_READS_PER_RUN in all (the
 *  reader is slow and paid for; the next run takes the rest), after releasing
 *  the bills whose AP invoice was cancelled. One company's failure never stops
 *  the other's. Dark without the database, the file store or the reader. */
export async function autoReadBills(env: Env): Promise<AutoReadRun> {
  const run: AutoReadRun = { due: 0, read: 0, failed: 0, released: 0, errors: [] };
  if (!env.SLIPS || !env.ANTHROPIC_API_KEY) return run;
  let sb: any;
  try { sb = getSupabaseService(env); } catch { return run; }
  let budget = AUTO_READS_PER_RUN;
  for (const companyId of AUTO_READ_COMPANY_IDS) {
    const deps: BillDeps = {
      sb, companyId, allowedIds: AUTO_READ_COMPANY_IDS, bucket: env.SLIPS, apiKey: env.ANTHROPIC_API_KEY,
      usage: { env, feature: 'threepl_bill_read', model: BILL_MODEL, companyId, userId: null, waitUntil: null },
    };
    const released = await releaseCancelled(deps);
    if (released.ok) run.released += released.released;
    else run.errors.push(`company ${companyId}: ${released.reason}`);
    const due = await billsToRead(deps);
    if (!due.ok) { run.errors.push(`company ${companyId}: ${due.reason}`); continue; }
    run.due += due.ids.length;
    for (const id of due.ids.slice(0, budget)) {
      budget -= 1;
      const r = await autoReadBill(deps, id);
      if (r.ok) run.read += 1;
      else { run.failed += 1; run.errors.push(`${id}: ${r.message}`.slice(0, 200)); }
    }
  }
  return run;
}

export type BillSummary = {
  apInvoiceId: string; invoiceNumber: string; supplierRef: string | null; invoiceDate: string | null; totalSen: number;
  supplierName: string; carrierId: string | null; carrierName: string | null;
  readBy: string; readAt: string | null; error: string | null; lines: number;
  doSen: number; serviceSen: number; eventSen: number; noneSen: number; openSen: number; openLines: number;
};

/** Every bill brought in, and its parts: what went to DOs, to service cases, to
 *  fairs, to nothing, and what still waits for a person — adding up to the
 *  bill as read. A bill whose reading failed shows why. */
export async function billSummaries(deps: BillDeps): Promise<{ ok: true; bills: BillSummary[] } | { ok: false; reason: string }> {
  const { sb, companyId } = deps;
  const [reads, lines, carriers] = await Promise.all([
    paginateAll<Row>((from, to) => scopeToCompanyId(sb.from('threepl_bill_reads').select('ap_invoice_id, threepl_company_id, read_by, read_at, error'), companyId).order('read_at', { ascending: false }).range(from, to)),
    paginateAll<Row>((from, to) => scopeToCompanyId(sb.from('threepl_bill_lines').select('ap_invoice_id, amount_sen, assign, do_ids, project_id'), companyId).range(from, to)),
    loadCarriers(sb, companyId),
  ]);
  if (reads.error) return { ok: false, reason: reads.error.message };
  if (lines.error) return { ok: false, reason: lines.error.message };
  if (!carriers.ok) return carriers;
  const readRows = (reads.data ?? []) as Row[];
  const ids = readRows.map((r) => String(r.ap_invoice_id));
  const invs = await chunkIn<Row>(ids, (b, from, to) => scopeToCompanyId(sb.from('ap_invoices').select('id, invoice_number, supplier_invoice_ref, invoice_date, total_sen, supplier_id'), companyId).in('id', b).range(from, to));
  if (invs.error) return { ok: false, reason: invs.error.message };
  const sups = await chunkIn<Row>([...new Set(invs.data.map((i) => String(i.supplier_id)))], (b, from, to) => scopeToCompanyId(sb.from('suppliers').select('id, name'), companyId).in('id', b).range(from, to));
  if (sups.error) return { ok: false, reason: sups.error.message };
  const invOf = new Map(invs.data.map((i) => [String(i.id), i] as const));
  const supName = new Map(sups.data.map((s) => [String(s.id), String(s.name ?? '')] as const));
  const carrierName = new Map(carriers.rows.map((k) => [String(k.id), String(k.name ?? '')] as const));
  const linesOf = new Map<string, Row[]>();
  for (const l of (lines.data ?? []) as Row[]) linesOf.set(String(l.ap_invoice_id), [...(linesOf.get(String(l.ap_invoice_id)) ?? []), l]);
  const bills: BillSummary[] = [];
  for (const r of readRows) {
    const inv = invOf.get(String(r.ap_invoice_id));
    if (!inv) continue;
    const own = linesOf.get(String(r.ap_invoice_id)) ?? [];
    const t = billBreakdown(own.map((l) => ({
      assign: str(l.assign), doIds: Array.isArray(l.do_ids) ? (l.do_ids as unknown[]).map(String) : [],
      projectId: l.project_id == null ? null : Number(l.project_id), amountSen: l.amount_sen == null ? null : Number(l.amount_sen),
    })));
    const carrierId = str(r.threepl_company_id);
    bills.push({
      apInvoiceId: String(inv.id), invoiceNumber: String(inv.invoice_number), supplierRef: str(inv.supplier_invoice_ref),
      invoiceDate: str(inv.invoice_date), totalSen: Number(inv.total_sen ?? 0), supplierName: supName.get(String(inv.supplier_id)) ?? '',
      carrierId, carrierName: carrierId ? carrierName.get(carrierId) ?? null : null,
      readBy: String(r.read_by), readAt: str(r.read_at), error: str(r.error), lines: own.length,
      doSen: t.do, serviceSen: t.service, eventSen: t.event, noneSen: t.none, openSen: t.open, openLines: t.openLines,
    });
  }
  return { ok: true, bills };
}

/** A person's assignment of one kept line, checked: DOs by their numbers (each
 *  one live DO in the companies the bill may name — a trip line names several),
 *  a fair by its project id, a service case with its number if they have one,
 *  or nothing. */
export type AssignInput = { assign: LineAssign | null; doNumber?: string | null; serviceRef?: string | null; projectId?: number | null };
export async function assignmentOf(deps: BillDeps, input: AssignInput): Promise<{ ok: true; assignment: Assignment } | BillFail> {
  const none: Assignment = { assign: null, doIds: [], serviceRef: null, projectId: null };
  switch (input.assign) {
    case null: return { ok: true, assignment: none };
    case 'none': return { ok: true, assignment: { ...none, assign: 'none' } };
    case 'service': return { ok: true, assignment: { ...none, assign: 'service', serviceRef: str(input.serviceRef)?.trim().slice(0, 60) ?? null } };
    case 'event': {
      const id = Number(input.projectId);
      if (!Number.isInteger(id) || id <= 0) return fail(400, 'fair_required', 'Choose the fair the setup / dismantle was for.');
      return { ok: true, assignment: { ...none, assign: 'event', projectId: id } };
    }
    case 'do': {
      const nos = [...new Set((str(input.doNumber) ?? '').split(/[\s,;]+/).filter(Boolean))];
      if (!nos.length) return fail(400, 'do_required', 'Enter the DO number.');
      if (nos.length > 20) return fail(400, 'too_many_dos', 'Up to 20 DOs on one line.');
      const { data, error } = await scopeOf(deps)(deps.sb.from('delivery_orders').select('id, do_number, status')).in('do_number', nos);
      if (error) return fail(500, 'load_failed', error.message);
      const live = ((data ?? []) as Row[]).filter((d) => d.status !== 'CANCELLED');
      const doIds: string[] = [];
      for (const no of nos) {
        const hit = live.filter((d) => String(d.do_number) === no);
        if (hit.length !== 1) return fail(404, hit.length ? 'do_ambiguous' : 'do_not_found', hit.length ? `${no} is more than one DO.` : `${no} is not a DO in the system.`);
        doIds.push(String(hit[0]!.id));
      }
      return { ok: true, assignment: { ...none, assign: 'do', doIds } };
    }
    default: return fail(400, 'bad_assign', 'Choose DO, Service, Setup / Dismantle or Not counted.');
  }
}
