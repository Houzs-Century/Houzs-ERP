/* The phone "Log sale" prompt is free text, so the browser does not block a
   thousands comma the way a type="number" field does. parseFloat("12,000") is
   12, which logged RM 12 for a RM 12,000 sale. The shared money parser reads
   1,200 / 12,345.50 correctly and refuses ambiguous shapes ("1,20") with a
   sentence the prompt shows under the field. */

import { parseMoneyToSen, senToRm } from "../lib/money";

const LABEL = "The sale amount";

/** Prompt validator: null when the text is a positive amount, else the message to show. */
export function validateSaleAmount(text: string): string | null {
  const r = parseMoneyToSen(text, LABEL);
  if (!r.ok) return r.message;
  if (r.empty || r.sen <= 0) return "Enter a positive amount, for example 12,000.";
  return null;
}

/** RM for the API payload. Only call after `validateSaleAmount` returned null. */
export function saleAmountRm(text: string): number {
  const r = parseMoneyToSen(text, LABEL);
  if (!r.ok || r.empty || r.sen <= 0) throw new Error(validateSaleAmount(text) ?? "Invalid sale amount");
  return senToRm(r.sen);
}
