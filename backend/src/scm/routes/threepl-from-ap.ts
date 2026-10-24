// ----------------------------------------------------------------------------
// /threepl-do-charges — the 3PL invoices tab filled FROM the AP invoice Finance
// already keyed (owner 2026-10-23: 「先做」, after 「其实我的ap invoice 本身就带有so
// number 或do number / 所以你要根据我的系统的do 对比supplier charge 我的amount对比 /
// 仓储，搬运不算」; 2026-10-24: 自动读 · 手动还是要保留 · 对不上的 … 我想要assign 看这个
// 是去哪里，可能是service, 可能是setup dismantle，可能不算).
//
//   GET   /from-ap/invoices              AP invoices with a bill attached, the
//                                        3PL each supplier bills as, what was
//                                        brought in, what still waits
//   POST  /from-ap/:apInvoiceId/read     { carrierId? } read the bill, match
//                                        every line — WRITES NOTHING (preview)
//   POST  /from-ap/:apInvoiceId/confirm  { carrierId, rows: [{ doId, billedSen }],
//                                        lines } keep what the person kept
//   GET   /bill-lines?apInvoiceId=|open=1  a bill's lines / every line waiting
//   PATCH /bill-lines/:id                { assign, doNumber?, serviceRef?,
//                                        projectId? } where one line went
//
// The reading, the rules and the keeping are scm/lib/threepl-bill-import.ts,
// shared with the */30 cron that reads new bills on its own; handwriting can be
// misread ("SO" as "80"), so every kept line shows its words and any line can
// be re-assigned. Nothing posts to the ledger: the AP invoice already booked
// the cost; this tallies it. The AP invoice is Finance's (scm.finance.accounting,
// on top of the tab's own area). A 2990 DO is matched too — Houzs delivers for
// 2990 and bills it back (owner 2026-10-23) — and shows its company.
// ----------------------------------------------------------------------------
import {
  requireActiveCompanyId, scopeToCompanyId, allowedCompanyIds, activeCompanySql, companyCodeMap,
} from '../lib/companyScope';
import { chunkIn } from '../lib/paginate-all';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { BILL_MODEL } from '../../acc/bill-extract';
import { requestAiTag } from '../../services/aiUsage';
import {
  assignmentOf, carrierFor, fileStampOf, loadApBill, loadCarriers, readBill, rederiveCharges, saveBill,
  type AssignInput, type BillDeps, type BillFail, type KeptLine,
} from '../lib/threepl-bill-import';
import { chargeNote, chargesPerDo, isOpenLine, lineTotals, type Assignment, type LineAssign } from '../lib/threepl-bill-match';
import { varianceSen } from '../lib/threepl-do-charge';

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client and Hono context, untyped as in every SCM route */
type Row = Record<string, any>;
const str = (v: unknown) => (v == null || v === '' ? null : String(v));

const FINANCE_ONLY = { error: 'forbidden', message: 'Bringing in a 3PL bill reads the AP invoice, which is Finance’s.' };
const mayRead = (c: any) => hasHouzsPerm(c, 'scm.finance.accounting');
const ASSIGNS: ReadonlyArray<LineAssign> = ['do', 'service', 'event', 'none'];

/** The request's reach: the active company pays, the allowed companies' DOs
 *  may be named on its bills. */
function depsOf(c: any, companyId: number): BillDeps {
  return {
    sb: c.get('supabase'),
    companyId,
    allowedIds: allowedCompanyIds(c) ?? [companyId],
    bucket: (c.env as { SLIPS?: BillDeps['bucket'] }).SLIPS,
    apiKey: c.env?.ANTHROPIC_API_KEY,
    usage: requestAiTag(c, 'threepl_bill_read', BILL_MODEL),
  };
}
const refuse = (c: any, f: BillFail) => c.json({ error: f.error, message: f.message }, f.status);
const personOf = (c: any): string => String(c.get('houzsUser')?.name ?? c.get('user')?.user_metadata?.name ?? 'a person').slice(0, 80);

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
  const [files, done, sups, open, carriers] = await Promise.all([
    chunkIn<Row>(ids, (b, from, to) => scopeToCompanyId(sb.from('acc_ap_invoice_files').select('ap_invoice_id'), co.companyId).in('ap_invoice_id', b).range(from, to)),
    chunkIn<Row>(ids, (b, from, to) => scopeToCompanyId(sb.from('threepl_do_charges').select('ap_invoice_id, billed_sen'), co.companyId).in('ap_invoice_id', b).range(from, to)),
    chunkIn<Row>(supplierIds, (b, from, to) => scopeToCompanyId(sb.from('suppliers').select('id, name'), co.companyId).in('id', b).range(from, to)),
    chunkIn<Row>(ids, (b, from, to) => scopeToCompanyId(sb.from('threepl_bill_lines').select('ap_invoice_id, assign, do_ids, project_id'), co.companyId).in('ap_invoice_id', b).range(from, to)),
    loadCarriers(sb, co.companyId),
  ]);
  const failed = files.error ?? done.error ?? sups.error ?? open.error;
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
  const waiting = new Map<string, number>();
  for (const l of open.data) {
    const doIds = Array.isArray(l.do_ids) ? (l.do_ids as unknown[]).map(String) : [];
    if (isOpenLine({ assign: str(l.assign), doIds, projectId: l.project_id == null ? null : Number(l.project_id) })) {
      waiting.set(String(l.ap_invoice_id), (waiting.get(String(l.ap_invoice_id)) ?? 0) + 1);
    }
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
      waitingLines: waiting.get(String(r.id)) ?? 0,
      carrierId: carrierFor(String(r.supplier_id), supplierName, carriers.rows),
    };
  });
  return c.json({ invoices, carriers: carriers.rows.map((k) => ({ id: String(k.id), name: String(k.name ?? '') })) });
};

// ── POST /from-ap/:apInvoiceId/read ─────────────────────────────────────────
export const readApBillHandler = async (c: any) => {
  if (!mayRead(c)) return c.json(FINANCE_ONLY, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Row = {};
  try { body = await c.req.json(); } catch { /* no body: the carrier is the supplier's */ }
  const deps = depsOf(c, co.companyId);
  const bill = await loadApBill(deps, c.req.param('apInvoiceId'));
  if (!bill.ok) return refuse(c, bill);
  const reading = await readBill(deps, bill, str(body.carrierId));
  if (!reading.ok) return refuse(c, reading);

  const codes = companyCodeMap(c);
  const apNo = String(bill.inv.invoice_number);
  const charges = chargesPerDo(reading.lines, reading.expectedOf);
  return c.json({
    invoice: {
      id: String(bill.inv.id), invoiceNumber: apNo, supplierRef: str(bill.inv.supplier_invoice_ref), invoiceDate: str(bill.inv.invoice_date),
      totalSen: Number(bill.inv.total_sen ?? 0), supplierId: String(bill.inv.supplier_id), supplierName: bill.supplierName,
    },
    carrierId: reading.carrierId,
    carriers: reading.carriers.map((k) => ({ id: String(k.id), name: String(k.name ?? '') })),
    dos: charges.map((ch) => {
      const d = reading.dos.get(ch.doId)!;
      const expected = reading.expectedOf(ch.doId);
      return {
        doId: ch.doId, doNumber: d.doNumber, doDate: d.doDate, soDocNo: d.soDocNo, customer: d.customer,
        companyCode: codes.get(d.companyId) ?? null,
        billedSen: ch.billedSen, expectedSen: expected, varianceSen: varianceSen(ch.billedSen, expected),
        split: ch.split, lines: ch.lines, note: chargeNote(ch, apNo),
        alreadyOn: reading.elsewhere.get(ch.doId) ?? null,
      };
    }),
    lines: reading.lines.map((l, i) => {
      const a = reading.assignments[i]!;
      return {
        index: l.index, text: l.text, date: l.date, kind: l.kind, amountSen: l.amountSen, printed: l.printed,
        status: l.status, dos: l.dos.map((d) => d.doNumber), doIds: l.dos.map((d) => d.id),
        assign: a.assign, serviceRef: a.serviceRef, projectId: a.projectId,
      };
    }),
    totals: lineTotals(reading.lines),
  });
};

/** A line the preview sent back, checked into the shape kept. A DO line keeps
 *  only the DOs the person kept; none kept, it waits for them — as their
 *  choice, so the reader does not put it back on that DO. */
function keptFromBody(raw: Row, i: number, kept: ReadonlySet<string>, person: string): KeptLine | null {
  const amount = raw.amountSen == null ? null : Number(raw.amountSen);
  if (amount != null && !Number.isInteger(amount)) return null;
  const assign = ASSIGNS.includes(raw.assign) ? (raw.assign as LineAssign) : null;
  const named = Array.isArray(raw.doIds) ? (raw.doIds as unknown[]).map(String) : [];
  const doIds = named.filter((id) => kept.has(id));
  const projectId = raw.projectId == null ? null : Number(raw.projectId);
  const assignment: Assignment = assign === 'do'
    ? { assign: doIds.length ? 'do' : null, doIds, serviceRef: null, projectId: null }
    : { assign, doIds: [], serviceRef: assign === 'service' ? str(raw.serviceRef)?.slice(0, 60) ?? null : null, projectId: assign === 'event' && Number.isInteger(projectId) ? projectId : null };
  return {
    lineNo: i + 1, text: String(raw.text ?? '').slice(0, 300), date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date ?? '')) ? String(raw.date) : null,
    kind: String(raw.kind ?? 'other').slice(0, 20), amountSen: amount,
    printed: Array.isArray(raw.printed) ? (raw.printed as unknown[]).map((p) => String(p).slice(0, 80)).slice(0, 40) : [],
    readStatus: String(raw.status ?? 'matched').slice(0, 20), assignment,
    ...(assign === 'do' && named.length > 0 && doIds.length === 0 ? { assignedBy: person } : {}),
  };
}

// ── POST /from-ap/:apInvoiceId/confirm ──────────────────────────────────────
export const confirmApBillHandler = async (c: any) => {
  if (!mayRead(c)) return c.json(FINANCE_ONLY, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const carrierId = str(body.carrierId);
  const rows = Array.isArray(body.rows) ? (body.rows as Row[]) : null;
  if (!carrierId) return c.json({ error: 'carrier_required', message: 'Choose the 3PL this bill is from.' }, 400);
  if (!rows || rows.length > 500) return c.json({ error: 'rows_required', message: 'Keep up to 500 delivery orders.' }, 400);
  const clean = rows.map((r) => ({ doId: str(r.doId), billedSen: Number(r.billedSen) }));
  if (clean.some((r) => !r.doId || !Number.isInteger(r.billedSen) || r.billedSen < 0)) {
    return c.json({ error: 'invalid_rows', message: 'Each row needs its DO and an amount in sen of 0 or more.' }, 400);
  }
  const doIds = [...new Set(clean.map((r) => r.doId as string))];
  if (doIds.length !== clean.length) return c.json({ error: 'duplicate_do', message: 'A delivery order is on the list twice.' }, 400);
  const bodyLines = Array.isArray(body.lines) ? (body.lines as Row[]).slice(0, 300) : null;
  if (rows.length === 0 && !bodyLines?.length) return c.json({ error: 'rows_required', message: 'Keep 1 to 500 delivery orders.' }, 400);

  const deps = depsOf(c, co.companyId);
  const bill = await loadApBill(deps, c.req.param('apInvoiceId'));
  if (!bill.ok) return refuse(c, bill);
  const { data: carrier, error: cErr } = await scopeToCompanyId(deps.sb.from('threepl_companies').select('id'), co.companyId).eq('id', carrierId).maybeSingle();
  if (cErr) return c.json({ error: 'load_failed', reason: cErr.message }, 500);
  if (!carrier) return c.json({ error: 'carrier_not_found', message: 'That 3PL is not in the company you are working in.' }, 404);

  const live = await chunkIn<Row>(doIds, (b, from, to) => (deps.sb.from('delivery_orders').select('id, status') as any).in('company_id', [...deps.allowedIds]).in('id', b).range(from, to));
  if (live.error) return c.json({ error: 'load_failed', reason: live.error.message }, 500);
  const liveIds = new Set(live.data.filter((d) => d.status !== 'CANCELLED').map((d) => String(d.id)));
  const gone = doIds.filter((id) => !liveIds.has(id));
  if (gone.length) return c.json({ error: 'do_not_found', message: `${gone.length} delivery order(s) are cancelled or not yours to see.` }, 409);

  const kept = new Set(doIds);
  /* A preview from before the lines were kept sends only its DOs: one line each. */
  const lines: KeptLine[] = bodyLines
    ? bodyLines.map((l, i) => keptFromBody(l, i, kept, personOf(c))).filter((l): l is KeptLine => !!l)
    : clean.map((r, i) => ({ lineNo: i + 1, text: String(rows[i]!.note ?? '').slice(0, 300), date: null, kind: 'delivery', amountSen: r.billedSen, printed: [], readStatus: 'matched', assignment: { assign: 'do', doIds: [r.doId as string], serviceRef: null, projectId: null } }));
  const stamp = await fileStampOf(deps, bill.inv);
  if (!stamp.ok) return refuse(c, stamp);
  const saved = await saveBill(deps, bill, {
    carrierId, lines, stamp: stamp.stamp, readBy: 'person', actor: personOf(c),
    doAmounts: new Map(clean.map((r) => [r.doId as string, r.billedSen])),
  });
  if (!saved.ok) return refuse(c, saved);
  return c.json({ saved: saved.saved, skipped: saved.skipped });
};

// ── GET /bill-lines ─────────────────────────────────────────────────────────
export const listBillLinesHandler = async (c: any) => {
  if (!mayRead(c)) return c.json(FINANCE_ONLY, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const apInvoiceId = str(c.req.query('apInvoiceId'));
  const onlyOpen = c.req.query('open') === '1';
  let q = scopeToCompanyId(sb.from('threepl_bill_lines')
    .select('id, ap_invoice_id, threepl_company_id, line_no, text, line_date, kind, amount_sen, printed, read_status, assign, do_ids, service_ref, project_id, assigned_by, assigned_at'), co.companyId);
  if (apInvoiceId) q = q.eq('ap_invoice_id', apInvoiceId);
  const { data, error } = await q.order('ap_invoice_id').order('line_no').limit(2000);
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  type LineRow = Row & { doIds: string[]; projectId: number | null };
  const rows = ((data ?? []) as Row[]).map((l): LineRow => ({
    ...l, doIds: Array.isArray(l.do_ids) ? (l.do_ids as unknown[]).map(String) : [],
    projectId: l.project_id == null ? null : Number(l.project_id),
  })).filter((l) => !onlyOpen || isOpenLine({ assign: str(l.assign), doIds: l.doIds, projectId: l.projectId }));
  const invIds = [...new Set(rows.map((l) => String(l.ap_invoice_id)))];
  const doIds = [...new Set(rows.flatMap((l) => l.doIds))];
  const [invs, dos] = await Promise.all([
    chunkIn<Row>(invIds, (b, from, to) => scopeToCompanyId(sb.from('ap_invoices').select('id, invoice_number, supplier_id'), co.companyId).in('id', b).range(from, to)),
    chunkIn<Row>(doIds, (b, from, to) => (sb.from('delivery_orders').select('id, do_number') as any).in('company_id', allowedCompanyIds(c) ?? [co.companyId]).in('id', b).range(from, to)),
  ]);
  if (invs.error || dos.error) return c.json({ error: 'load_failed', reason: (invs.error ?? dos.error)!.message }, 500);
  const sups = await chunkIn<Row>([...new Set(invs.data.map((i) => String(i.supplier_id)))], (b, from, to) => scopeToCompanyId(sb.from('suppliers').select('id, name'), co.companyId).in('id', b).range(from, to));
  if (sups.error) return c.json({ error: 'load_failed', reason: sups.error.message }, 500);
  const invOf = new Map(invs.data.map((i) => [String(i.id), i] as const));
  const supName = new Map(sups.data.map((s) => [String(s.id), String(s.name ?? '')] as const));
  const doNo = new Map(dos.data.map((d) => [String(d.id), String(d.do_number)] as const));
  return c.json({
    lines: rows.map((l) => {
      const inv = invOf.get(String(l.ap_invoice_id));
      return {
        id: String(l.id), apInvoiceId: String(l.ap_invoice_id), invoiceNumber: inv ? String(inv.invoice_number) : null,
        supplierName: inv ? supName.get(String(inv.supplier_id)) ?? null : null,
        lineNo: Number(l.line_no), text: String(l.text ?? ''), date: str(l.line_date), kind: String(l.kind ?? 'other'),
        amountSen: l.amount_sen == null ? null : Number(l.amount_sen), printed: (l.printed as string[] | null) ?? [],
        readStatus: String(l.read_status), assign: str(l.assign), doIds: l.doIds, doNumbers: l.doIds.map((id: string) => doNo.get(id) ?? id),
        serviceRef: str(l.service_ref), projectId: l.projectId, assignedBy: str(l.assigned_by), assignedAt: str(l.assigned_at),
        open: isOpenLine({ assign: str(l.assign), doIds: l.doIds, projectId: l.projectId }),
      };
    }),
  });
};

// ── PATCH /bill-lines/:id ───────────────────────────────────────────────────
export const assignBillLineHandler = async (c: any) => {
  if (!mayRead(c)) return c.json(FINANCE_ONLY, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: Row;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (body.assign != null && !ASSIGNS.includes(body.assign)) return c.json({ error: 'bad_assign', message: 'Choose DO, Service, Setup / Dismantle or Not counted.' }, 400);
  const deps = depsOf(c, co.companyId);
  const { data: line, error } = await scopeToCompanyId(deps.sb.from('threepl_bill_lines').select('id, ap_invoice_id, threepl_company_id'), co.companyId)
    .eq('id', c.req.param('id')).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!line) return c.json({ error: 'not_found', message: 'That bill line is not in the company you are working in.' }, 404);
  const input: AssignInput = { assign: body.assign ?? null, doNumber: str(body.doNumber), serviceRef: str(body.serviceRef), projectId: body.projectId == null ? null : Number(body.projectId) };
  /* A fair is a project of this company (public.projects, as the fair links read it). */
  if (input.assign === 'event' && Number.isInteger(input.projectId) && Number(input.projectId) > 0) {
    const found = await c.env.DB.prepare(`SELECT p.id AS id FROM projects p WHERE p.id = ?${activeCompanySql(c, 'p.company_id')}`).bind(Number(input.projectId)).all();
    if (!(found.results ?? []).length) return c.json({ error: 'fair_not_found', message: 'That fair is not in the company you are working in.' }, 404);
  }
  const checked = await assignmentOf(deps, input);
  if (!checked.ok) return refuse(c, checked);
  const a = checked.assignment;
  const now = new Date().toISOString();
  const { error: uErr } = await scopeToCompanyId(deps.sb.from('threepl_bill_lines').update({
    assign: a.assign, do_ids: a.doIds, service_ref: a.serviceRef, project_id: a.projectId,
    assigned_by: a.assign ? personOf(c) : null, assigned_at: a.assign ? now : null, updated_at: now,
  }), co.companyId).eq('id', String(line.id));
  if (uErr) return c.json({ error: 'save_failed', reason: uErr.message }, 500);
  /* The bill's DO charges follow its DO lines. */
  const carrierId = str(line.threepl_company_id);
  if (carrierId) {
    const bill = await loadApBill(deps, String(line.ap_invoice_id));
    if (!bill.ok) return refuse(c, bill);
    const charges = await rederiveCharges(deps, bill, carrierId);
    if (!charges.ok) return refuse(c, charges);
    return c.json({ ok: true, open: isOpenLine(a), skipped: charges.skipped });
  }
  return c.json({ ok: true, open: isOpenLine(a), skipped: [] });
};
