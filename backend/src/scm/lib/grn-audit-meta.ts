import type { Variables } from '../env';

/* Header fields an entity-audit row needs, read defensively.
   Moved out of routes/grns.ts on 2026-08-20: it is a pure read with no route
   scope, and the file-size ratchet charges GROWTH - the honest way to add the
   transaction wrapper was to give this back rather than raise a ceiling.
   Swallows its error on purpose: audit metadata that cannot be read must not
   fail the write it is describing; the caller records nulls. */
export async function loadGrnAuditMeta(
  sb: Variables['supabase'],
  grnId: string,
): Promise<{ docNo: string | null; companyId: number | null; status: string | null }> {
  try {
    const { data } = await sb.from('grns')
      .select('grn_number, company_id, status').eq('id', grnId).maybeSingle();
    const row = (data ?? null) as { grn_number?: string | null; company_id?: number | null; status?: string | null } | null;
    return { docNo: row?.grn_number ?? null, companyId: row?.company_id ?? null, status: row?.status ?? null };
  } catch {
    return { docNo: null, companyId: null, status: null };
  }
}
