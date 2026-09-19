// ---------------------------------------------------------------------------
// pi-scan-run — the headless pipeline for a supplier-INVOICE scan: read the
// invoice, anchor it to our OPEN Goods Receipt(s), and convert those receipt
// lines into a DRAFT Purchase Invoice. The PI MIRROR of runScanJob in
// routes/scan-so.ts, sharing the SAME scan_jobs lifecycle, R2 bucket, queue and
// learning table — only the document is different.
//
// SAFETY (non-negotiable, tasks/PLAN-ocr-scan-gr-pi.md):
//   · ONLY ever creates a DRAFT / unposted PI (books no AP, consumes no GRN
//     qty). The DRAFT is raised by createDraftPiFromGrnItems (slice 4), which is
//     draft-only by construction.
//   · CONVERT, NEVER STANDALONE. Every line billed is a line of a matched GRN;
//     if the invoice cannot be anchored to a received GRN (no DO/PO match, or no
//     line codes match), NO PI is created — the job lands a needs-review notice
//     for the operator to bill the GRN by hand. It never guesses a link.
//
// Runs from the queue consumer (processScanQueueMessage) and the stale-job
// reaper, both in routes/scan-so.ts, which rebuild the identity + photos from
// the durable scan_jobs row + R2 and dispatch here when document_type='PI'.
// ---------------------------------------------------------------------------

import type { Env } from '../env';
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { getSupabaseService } from '../../db/supabase';
import { postPersonalNotice } from '../../services/personalNotice';
import { createDraftPiFromGrnItems } from './pi-from-grn-core';
import { remainingToBill } from './outstanding-grn-lines';
import { callClaudePiExtract, loadPiFewShot, type PiScanExtract } from './pi-scan-extract';
import {
  matchInvoiceLinesToGrnLines, docRefMatches, normalizeCode,
  type PiMatchGrnLine,
} from './pi-scan-match';
import type { ContentBlock, UploadedImage } from './scan-anthropic';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-parameterised scm client, same alias as scan-so.ts / scan-sample-review.ts
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

const MSG = {
  noKey: 'Scanning is not configured on the server (no OCR key). Please enter this invoice manually.',
  unreadable:
    'The scan could not read this supplier invoice. Please open the Goods Receipt and create the invoice manually.',
  noAnchor:
    'The scan could not tell which Goods Receipt this invoice is for (no matching D.O. or P.O. number). ' +
    'Please open the received note and bill it manually.',
  noLines:
    'The scan matched a Goods Receipt but none of the invoice lines matched its received items. ' +
    'Please bill the Goods Receipt manually.',
  fallback: 'The scan could not be processed. Please enter this invoice manually.',
};

export type PiScanJob = {
  id: string;
  /** scm.staff UUID captured at enqueue — stamped created_by on the PI. */
  userId: string;
  /** public users bigint — the audit WHO and the notice target. */
  houzsUserId: number | null;
  /** ACTIVE company captured on the scan_jobs row. null = legacy / unresolved. */
  companyId: number | null;
  fileBlocks: ContentBlock[];
  uploadedImages: UploadedImage[];
  firstBuffer: ArrayBuffer | null;
  imageKeys: string[];
};

/** A grns row we may anchor the invoice to. */
type AnchorGrn = {
  id: string;
  grn_number: string;
  delivery_note_ref: string | null;
  purchase_order_id: string | null;
  supplier_id: string | null;
  po_number: string | null;
};

export async function runPiScanJob(env: Env, job: PiScanJob): Promise<void> {
  const svc = getSupabaseService(env);
  const touch = async (patch: Record<string, unknown>): Promise<void> => {
    try {
      const { error } = await svc
        .from('scan_jobs')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', job.id);
      if (error) console.error('[pi-scan-job] job update failed:', job.id, error.message);
    } catch (e) {
      console.error('[pi-scan-job] job update threw:', job.id, (e as Error).message);
    }
  };
  const notice = async (category: 'GENERAL' | 'WARNING', title: string, body: string): Promise<void> => {
    if (job.houzsUserId == null) return;
    await postPersonalNotice(env, {
      userIds: [job.houzsUserId], category, title, body, source: 'scan', expiresDays: 7,
    });
  };
  // A needs-review outcome is NOT a failure: the operator's scan card shows the
  // note, and they bill the GRN by hand. No PI, no wrong link. (A hard system
  // fault uses fail() below and asks them to scan again.)
  const needsReview = async (msg: string): Promise<void> => {
    await touch({ status: 'done', error: msg });
    await notice('WARNING', 'Invoice scan needs review', msg);
  };
  const fail = async (msg: string): Promise<void> => {
    await touch({ status: 'error', error: msg });
    await notice('WARNING', 'Invoice scan could not be processed', `${msg} Please scan again.`);
  };

  try {
    await touch({ status: 'running' });
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('[pi-scan-job] ANTHROPIC_API_KEY missing');
      return await fail(MSG.noKey);
    }

    // 1) READ the invoice (one Claude vision call, confirmed-read few-shot pool).
    const fewShot = await loadPiFewShot(svc);
    const call = await callClaudePiExtract(apiKey, fewShot, job.fileBlocks);
    const parsed = call.parsed;

    // 2) Learning sample + invoice image (best-effort — never blocks the draft).
    const sampleId = await insertPiScanSample(svc, parsed, call.errorMsg, call.claudeText);
    if (sampleId) await touch({ sample_id: sampleId });
    await storePiScanImage(env.SO_ITEM_PHOTOS, svc, sampleId, job.uploadedImages);

    if (!parsed) {
      console.error('[pi-scan-job] extraction failed:', job.id, call.errorMsg);
      return await needsReview(MSG.unreadable);
    }

    // 3) ANCHOR the invoice to our GRN(s) by DO No / PO No — the safety gate.
    const anchors = await findAnchorGrns(svc, parsed, job.companyId);
    if (anchors.length === 0) return await needsReview(MSG.noAnchor);

    // 4) Load the anchored GRNs' outstanding lines + the supplier Article-No map.
    const grnLines = await loadGrnLinesForAnchors(svc, anchors, job.companyId);
    const bindingBySku = await loadSupplierBindings(svc, anchors, job.companyId);

    // 5) MATCH invoice lines -> GRN lines (pure). Never over-bills a line.
    const match = matchInvoiceLinesToGrnLines(parsed.lines, grnLines, bindingBySku);
    if (match.picks.length === 0) return await needsReview(MSG.noLines);

    // 6) CONVERT the matched picks into a DRAFT PI (draft-only, always linked to
    //    the source GRN(s)). companyCode is left null: the headless path mints
    //    the base HC- prefix exactly as the SO scanner's create does (a scan is
    //    Houzs-native), and the source GRN read is still company-scoped by
    //    companyId inside the core.
    const res = await createDraftPiFromGrnItems(env, {
      userId: job.userId,
      houzsUserId: job.houzsUserId,
      companyId: job.companyId,
      allowedCompanyIds: job.companyId != null ? [job.companyId] : null,
      companyCode: null,
      picks: match.picks.map((p) => ({ grnItemId: p.grnItemId, qty: p.qty })),
      supplierInvoiceNumber: parsed.invoiceNumber,
      invoiceDate: parsed.invoiceDate,
    });

    if (!res.ok) {
      // The convert refused (over-invoice race, migrated-source guard, load
      // error). Its reasons are plain sentences; surface one and leave no doc.
      const reason =
        (typeof res.body.message === 'string' && res.body.message) ||
        (typeof res.body.reason === 'string' && res.body.reason) ||
        MSG.fallback;
      console.error('[pi-scan-job] convert refused:', job.id, res.status, JSON.stringify(res.body).slice(0, 400));
      return await needsReview(reason);
    }
    if (res.created.length === 0) {
      // Every bucket rolled back (all picks over-billed a sibling draft). No doc.
      return await needsReview(MSG.noLines);
    }

    const docNos = res.created.map((d) => d.invoiceNumber);
    const grnNumbers = [...new Set(res.created.flatMap((d) => d.grnNumbers))];
    // linked_doc_no is the generic "the document this scan produced" column
    // (mig 20260919T1000). PI writes only it (so_doc_no stays SO-only).
    await touch({ status: 'done', linked_doc_no: docNos.join(', ') });

    // 7) Tell the operator, and name anything left to review (unmatched lines).
    const reviewNote = summarizeUnmatched(match.unmatched.length, parsed);
    const body = [
      `Draft supplier invoice ${docNos.join(', ')} was created from Goods Receipt ${grnNumbers.join(', ')}. `
      + 'Open it to review and confirm — nothing is posted until you do.',
      reviewNote,
    ].filter(Boolean).join(' ');
    await notice(match.unmatched.length > 0 ? 'WARNING' : 'GENERAL', `Invoice saved as a draft — ${docNos.join(', ')}`, body);
  } catch (e) {
    console.error('[pi-scan-job] pipeline threw:', job.id, e);
    await fail(MSG.fallback);
  }
}

function summarizeUnmatched(count: number, _parsed: PiScanExtract): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 invoice line did not match the receipt and was left off — add it on the draft if needed.'
    : `${count} invoice lines did not match the receipt and were left off — add them on the draft if needed.`;
}

// ---------------------------------------------------------------------------
// Reads — all company-scoped by the active company id (the tenant boundary on a
// service-role client). Kept small and targeted (the anchored GRNs only), not a
// company-wide outstanding sweep.
// ---------------------------------------------------------------------------

/** Find the POSTED, not-held GRN(s) this invoice is for: DO No against
 *  delivery_note_ref (strongest), then grn_number, then PO No against
 *  purchase_orders.po_number (suffix-tolerant). Supplier-narrowed when the
 *  invoice named a resolvable supplier. Returns [] when nothing anchors. */
async function findAnchorGrns(
  svc: SupabaseClient,
  parsed: PiScanExtract,
  companyId: number | null,
): Promise<AnchorGrn[]> {
  const doNo = parsed.doNo;
  const poNo = parsed.poNo;
  if (!doNo && !poNo) return [];

  const supplierId = await resolveSupplierId(svc, parsed, companyId);

  let q = svc
    .from('grns')
    .select('id, grn_number, delivery_note_ref, purchase_order_id, supplier_id, purchase_order:purchase_orders ( po_number )')
    .eq('status', 'POSTED')
    .eq('on_hold', false)
    .order('received_at', { ascending: false })
    .limit(400);
  if (companyId != null) q = q.eq('company_id', companyId);
  if (supplierId) q = q.eq('supplier_id', supplierId);

  const { data, error } = await q;
  if (error) {
    console.warn('[pi-scan-job] anchor GRN read failed:', error.message);
    return [];
  }
  const rows = ((data as Array<Record<string, unknown>> | null) ?? []).map((r): AnchorGrn => {
    const po = r.purchase_order as { po_number?: string } | Array<{ po_number?: string }> | null;
    const poNumber = Array.isArray(po) ? po[0]?.po_number ?? null : po?.po_number ?? null;
    return {
      id: String(r.id),
      grn_number: String(r.grn_number ?? ''),
      delivery_note_ref: (r.delivery_note_ref as string | null) ?? null,
      purchase_order_id: (r.purchase_order_id as string | null) ?? null,
      supplier_id: (r.supplier_id as string | null) ?? null,
      po_number: poNumber,
    };
  });

  // DO No is the strongest anchor (one D.O. = one GRN). Prefer it; fall back to
  // PO No (which may name several GRNs — multi-GR -> one PI is supported).
  const byDo = rows.filter((g) => docRefMatches(doNo, g.delivery_note_ref) || docRefMatches(doNo, g.grn_number));
  if (byDo.length > 0) return byDo;
  const byPo = rows.filter((g) => docRefMatches(poNo, g.po_number));
  return byPo;
}

/** Resolve the invoice's supplier to a suppliers.id (by code, then name),
 *  company-scoped. null when unresolvable — the anchor read then runs unnarrowed
 *  by supplier and relies on the DO/PO number alone. */
async function resolveSupplierId(
  svc: SupabaseClient,
  parsed: PiScanExtract,
  companyId: number | null,
): Promise<string | null> {
  const tryOne = async (col: 'code' | 'name', val: string): Promise<string | null> => {
    let q = svc.from('suppliers').select('id').ilike(col, val).limit(1);
    if (companyId != null) q = q.eq('company_id', companyId);
    const { data, error } = await q.maybeSingle();
    // A read failure degrades to "supplier unresolved" (the anchor read then
    // relies on the DO/PO number alone) — never a false "no such supplier".
    if (error) return null;
    return ((data as { id?: string } | null)?.id as string | undefined) ?? null;
  };
  if (parsed.supplierCode) {
    const byCode = await tryOne('code', parsed.supplierCode.trim());
    if (byCode) return byCode;
  }
  if (parsed.supplierName) {
    const byName = await tryOne('name', parsed.supplierName.trim());
    if (byName) return byName;
  }
  return null;
}

/** The anchored GRNs' outstanding lines (remaining-to-bill > 0). */
async function loadGrnLinesForAnchors(
  svc: SupabaseClient,
  anchors: AnchorGrn[],
  companyId: number | null,
): Promise<PiMatchGrnLine[]> {
  const grnById = new Map(anchors.map((a) => [a.id, a.grn_number]));
  let q = svc
    .from('grn_items')
    .select('id, grn_id, item_code, qty_accepted, invoiced_qty, returned_qty, unit_price_sen')
    .in('grn_id', anchors.map((a) => a.id));
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q;
  if (error) {
    console.warn('[pi-scan-job] GRN line read failed:', error.message);
    return [];
  }
  const out: PiMatchGrnLine[] = [];
  for (const r of (data as Array<Record<string, unknown>> | null) ?? []) {
    const remaining = remainingToBill({
      qty_accepted: r.qty_accepted as number | null,
      invoiced_qty: r.invoiced_qty as number | null,
      returned_qty: r.returned_qty as number | null,
    });
    if (remaining <= 0) continue;
    out.push({
      grnItemId: String(r.id),
      grnNumber: grnById.get(String(r.grn_id)) ?? '',
      itemCode: String(r.item_code ?? ''),
      remaining,
      unitPriceSen: Number(r.unit_price_sen ?? 0),
    });
  }
  return out;
}

/** supplier_material_bindings.supplier_sku -> item_code for the anchored GRNs'
 *  supplier(s), so a printed Article No that differs from our code still maps. */
async function loadSupplierBindings(
  svc: SupabaseClient,
  anchors: AnchorGrn[],
  companyId: number | null,
): Promise<Map<string, string>> {
  const supplierIds = [...new Set(anchors.map((a) => a.supplier_id).filter((s): s is string => !!s))];
  const map = new Map<string, string>();
  if (supplierIds.length === 0) return map;
  let q = svc
    .from('supplier_material_bindings')
    .select('item_code, supplier_sku')
    .in('supplier_id', supplierIds);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q;
  if (error) {
    console.warn('[pi-scan-job] supplier binding read failed:', error.message);
    return map;
  }
  for (const r of (data as Array<{ item_code?: string; supplier_sku?: string }> | null) ?? []) {
    const sku = normalizeCode(r.supplier_sku);
    if (sku && r.item_code) map.set(sku, r.item_code);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Learning sample + image provenance — the PI slice of the shared so_scan_samples
// pool (document_type='PI'). The DRAFT->POSTED transition promotes / corrects it
// (notePiScanAccepted). Both writes are best-effort and never block the draft.
// ---------------------------------------------------------------------------

async function insertPiScanSample(
  svc: SupabaseClient,
  parsed: PiScanExtract | null,
  errorMsg: string | null,
  claudeText: string,
): Promise<string | null> {
  try {
    const { data, error } = await svc
      .from('so_scan_samples')
      .insert({
        salesperson: null,
        extracted: parsed ?? { error: errorMsg, claudeText },
        status: parsed ? 'EXTRACTED' : 'FAILED',
        document_type: 'PI',
      })
      .select('id')
      .single();
    if (error) {
      console.error('[pi-scan-job] so_scan_samples insert failed:', error.message);
      return null;
    }
    return (data as { id?: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[pi-scan-job] so_scan_samples insert threw:', (e as Error).message);
    return null;
  }
}

/** Store the FIRST uploaded image as the invoice proof under scan-slips/{sampleId}
 *  (image_key), served back by GET /scan-pi/slip-image. */
async function storePiScanImage(
  bucket: Env['SO_ITEM_PHOTOS'] | undefined,
  svc: SupabaseClient,
  sampleId: string | null,
  uploadedImages: UploadedImage[],
): Promise<void> {
  if (!bucket || !sampleId || uploadedImages.length === 0) return;
  const img = uploadedImages[0];
  const key = `scan-slips/${sampleId}`;
  try {
    await bucket.put(key, img.buffer, { httpMetadata: { contentType: img.mime } });
    const { error } = await svc.from('so_scan_samples').update({ image_key: key }).eq('id', sampleId);
    if (error) console.warn('[pi-scan-job] image_key update failed:', error.message);
  } catch (e) {
    console.warn('[pi-scan-job] R2 put failed:', (e as Error).message);
  }
}
