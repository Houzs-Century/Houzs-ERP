
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
