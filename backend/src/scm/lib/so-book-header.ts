// The Sales Order's AutoCount header spellings — the grid's Doc No / Debtor
// Code / Agent / Venue / Branding cells. One function so the list rows
// (so-list-lines.ts attachSoLines) and the list's funnel value lists
// (so-list-column-funnels.ts) offer the same values.

import { bookSpellingOrOwn, resolveAcAgent, AC_DEBTOR_CODE } from '../../services/autocount-writeback';
import { VENUE_MAP, BRANDING_MAP } from '../../services/autocount-master-maps';
import type { SoBookHeader } from './so-line-export-columns';

const text = (v: string | null | undefined): string | null => String(v ?? '').trim() || null;

/** `acDocNo` is the base table's linked_ac_docno: an order is "in the book"
 *  when it has one. `staffName` is the salesperson's scm.staff name. */
export function soBookHeaderOf(
  r: { doc_no?: string; debtor_code?: string | null; agent?: string | null; venue?: string | null; branding?: string | null },
  acDocNo: string | null,
  staffName: string | null,
): SoBookHeader {
  const docNo = r.doc_no ?? '';
  const inBook = acDocNo != null;
  return {
    ac_doc_no: acDocNo ?? (docNo || null),
    ac_debtor_code: inBook ? (text(r.debtor_code) ?? AC_DEBTOR_CODE) : text(r.debtor_code),
    ac_agent: inBook ? resolveAcAgent(r.agent, staffName) : (text(r.agent) ?? staffName),
    ac_venue: inBook ? bookSpellingOrOwn(r.venue, VENUE_MAP) : text(r.venue),
    ac_branding: inBook ? bookSpellingOrOwn(r.branding, BRANDING_MAP) : text(r.branding),
  };
}
