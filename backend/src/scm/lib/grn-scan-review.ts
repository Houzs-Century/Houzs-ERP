// ---------------------------------------------------------------------------
// grn-scan-review — closes the GR OCR self-learning loop.
//
// The confirmation event for a scanned Goods Receipt is the DRAFT -> POSTED
// transition (PATCH /grns/:id/post): the moment the operator makes the receipt
// permanent is the moment they vouch that the scanned delivery order was read
// well enough to convert. That is the GR twin of the SO scanner's
// DRAFT -> CONFIRMED trigger (noteScanDraftAccepted, scan-sample-review.ts).
//
// WHY WE ONLY EVER MARK ACCEPTED (no rebuilt-correction blob like SO):
//   The learning sample is the extraction of the SUPPLIER's DELIVERY ORDER —
//   supplier codes, supplier P.O. No, supplier layout. The posted GRN's lines
//   are OUR item codes carried from the PO line, a DIFFERENT vocabulary. So
//   there is nothing faithfully invertible from the GRN back onto the DO
//   extraction; reading GRN lines back would manufacture a supplier->our-code
//   "correction" nobody wrote. The honest signal a post gives is "this delivery
//   order was read correctly enough to receive" — a positive few-shot example.
//   We therefore promote EXTRACTED -> ACCEPTED (corrected = extracted), exactly
//   the SO scanner's "confirmed unchanged" branch, and never fabricate a diff.
//
// Best-effort and silent: never throws, never blocks the post.
// ---------------------------------------------------------------------------

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';

type SupabaseClient = SupabaseClientGeneric<any, any, any>;

const SAMPLE_EXTRACTED = 'EXTRACTED';
const SAMPLE_ACCEPTED = 'ACCEPTED';

/**
 * Called on a GRN DRAFT -> POSTED transition. If this GRN came from a background
 * delivery-order scan, record the operator's verdict: the extraction that
 * produced it lands ACCEPTED, feeding the GR few-shot pool.
 *
 * @param grnNumber the posted GRN's grn_number (== scan_jobs.linked_doc_no for
 *                  a scanned GRN).
 */
export async function noteGrnScanAccepted(
  svc: SupabaseClient,
  grnNumber: string,
): Promise<void> {
  try {
    if (!grnNumber) return;
    // 1. Did this GRN come from a background GR scan? scan_jobs.linked_doc_no is
    //    the generic produced-doc link (mig 20260919T1000); GR jobs write only
    //    it (never so_doc_no). Scope to document_type='GR' so a stray SO row
    //    that happens to share a number can't cross the streams.
    const { data: jobRow, error: jobErr } = await svc
      .from('scan_jobs')
      .select('sample_id')
      .eq('linked_doc_no', grnNumber)
      .eq('document_type', 'GR')
      .not('sample_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (jobErr || !jobRow) return; // fail-soft: a lookup error never costs the post
    // postgres.js camelCases columns; PostgREST does not. Dual-read is the house
    // rule (same shape as scan-so.ts's job serializer).
    const j = jobRow as { sampleId?: string | null; sample_id?: string | null };
    const sampleId = j.sampleId ?? j.sample_id ?? null;
    if (!sampleId) return;

    // 2. Promote EXTRACTED -> ACCEPTED, carrying `extracted` across as the
    //    confirmed reading. Gated on status='EXTRACTED' so a re-post (POSTED ->
    //    ... -> POSTED never happens, but a redelivery / double-fire) counts the
    //    scan exactly once and never buries an already-reviewed sample.
    const { data: sample, error: sampleErr } = await svc
      .from('so_scan_samples')
      .select('extracted, status')
      .eq('id', sampleId)
      .maybeSingle();
    if (sampleErr) return; // fail-soft
    const s = sample as { extracted?: unknown; status?: string | null } | null;
    if (!s || s.status !== SAMPLE_EXTRACTED || s.extracted == null) return;

    await svc
      .from('so_scan_samples')
      .update({ corrected: s.extracted, status: SAMPLE_ACCEPTED })
      .eq('id', sampleId)
      .eq('status', SAMPLE_EXTRACTED);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[grn-scan-review] review note failed (non-fatal):', grnNumber, (e as Error).message);
  }
}
