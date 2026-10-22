// ---------------------------------------------------------------------------
// grn-scan-codes — codes a supplier prints on its delivery orders, taught once on
// the scan card ("T1MAMWA0MK is our AKEMI BULWARK MATT (K)"), kept in
// scm.supplier_scan_codes and fed to the matcher as extra bindings for that
// supplier only. HC-0119 / HC-0120.
// ---------------------------------------------------------------------------

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { nameMatchItem, normalizeCode, type GrnMatchResult, type OpenPoLine, type ScannedGrnLine, type SupplierSkuBinding } from './grn-scan-match';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped service client every scm route uses (grn-scan-load.ts)
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export async function loadScanCodes(svc: SupabaseClient, companyId: number | null, supplierId: string): Promise<SupplierSkuBinding[]> {
  let q = svc.from('supplier_scan_codes').select('printed_code, item_code').eq('supplier_id', supplierId);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q;
  // Learning is an aid: without it the scan still matches on bindings and names.
  if (error) { console.warn('[scan-gr] supplier_scan_codes read failed:', error.message); return []; }
  return ((data as Array<{ printed_code: string; item_code: string }> | null) ?? [])
    .map((r) => ({ supplierSku: r.printed_code, acItemCode: null, itemCode: r.item_code }));
}

export async function saveScanCodes(
  svc: SupabaseClient,
  args: { companyId: number; supplierId: string; userId: number | null; pairs: Array<{ printedCode: string; itemCode: string }> },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = new Date().toISOString();
  const rows = args.pairs.map((p) => ({
    company_id: args.companyId,
    supplier_id: args.supplierId,
    printed_code: p.printedCode.trim(),
    code_key: normalizeCode(p.printedCode),
    item_code: p.itemCode,
    created_by: args.userId,
    updated_at: now,
  }));
  const { error } = await svc.from('supplier_scan_codes').upsert(rows, { onConflict: 'company_id,supplier_id,code_key' });
  return error ? { ok: false, reason: error.message } : { ok: true };
}

export type TeachRow = {
  printedCode: string;
  description: string | null;
  qty: number;
  // How the scan treated it: matched by name (confirm it), or not matched.
  status: 'name_matched' | 'not_matched';
  suggestedPoItemId: string | null;
};

export type TeachOptions = {
  rows: TeachRow[];
  poLines: Array<{ poItemId: string; poNumber: string; itemCode: string; materialName: string | null; remaining: number }>;
};

/**
 * What the scan card offers to teach for one scanned delivery order: each
 * printed code the scan could not match by code (one row per code), with the
 * PO line it most likely is, and the lines to choose from — the POs the
 * delivery order named, else every open line of that supplier. Rows printing
 * no code cannot be taught. Pure.
 */
export function buildTeachOptions(
  lines: ScannedGrnLine[],
  match: GrnMatchResult,
  openLines: OpenPoLine[],
  supplierId: string,
): TeachOptions {
  const supplierLines = openLines.filter((l) => l.supplierId === supplierId);
  const named = new Set(match.namedPos);
  const candidates = named.size > 0 ? supplierLines.filter((l) => named.has(l.poNumber)) : supplierLines;
  const firstLineOf = (itemCode: string | null): string | null =>
    itemCode === null ? null : candidates.find((l) => l.itemCode === itemCode)?.poItemId ?? null;

  const byKey = new Map<string, TeachRow>();
  const add = (l: ScannedGrnLine, status: TeachRow['status'], itemCode: string | null): void => {
    const key = normalizeCode(l.itemCode);
    if (!key) return;
    const prev = byKey.get(key);
    if (prev) { prev.qty += l.qty; return; }
    byKey.set(key, {
      printedCode: (l.itemCode ?? '').trim(),
      description: l.description,
      qty: l.qty,
      status,
      suggestedPoItemId: firstLineOf(itemCode ?? nameMatchItem(l.description, candidates)),
    });
  };
  for (const m of match.nameMatches) add(m.line, 'name_matched', m.itemCode);
  for (const u of match.unmatched) {
    if (u.reason === 'not_on_po' || u.reason === 'no_open_po_line') add(u.line, 'not_matched', null);
  }
  return {
    rows: [...byKey.values()],
    poLines: candidates.map((l) => ({ poItemId: l.poItemId, poNumber: l.poNumber, itemCode: l.itemCode, materialName: l.materialName, remaining: l.remaining })),
  };
}
