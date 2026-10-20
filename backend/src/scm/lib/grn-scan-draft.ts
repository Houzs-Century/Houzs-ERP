// ---------------------------------------------------------------------------
// grn-scan-draft — from a delivery order as read (GrnExtracted) to a DRAFT GRN
// or a needs-review note. Shared by the scan pipeline (routes/scan-gr.ts) and the
// "teach codes" re-run, which matches the stored read again without a new OCR
// call. NEVER posts stock; NEVER creates a standalone GRN.
// ---------------------------------------------------------------------------

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import type { Env } from '../env';
import { companyCodeById } from './doc-no';
import { createDraftGrnFromPoItems } from './grn-from-po-core';
import type { GrnExtracted } from './grn-scan-extract';
import { loadOpenPoLines, loadPoStatuses, loadSupplierBindings, loadSuppliers } from './grn-scan-load';
import { loadScanCodes } from './grn-scan-codes';
import {
  describeUnmatchedScanLines, listScanLines, matchGrnScanToPoLines, resolveScannedSupplier,
  type GrnMatchResult, type OpenPoLine, type PoStatusRef, type ScannedGrnLine,
} from './grn-scan-match';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped service client every scm route uses (grn-scan-load.ts)
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const toScanned = (l: GrnExtracted['lines'][number]): ScannedGrnLine => ({
  itemCode: l.itemCode,
  barcode: l.barcode,
  description: l.description,
  qty: l.qty,
  poNo: l.poNo,
});

// A plain-language note for a NEEDS-REVIEW job (no GRN created): tell the
// operator what we saw, line by line, so they can receive from the PO by hand.
export function buildNeedsReviewNote(parsed: GrnExtracted, match: GrnMatchResult, allPos: PoStatusRef[]): string {
  const head = buildNeedsReviewHead(parsed, match);
  if (match.qtyMismatch) return `${head} What we read: ${listScanLines(parsed.lines.map(toScanned).filter((l) => l.qty > 0))}`;
  const lines = describeUnmatchedScanLines(match.unmatched, allPos);
  return lines ? `${head} What we read: ${lines}` : head;
}

function buildNeedsReviewHead(parsed: GrnExtracted, match: GrnMatchResult): string {
  const po = parsed.poNo ? `P.O. ${parsed.poNo}` : 'this delivery order';
  const doRef = parsed.doNo ? ` (D.O. ${parsed.doNo})` : '';
  const poMatched = match.matchedPoNumberValue;
  const tail = 'Please open the right PO and create the goods receipt from it.';
  if (match.refused === 'supplier_unknown') {
    const who = parsed.supplierName ? `"${parsed.supplierName}"` : 'the supplier';
    return `We read ${po}${doRef} but could not tell which of our suppliers ${who} is, so no receipt was created. ${tail}`;
  }
  if (match.refused === 'multiple_pos') {
    return `We read ${po}${doRef} but its items point to more than one PO (${match.matchedPoNumbers.join(', ')}), so no receipt was created. ${tail}`;
  }
  if (match.qtyMismatch) {
    const counts = match.qtyMismatch.map((m) => `${m.listed} listed against ${m.poNumber}, which still owes ${m.owed}`).join('; ');
    return `We read ${po}${doRef} but could not line its items up to the PO by code, and the quantities differ (${counts}), so no receipt was created rather than one for the whole PO. Please open the PO and receive what was delivered.`;
  }
  if (poMatched) {
    return `We read ${po}${doRef} but could not line its items up to open PO ${poMatched} automatically. Please open that PO and receive against it.`;
  }
  return `We could not match ${po}${doRef} to an open purchase order automatically. Please open the PO and create the goods receipt from it.`;
}

export type ScanMatchContext = {
  supplierId: string | null;
  openLines: OpenPoLine[];
  allPos: PoStatusRef[];
  match: GrnMatchResult;
};

// Load everything the matcher needs for this company and run it. Codes taught
// for the resolved supplier (scm.supplier_scan_codes) join the bindings.
export async function matchScan(svc: SupabaseClient, companyId: number | null, parsed: GrnExtracted): Promise<ScanMatchContext> {
  const [openLines, bindings, suppliers, allPos] = await Promise.all([
    loadOpenPoLines(svc, companyId),
    loadSupplierBindings(svc, companyId),
    loadSuppliers(svc, companyId),
    loadPoStatuses(svc, companyId),
  ]);
  const supplierId = resolveScannedSupplier(parsed.supplierName, suppliers);
  const taught = supplierId !== null ? await loadScanCodes(svc, companyId, supplierId) : [];
  const match = matchGrnScanToPoLines(parsed.poNo, parsed.lines.map(toScanned), openLines, [...bindings, ...taught], supplierId);
  return { supplierId, openLines, allPos, match };
}

export type ScanDraftOutcome =
  | { kind: 'needs_review'; note: string }
  | { kind: 'draft'; grnNumbers: string[]; poNumbers: string[]; jobNote: string | null };

export async function draftFromScan(
  env: Env,
  svc: SupabaseClient,
  job: { uploaderStaffId: string; houzsUserId: number | null; companyId: number | null; id: string },
  parsed: GrnExtracted,
): Promise<ScanDraftOutcome> {
  const { match, allPos } = await matchScan(svc, job.companyId, parsed);
  if (match.picks.length === 0) {
    // No confident PO line — never fabricate a standalone GRN or a wrong link.
    return { kind: 'needs_review', note: buildNeedsReviewNote(parsed, match, allPos) };
  }

  // Resolve the company doc prefix from the captured company (headless — no
  // request context). companyCodeById reads public.companies.
  const companyCode = await companyCodeById(svc, job.companyId);
  const doRef = parsed.doNo ? `D.O. ${parsed.doNo}` : 'scanned delivery order';
  const weakNote = match.weakMatch
    ? `Check the PO: only ${match.weakMatch.matched} of ${match.weakMatch.scanned} scanned lines matched ${match.matchedPoNumbers.join(', ')}, so it may be the wrong PO.`
    : null;
  const named = match.nameMatches.length;
  const nameNote = named > 0
    ? `Check the items: ${named} delivery order ${named === 1 ? 'row was' : 'rows were'} matched to the PO by product name, not by code.`
    : null;
  const sets = match.soMatches.length;
  const soNote = sets > 0
    ? `Check the pieces: ${sets} delivery order ${sets === 1 ? 'row was' : 'rows were'} read as a set and received as every piece of ${[...new Set(match.soMatches.map((m) => m.soDocNo))].join(', ')} on the PO.`
    : null;
  // Scanned lines the operator must add by hand, by name, so the draft itself
  // says what is missing. A draft built from the whole PO lists what the
  // delivery order says instead, since every PO line is already on it.
  const unmatchedLines = describeUnmatchedScanLines(match.unmatched, allPos);
  const unmatchedNote = match.poFallback
    ? `Check every line: no scanned line matched ${match.poFallback} by item, so this draft lists everything still owed on ${match.poFallback.includes(',') ? 'those POs' : 'that PO'} at the PO quantity. Change it to what was delivered before posting. The delivery order lists: ${listScanLines(parsed.lines.map(toScanned).filter((l) => l.qty > 0))}`
    : unmatchedLines ? `Not added to this draft: ${unmatchedLines}` : null;
  const res = await createDraftGrnFromPoItems(env, {
    userId: job.uploaderStaffId,
    houzsUserId: job.houzsUserId,
    companyId: job.companyId,
    companyCode,
    picks: match.picks,
    notes: [doRef, weakNote, nameNote, soNote, unmatchedNote].filter(Boolean).join(' · '),
    receivedDate: parsed.deliveryDate ?? undefined,
    deliveryNoteRef: parsed.doNo,
  });

  if (!res.ok) {
    // The convert refused (e.g. a concurrent receive pushed a line over its
    // cap, or the PO is no longer receivable). The delivery order is still
    // valid — land it needs-review, not a red failure, so the operator can
    // receive from the PO by hand.
    const reason =
      typeof res.body.reason === 'string' ? res.body.reason
      : typeof res.body.error === 'string' ? String(res.body.error)
      : 'the receipt could not be created automatically';
    console.error('[scan-gr] convert refused:', job.id, res.status, JSON.stringify(res.body).slice(0, 400));
    return { kind: 'needs_review', note: `We read ${doRef} but ${reason}. Please open the PO and create the goods receipt from it.` };
  }
  if (res.created.length === 0) {
    // Defensive — ok:true with nothing created (every bucket dropped).
    return { kind: 'needs_review', note: `We read ${doRef} but could not create the receipt automatically. Please create it from the PO.` };
  }
  return {
    kind: 'draft',
    grnNumbers: res.created.map((g) => g.grnNumber),
    poNumbers: [...new Set(res.created.flatMap((g) => g.poNumbers))],
    jobNote: [weakNote, nameNote, soNote, unmatchedNote].filter(Boolean).join(' ') || null,
  };
}
