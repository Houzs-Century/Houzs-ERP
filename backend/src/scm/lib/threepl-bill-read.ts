// ----------------------------------------------------------------------------
// threepl-bill-read — read a TRANSPORT company's bill, or the sheet attached to
// it, line by line: which deliveries it charges for and how much (owner
// 2026-10-23: 「先做」 — the 3PL invoices tab filled from the AP invoice).
//
// The bill reader's sibling (acc/bill-extract.ts readPaperJson): same model,
// same discipline — strict JSON, an unreadable field is null and never
// invented, RM turned into sen HERE once, and matching to system rows (the
// delivery orders) done in plain code (threepl-bill-match.ts). What differs is
// the paper: MSJ writes one row per order by hand ("6/10-SO-013216 RM120"),
// NEST LIVING lists every DO of a trip under one price, EU LOGISTICS names the
// customer's slip ("ZNT6656"). NOTHING here writes.
// ----------------------------------------------------------------------------
import { isoOrNull, readPaperJson, rmToSen, type BillFile } from '../../acc/bill-extract';
import type { AiUsageTag } from '../../services/aiUsage';

/** What a line charges for. Only 'delivery' lines are priced per DO; the rest
 *  are listed beside them and never counted into a DO (owner 2026-10-23:
 *  「仓储，搬运不算」, setup / dismantle / dispose listed separately). */
export type BillLineKind = 'delivery' | 'setup' | 'dismantle' | 'dispose' | 'storage' | 'handling' | 'other';
export const BILL_LINE_KINDS: readonly BillLineKind[] = ['delivery', 'setup', 'dismantle', 'dispose', 'storage', 'handling', 'other'];

/** One order number as printed on a line — never interpreted here. */
export type PrintedOrder = { doNo: string | null; soNo: string | null; ref: string | null };

export type TransportBillLine = {
  /** The line's own words, short, as printed. */
  text: string;
  date: string | null;
  place: string | null;
  kind: BillLineKind;
  amountSen: number | null;
  /** Every order the line charges for — several when one price covers a trip. */
  orders: PrintedOrder[];
};

const PROMPT = `You are reading a bill, or a sheet attached to a bill, from a Malaysian transport / logistics company to a furniture retailer (Houzs Century or 2990). The input pages all belong to this one bill.
List every charge it makes. Return ONLY a JSON object, no prose:
{"lines":[{"text": the line's own words, short (under 120 chars), "date": "YYYY-MM-DD" or null, "place": the destination / venue as printed or null, "kind": one of "delivery" | "setup" | "dismantle" | "dispose" | "storage" | "handling" | "other", "amountRm": the line's amount as a plain number or null, "orders": [{"doNo": a delivery order number exactly as printed (e.g. HC-DO-2609-152, DO-010676) or null, "soNo": a sales order number exactly as printed (e.g. HC-SO-012467, 6/10-SO-013216, 2990-SO-2606-037) or null, "ref": any other order / slip / service number printed for the customer (e.g. HC12975, ZNT6656, ASSR/2607-047) or null}]}]}
Rules:
- One entry per charge, in printed order. When ONE price covers several deliveries (one trip delivering several orders), return ONE entry with the price and ALL their numbers in "orders"; a row that only lists another order of that trip without its own price belongs to that entry.
- "kind": "delivery" for transport / delivery / service-case trips to a customer; "setup", "dismantle" for an exhibition booth; "dispose" for disposal of old furniture; "storage" for warehouse storage; "handling" for handling in / out.
- Read what is PRINTED. A number you cannot read with confidence is null — never guessed, never completed. Handwritten "SO" stays "SO", not "50" or "80".
- Dates: Malaysian papers print DD/MM or DD/MM/YYYY — return YYYY-MM-DD only when the year is printed or obvious from the bill date, else null.
- Never list a Total / Sub Total / Grand Total / tax / amount-in-words row as a charge.`;

const text = (v: unknown, max: number): string | null => {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  return s ? s.slice(0, max) : null;
};

const kindOf = (raw: unknown): BillLineKind => {
  const k = String(raw ?? '').trim().toLowerCase();
  if (k === 'transport') return 'delivery';
  return (BILL_LINE_KINDS as readonly string[]).includes(k) ? (k as BillLineKind) : 'other';
};

/** Coerce whatever the model said into the strict shape — every field, because
    a vision model under a bad scan says strange things and none may crash the
    screen. 300 lines and 40 orders a line are runaway guards, not limits. */
export function coerceTransportBill(raw: unknown): TransportBillLine[] {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lines = Array.isArray(o.lines) ? o.lines.slice(0, 300) : [];
  return lines.map((l) => {
    const li = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    const orders = (Array.isArray(li.orders) ? li.orders.slice(0, 40) : []).map((x) => {
      const or = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      return { doNo: text(or.doNo, 60), soNo: text(or.soNo, 60), ref: text(or.ref, 60) };
    }).filter((x) => x.doNo || x.soNo || x.ref);
    return {
      text: text(li.text, 160) ?? '',
      date: isoOrNull(li.date),
      place: text(li.place, 120),
      kind: kindOf(li.kind),
      amountSen: rmToSen(li.amountRm),
      orders,
    };
  }).filter((l) => l.text || l.amountSen != null || l.orders.length > 0);
}

/** ONE bill (its pages / sheets as files) → one vision call. */
export async function readTransportBill(
  apiKey: string,
  files: BillFile[],
  usage: AiUsageTag | null,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; lines: TransportBillLine[] } | { ok: false; reason: string }> {
  const read = await readPaperJson(apiKey, files, PROMPT, usage, fetchImpl);
  if (!read.ok) return read;
  if (!read.json) return { ok: false, reason: 'The reader answered, but not with the bill’s lines — try a clearer scan.' };
  return { ok: true, lines: coerceTransportBill(read.json) };
}
