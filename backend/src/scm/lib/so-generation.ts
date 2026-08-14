export type SoGenerationResult =
  | { applied: true; version: number; previous: Record<string, unknown> }
  | { applied: false; reason: 'not_found' | 'lease' | 'conflict'; currentVersion?: number };

const leaseActive = (row: { edit_lease_token?: string | null; edit_lease_expires_at?: string | null }): boolean => {
  if (!row.edit_lease_token || !row.edit_lease_expires_at) return false;
  const expires = Date.parse(row.edit_lease_expires_at);
  return Number.isFinite(expires) && expires > Date.now();
};

/**
 * Canonical system/mirror writer for an SO header. It participates in the same
 * monotonically increasing generation as human edits and stands down while a
 * composite edit lease is active. Callers recompute on conflict; they never
 * overwrite a newer header snapshot.
 */
export async function advanceSoGeneration(
  sb: any,
  docNo: string,
  patch: Record<string, unknown>,
  expected?: { version?: number; status?: string | null },
): Promise<SoGenerationResult> {
  const { data: current, error: loadError } = await sb.from('mfg_sales_orders')
    .select('doc_no, status, version, edit_lease_token, edit_lease_expires_at')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (loadError) throw loadError;
  if (!current) return { applied: false, reason: 'not_found' };
  const row = current as Record<string, unknown> & {
    status?: string | null; version?: number | string;
    edit_lease_token?: string | null; edit_lease_expires_at?: string | null;
  };
  const version = Number(row.version ?? 1);
  if (leaseActive(row)) return { applied: false, reason: 'lease', currentVersion: version };
  if ((expected?.version !== undefined && expected.version !== version)
      || (expected?.status !== undefined && expected.status !== row.status)) {
    return { applied: false, reason: 'conflict', currentVersion: version };
  }
  /* company-scope: doc_no IS mfg_sales_orders' PRIMARY KEY
     (2990s-full-schema.sql:638) and the numbering is prefix-partitioned per
     company (companyDocPrefix: HOUZS 'HC-', others '<CODE>-'), so one doc_no
     names exactly one company's order. A company predicate here would be
     redundant, not safer. */
  let query = sb.from('mfg_sales_orders').update({
    ...patch,
    version: version + 1,
    updated_at: new Date().toISOString(),
  }).eq('doc_no', docNo).eq('version', version)
    .or(`edit_lease_token.is.null,edit_lease_expires_at.lt.${new Date().toISOString()}`);
  if (row.status != null) query = query.eq('status', row.status);
  const { data: saved, error } = await query.select('version').maybeSingle();
  if (error) throw error;
  if (!saved) return { applied: false, reason: 'conflict', currentVersion: version };
  return { applied: true, version: version + 1, previous: row };
}
