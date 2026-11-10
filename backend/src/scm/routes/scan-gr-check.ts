// ---------------------------------------------------------------------------
// /scan-gr/check — scan, check, then create (owner 2026-11-03, after Hookka's
// scan modal). Drop any number of delivery orders — one PDF holding twenty, or
// twenty files — and each document is read in the background. What was read
// waits here as an editable working copy (scan_jobs.review) until the operator
// creates the drafts or deletes it; leaving the page or logging out loses
// nothing. A delivery order already received under another goods receipt is
// flagged, and the operator still chooses: create anyway, or delete.
//
// SAFETY: Create converts the checked lines through createDraftGrnFromPoItems,
// the same core as every other path — DRAFT only (no stock moves), always from
// PO lines, company-scoped read of every PO line, qty capped at what is owed.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { activeCompanyId } from '../lib/companyScope';
import { resolveCallerStaffId } from '../lib/salesScope';
import { companyCodeById } from '../lib/doc-no';
import { createDraftGrnFromPoItems } from '../lib/grn-from-po-core';
import { loadOpenPoLines, loadSuppliers } from '../lib/grn-scan-load';
import { paginateAll } from '../lib/paginate-all';
import { REVIEW_VERSION, blockedReason, cleanReview, codesToTeach, duplicateOf, giftsOf, picksOf, racksOf, refVariants, repeatsInList, type ExistingGrn, type GrnReview } from '../lib/grn-scan-check';
import { reviewOfRead } from '../lib/grn-scan-check-read';
import { mytDateOf, todayMyt } from '../lib/my-time';
import type { GrnExtracted } from '../lib/grn-scan-extract';
import { applyScanRacks, scanRackNote } from '../lib/grn-scan-racks';
import { saveScanCodes } from '../lib/grn-scan-codes';
import { addGiftLines, giftNote, loadCatalogueProducts } from '../lib/grn-scan-gifts';
import { reapStaleGrnScanJobs, runGrnJobFromRow } from './scan-gr';
import {
  callerId, goldSamples, handleDiscard, handleFile, handleGold, handleRetry, handleUpload, idsOf, jsonBody,
  ownRows as ownScanRows, svcOf, waitingRows, type CheckContext, type CheckRow as SharedRow, type SupabaseClient,
} from './scan-check-shared';

export const scanGrCheck = new Hono<{ Bindings: Env; Variables: Variables }>();
scanGrCheck.use('*', supabaseAuth);

type CheckRow = SharedRow<GrnReview>;

scanGrCheck.post('/upload', (c) => handleUpload(c, { documentType: 'GR', feature: 'scan_gr_split', reviewVersion: REVIEW_VERSION, scannedToday: (review) => ({ ...review, deliveryDate: todayMyt() }), runLocal: runGrnJobFromRow }));

/* A working copy of an older shape: rebuild it from the stored read, once, keeping
   the supplier and D.O. the operator may have edited and any row they tied that
   the rebuild did not. Its date becomes the day it was scanned. */
async function upgradeCopies(svc: SupabaseClient, companyId: number | null, rows: CheckRow[]): Promise<void> {
  for (const r of rows) {
    if (r.review_state !== 'pending' || !r.review || r.review.v === REVIEW_VERSION || !r.sample_id) continue;
    const { data, error } = await svc.from('so_scan_samples').select('extracted').eq('id', r.sample_id).maybeSingle();
    if (error) { console.warn('[scan-gr check] read not loaded, copy left as it is:', r.id, error.message); continue; }
    const parsed = (data as { extracted: GrnExtracted | null } | null)?.extracted ?? null;
    if (!parsed || !Array.isArray(parsed.lines)) continue;
    const { review, note } = await reviewOfRead(svc, companyId, parsed, mytDateOf(r.created_at));
    // What the operator chose for a row still stands on the rebuilt row that printed the same code.
    const chosen = new Map(r.review.lines.filter((l) => l.read?.itemCode && (l.poItemId || l.gift) && !l.suggested).map((l) => [l.read?.itemCode, l]));
    const lines = review.lines.map((l) => {
      const old = l.poItemId || l.gift ? undefined : chosen.get(l.read?.itemCode);
      return old ? { ...l, poItemId: old.poItemId, poNumber: old.poNumber, gift: old.gift, rack: l.rack ?? old.rack } : l;
    });
    const had = new Set(lines.map((l) => l.poItemId));
    const kept = r.review.lines.filter((l) => l.poItemId && !had.has(l.poItemId)).map((l) => ({ ...l, rack: l.rack ?? null, suggested: l.suggested === true }));
    const next: GrnReview = { ...review, supplierId: r.review.supplierId ?? review.supplierId, doNo: r.review.doNo ?? review.doNo, notes: r.review.notes, lines: [...lines, ...kept] };
    const { error: upErr } = await svc.from('scan_jobs').update({ review: next, error: note }).eq('id', r.id).eq('company_id', companyId).eq('review_state', 'pending');
    if (upErr) { console.warn('[scan-gr check] copy not upgraded:', r.id, upErr.message); continue; }
    r.review = next;
    r.error = note;
  }
}

/* GET /scan-gr/check/pending — this user's documents still being read or
   waiting to be checked (last 14 days), with what the editor needs: the
   suppliers, the open PO lines of every supplier on them, and per document
   whether it is a repeat of a receipt already made and what still blocks it. */
scanGrCheck.get('/pending', async (c) => {
  const svc = svcOf(c.env);
  const companyId = activeCompanyId(c) ?? null;
  // A document whose queue message died comes back here even if nobody opens the old list.
  await reapStaleGrnScanJobs(c.env, svc, (p) => { try { c.executionCtx.waitUntil(p); } catch { /* tests */ } });
  const waiting = await waitingRows<GrnReview>(svc, c, 'GR');
  if ('failed' in waiting) return c.json({ error: 'query_failed', reason: 'Could not load your scans. Please try again.' }, 500);
  const { rows } = waiting;
  await upgradeCopies(svc, companyId, rows);

  const [suppliers, openLines] = await Promise.all([loadSuppliers(svc, companyId), loadOpenPoLines(svc, companyId)]);
  const open = new Map(openLines.map((l) => [l.poItemId, l]));
  const refs = [...new Set(rows.flatMap((r) => (r.review?.doNo ? refVariants(r.review.doNo) : [])))];
  const existing: ExistingGrn[] = [];
  if (refs.length > 0) {
    const { data: g, error: gErr } = await svc.from('grns').select('id, grn_number, supplier_id, delivery_note_ref, status, received_at')
      .eq('company_id', companyId).neq('status', 'CANCELLED').in('delivery_note_ref', refs);
    // Without this read no repeat could be flagged, so the list is refused rather than shown clean.
    if (gErr) return c.json({ error: 'query_failed', reason: 'Could not check for delivery orders already received. Please try again.' }, 500);
    for (const x of (g as Array<{ id: string; grn_number: string; supplier_id: string | null; delivery_note_ref: string | null; status: string; received_at: string | null }> | null) ?? []) {
      existing.push({ id: x.id, grnNumber: x.grn_number, supplierId: x.supplier_id, deliveryNoteRef: x.delivery_note_ref, status: x.status, receivedAt: x.received_at });
    }
  }
  // Marked as gold = the read is a good example the scanner learns from (so_scan_samples ACCEPTED / CONFIRMED).
  const gold = await goldSamples(svc, rows.map((r) => r.sample_id).filter((x): x is string => !!x));
  const supplierIds = new Set(rows.map((r) => r.review?.supplierId).filter(Boolean));
  const repeats = repeatsInList(rows.map((r) => ({ id: r.id, fileName: r.file_name, review: r.review })));
  const documents = rows.map((r) => ({
    id: r.id, batchId: r.batch_id, fileName: r.file_name, pages: r.page_from != null ? [r.page_from, r.page_to] : null,
    state: r.status === 'error' ? 'failed' : r.review_state, note: r.error, review: r.review, createdAt: r.created_at,
    hasFile: (r.image_keys ?? []).length > 0,
    canGold: !!r.sample_id, gold: !!r.sample_id && gold.has(r.sample_id),
    duplicateOf: r.review ? duplicateOf(r.review, existing) : null,
    repeatOf: repeats.get(r.id) ?? null,
    blocked: r.review ? blockedReason(r.review, open) : null,
  }));
  return c.json({ success: true, data: {
    documents,
    suppliers: suppliers.map((s) => ({ id: s.id, code: s.code, name: s.name })),
    poLines: openLines.filter((l) => l.supplierId && supplierIds.has(l.supplierId)).map((l) => ({
      poItemId: l.poItemId, poNumber: l.poNumber, supplierId: l.supplierId, itemCode: l.itemCode, supplierSku: l.supplierSku, spec: l.description2 ?? null, colour: l.colours?.[0] ?? null, warehouseId: l.warehouseId ?? null,
      name: l.materialName, remaining: l.remaining, warehouse: l.locationCode,
    })),
  } });
});

/* GET /scan-gr/check/supplier-skus?supplierId= — the SKUs bound to one supplier
   (owner 2026-11-04: what a supplier hands over is always under that supplier).
   A row picks from these; one on no open PO can only be a free gift. */
scanGrCheck.get('/supplier-skus', async (c) => {
  const supplierId = c.req.query('supplierId') ?? '';
  const companyId = activeCompanyId(c) ?? null;
  const svc = svcOf(c.env);
  const { data, error } = await paginateAll((from, to) => svc.from('supplier_material_bindings')
    .select('item_code, material_name').eq('supplier_id', supplierId).eq('company_id', companyId).eq('material_kind', 'mfg_product')
    .order('id').range(from, to));
  if (error) return c.json({ error: 'query_failed', reason: 'Could not load this supplier\'s SKUs. Please try again.' }, 500);
  const seen = new Map<string, string | null>();
  for (const r of (data ?? []) as Array<{ item_code: string | null; material_name: string | null }>) if (r.item_code) seen.set(r.item_code, r.material_name);
  return c.json({ success: true, data: { skus: [...seen].map(([code, name]) => ({ code, name })) } });
});

/* Open PO lines of one supplier, when the operator changes a document's supplier. */
scanGrCheck.get('/po-lines', async (c) => {
  const supplierId = c.req.query('supplierId') ?? '';
  const lines = (await loadOpenPoLines(svcOf(c.env), activeCompanyId(c) ?? null)).filter((l) => l.supplierId === supplierId);
  return c.json({ success: true, data: { poLines: lines.map((l) => ({
    poItemId: l.poItemId, poNumber: l.poNumber, supplierId: l.supplierId, itemCode: l.itemCode, supplierSku: l.supplierSku, spec: l.description2 ?? null, colour: l.colours?.[0] ?? null, warehouseId: l.warehouseId ?? null, name: l.materialName, remaining: l.remaining, warehouse: l.locationCode,
  })) } });
});

const ownRows = (svc: SupabaseClient, c: CheckContext, ids: string[]) => ownScanRows<GrnReview>(svc, c, 'GR', ids);

/* PATCH /scan-gr/check/:id {review} — save the operator's edit. */
scanGrCheck.patch('/:id', async (c) => {
  const body = await jsonBody(c) as { review?: unknown } | null;
  const review = cleanReview(body?.review);
  if (!review) return c.json({ error: 'bad_request', reason: 'Nothing to save.' }, 400);
  const svc = svcOf(c.env);
  const row = (await ownRows(svc, c, [c.req.param('id')]))[0] as CheckRow | undefined;
  if (!row) return c.json({ error: 'not_found', reason: 'This scan is no longer here.' }, 404);
  if (row.review_state !== 'pending') return c.json({ error: 'not_editable', reason: row.review_state === 'reading' ? 'Still reading this document.' : 'This scan was already handled.' }, 409);
  const { error } = await svc.from('scan_jobs').update({ review, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('company_id', activeCompanyId(c)).eq('review_state', 'pending');
  if (error) return c.json({ error: 'save_failed', reason: 'Could not save. Please try again.' }, 500);
  return c.json({ success: true });
});

/* POST /scan-gr/check/create {ids} — make the DRAFT goods receipts. One result
   per document; a refused one keeps its working copy and says why. */
scanGrCheck.post('/create', async (c) => {
  // company-scope: rows are read with the active company and the caller; drafts go through createDraftGrnFromPoItems, whose PO-line read is company-scoped; each row update repeats the company predicate.
  const svc = svcOf(c.env);
  const companyId = activeCompanyId(c) ?? null;
  const rows = (await ownRows(svc, c, idsOf(await jsonBody(c)))).filter((r) => r.review_state === 'pending' && r.review);
  const companyCode = await companyCodeById(svc, companyId);
  const houzsUserId = callerId(c);
  const userId = (await resolveCallerStaffId(svc, houzsUserId)) ?? c.get('user').id;
  const results: Array<{ id: string; ok: boolean; grnNumbers?: string[]; reason?: string; giftNote?: string | null }> = [];
  const itemOfLine = new Map((await loadOpenPoLines(svc, companyId)).map((l) => [l.poItemId, l.itemCode]));
  for (const r of rows) {
    const review = r.review as GrnReview;
    const picks = picksOf(review);
    if (picks.length === 0) { results.push({ id: r.id, ok: false, reason: 'No line is tied to a PO line yet.' }); continue; }
    const res = await createDraftGrnFromPoItems(c.env, {
      userId, houzsUserId, companyId, companyCode, picks,
      notes: [review.doNo ? `D.O. ${review.doNo}` : 'Scanned delivery order', review.notes].filter(Boolean).join(' · '),
      receivedDate: review.deliveryDate ?? undefined,
      deliveryNoteRef: review.doNo,
    });
    if (!res.ok || res.created.length === 0) {
      const b = res.ok ? {} : res.body;
      const reason = typeof b.reason === 'string' ? b.reason
        : b.error === 'qty_exceeds_remaining' ? `A line asks for ${String(b.requested)} but only ${String(b.remaining)} is still owed.`
        : b.error === 'po_not_receivable' ? 'A PO on it can no longer be received (closed, cancelled or on hold).'
        : b.error === 'item_not_found' ? 'A PO line on it is not in this company.'
        : 'The goods receipt could not be created.';
      results.push({ id: r.id, ok: false, reason });
      continue;
    }
    const grnNumbers = res.created.map((g) => g.grnNumber);
    /* Free gifts go on the first draft at RM0, no PO link, and each printed code
       is remembered for this supplier so the next delivery order marks it alone.
       Only ACTIVE products of this company (loadCatalogueProducts). */
    const wanted = giftsOf(review);
    const products = await loadCatalogueProducts(svc, companyId, wanted.map((g) => g.itemCode));
    const added = await addGiftLines(svc, companyId, res.created[0].id, wanted.filter((g) => products.has(g.itemCode)), userId);
    const skipped = wanted.length - added.length;
    const rackNote = scanRackNote(await applyScanRacks(svc, companyId, res.created.map((g) => g.id), racksOf(review)));
    /* What the operator confirmed teaches the scanner: the printed code of each
       row tied to a PO line, and of each gift. Next time it matches by itself. */
    const teach = [
      ...added.filter((g) => g.printedCode).map((g) => ({ printedCode: g.printedCode, itemCode: g.itemCode })),
      ...codesToTeach(review, (id) => itemOfLine.get(id)),
    ];
    if (teach.length > 0 && review.supplierId && companyId != null) {
      const saved = await saveScanCodes(svc, { companyId, supplierId: review.supplierId, userId: houzsUserId, pairs: teach });
      if (!saved.ok) console.warn('[scan-gr check] gift code not remembered:', saved.reason);
    }
    await svc.from('scan_jobs').update({ review_state: 'created', linked_doc_no: grnNumbers[0], updated_at: new Date().toISOString() })
      .eq('id', r.id).eq('company_id', companyId);
    results.push({ id: r.id, ok: true, grnNumbers, giftNote: [giftNote(added), rackNote, skipped > 0 ? `${skipped} free gift${skipped === 1 ? '' : 's'} could not be added; add them on the draft.` : null].filter(Boolean).join(' ') || null });
  }
  return c.json({ success: true, data: { results } });
});

scanGrCheck.post('/discard', (c) => handleDiscard(c, 'GR'));
scanGrCheck.post('/:id/gold', (c) => handleGold(c, 'GR'));
scanGrCheck.post('/:id/retry', (c) => handleRetry(c, 'GR'));
scanGrCheck.get('/:id/file', (c) => handleFile(c, 'GR'));
