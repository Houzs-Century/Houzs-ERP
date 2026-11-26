
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
    const { data: jobRow, error: jobErr } = await svc
      .from('scan_jobs')
      .select('sample_id')
      .eq('linked_doc_no', grnNumber)
      .eq('document_type', 'GR')
      .not('sample_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (jobErr || !jobRow) return;
    const j = jobRow as { sampleId?: string | null; sample_id?: string | null };
    const sampleId = j.sampleId ?? j.sample_id ?? null;
    if (!sampleId) return;

    const { data: sample, error: sampleErr } = await svc
      .from('so_scan_samples')
      .select('extracted, status')
      .eq('id', sampleId)
      .maybeSingle();
    if (sampleErr) return;
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
