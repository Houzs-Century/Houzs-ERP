// ----------------------------------------------------------------------------
// cn-extract — read a SUPPLIER CREDIT NOTE with Claude vision (owner
// 2026-10-01: supplier 给我 cn，我要做 ocr for cn；这个 cn 可能会 link 去相对应的
// supplier invoice).
//
// The bill reader's sibling (acc/bill-extract.ts): the same model and the same
// discipline — strict JSON, an unreadable field is null and never invented, RM
// turned into sen HERE once, and matching to system rows (the supplier, the
// invoice) done by the caller in plain code. What differs is the paper: the
// issuer GIVES credit, a line may name the invoice it credits (and the supplier's
// own item code), and the remark often says why — "25% display discount",
// "Sales Rebate", "Booth Rental Sponsor". NOTHING here writes.
// ----------------------------------------------------------------------------

import { isoOrNull, readPaperJson, rmToSen, type BillFile } from './bill-extract';

export type CnLine = {
  /** The line's words as printed: the item's name and anything printed under it
      (an event, a period) — never the item code, which has its own field. */
  description: string | null;
  /** The invoice this line credits, when the line prints one. */
  invoiceNo: string | null;
  /** The supplier's own item / article code. */
  itemCode: string | null;
  qty: number | null;
  unitPriceSen: number | null;
  /** The line total as printed (before tax). */
  amountSen: number | null;
};

export type CnExtraction = {
  /** False when the paper is not a credit note at all (an invoice, a statement). */
  isCreditNote: boolean;
  vendorName: string | null;
  vendorRegNo: string | null;
  cnNumber: string | null;
  cnDate: string | null;
  /** Every invoice number the note names, on its lines or in its header — once each. */
  invoiceNumbers: string[];
  subtotalSen: number | null;
  sstSen: number | null;
  totalSen: number | null;
  /** The printed remark or reason, e.g. "25% display discount". */
  remark: string | null;
  lines: CnLine[];
};

const PROMPT = `You are reading ONE supplier CREDIT NOTE received by a Malaysian furniture company's finance clerk. The supplier issued it: it reduces what the company owes that supplier. The input images/PDF pages all belong to THIS ONE document.

Return ONLY a JSON object, no prose, with exactly these keys:
{
  "isCreditNote": true when the paper is titled CREDIT NOTE / CREDIT MEMO / CN, false when it is something else (an invoice, a statement, a receipt),
  "vendorName": the ISSUING company's name as printed (the supplier giving the credit) or null,
  "vendorRegNo": the issuer's registration number as printed (e.g. 1459872-U, 202301027399) or null,
  "cnNumber": the credit note's own number or null,
  "cnDate": the credit note date as YYYY-MM-DD or null,
  "invoiceNumbers": every invoice number the note says it credits (in the header or on its lines), each once, [] when none is printed,
  "subtotalRm": the total before tax as a plain number, or null,
  "sstRm": the sales tax / SST amount as a plain number, 0 when printed as 0.00, null when not printed,
  "totalRm": the GRAND TOTAL of the credit (after tax) as a plain number, or null,
  "remark": the printed remark / reason / note explaining the credit (e.g. "25% display discount"), or null,
  "lines": every credited line in order [{ "description": the line's words (the item's name plus anything printed under it, such as an event or period) without the item code, "invoiceNo": the invoice this line credits or null, "itemCode": the supplier's item / article code or null, "qty": number or null, "unitPriceRm": number or null, "amountRm": the line total as printed or null }]
}

Rules:
- Read what is PRINTED. A field you cannot read with confidence is null — NEVER estimated, NEVER computed from other fields.
- Dates: Malaysian papers print DD/MM/YYYY — convert to YYYY-MM-DD. A date you cannot disambiguate is null.
- vendorName is the ISSUER, never the addressee ("To Messrs" is our own company).
- Never list the Total / Sales Tax / Total Amount / amount-in-words rows as lines.
- A line that only restates the invoice number above its items (e.g. "Invoice No. X:") is not a line.
- Descriptions stay under 160 characters, in the paper's own words.`;

const text = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  return s ? s.slice(0, max) : null;
};

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Coerce whatever the model said into the strict shape — every field, because
    a vision model under a bad scan says strange things and none may crash a
    finance screen. */
export function coerceCnJson(raw: unknown): CnExtraction {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const linesRaw = Array.isArray(o.lines) ? o.lines : [];
  const lines: CnLine[] = linesRaw.slice(0, 300).map((l) => {
    const li = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    return {
      description: text(li.description, 200),
      invoiceNo: text(li.invoiceNo, 80),
      itemCode: text(li.itemCode, 80),
      qty: numOrNull(li.qty),
      unitPriceSen: rmToSen(li.unitPriceRm),
      amountSen: rmToSen(li.amountRm),
    };
  }).filter((l) => l.description != null || l.amountSen != null);
  const named = Array.isArray(o.invoiceNumbers) ? o.invoiceNumbers : [];
  const invoiceNumbers = [...new Set([
    ...named.map((n) => text(n, 80)).filter((n): n is string => !!n),
    ...lines.map((l) => l.invoiceNo).filter((n): n is string => !!n),
  ])];
  return {
    isCreditNote: o.isCreditNote !== false,
    vendorName: text(o.vendorName, 200),
    vendorRegNo: text(o.vendorRegNo, 60),
    cnNumber: text(o.cnNumber, 80),
    cnDate: isoOrNull(o.cnDate),
    invoiceNumbers,
    subtotalSen: rmToSen(o.subtotalRm),
    sstSen: rmToSen(o.sstRm),
    totalSen: rmToSen(o.totalRm),
    remark: text(o.remark, 200),
    lines,
  };
}

/** ONE credit note (its pages as files) → one vision call. */
export async function extractOneCreditNote(
  apiKey: string,
  files: BillFile[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; extraction: CnExtraction } | { ok: false; reason: string }> {
  const read = await readPaperJson(apiKey, files, PROMPT, fetchImpl);
  if (!read.ok) return read;
  if (!read.json) return { ok: false, reason: 'The reader answered, but not with a credit note — try a clearer scan.' };
  return { ok: true, extraction: coerceCnJson(read.json) };
}
