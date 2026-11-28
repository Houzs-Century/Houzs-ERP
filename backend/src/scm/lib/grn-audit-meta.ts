import type { Variables } from '../env';

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
