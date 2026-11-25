/* Fixed pick lists more than one form offers, kept in one place so a value is
 * spelled one way everywhere (owner 2026-11-24: 「这里有些应该是选的吧？例如term这些」,
 * then 「改，连旧资料一起整理」):
 *   · MALAYSIAN_BANKS — HR's employee form and Finance's supplier form;
 *   · PAYMENT_TERMS — the supplier forms (purchasing's Supplier page, Finance's
 *     Supplier maintenance, the phone's supplier form). The cash flow forecast
 *     reads a supplier's term (acc/cashflow-pnl-forecast parseTermMonths), and
 *     its test pins that it reads every term on this list.
 * A supplier form adds one free-text way out to each (BANK_OTHER for a bank
 * abroad, PAYMENT_TERMS_CUSTOM), and a stored value that is not on the list
 * opens in that box: shown, never blanked.
 *
 * ONE home. backend/src/scm/shared/pick-lists.ts is the original and
 * frontend/src/vendor/shared/pick-lists.ts its byte-identical copy
 * (check-shared-mirrors.mjs).
 */

/** A fixed dropdown, not free text: a bank typed two ways is how a payment file gets rejected. */
export const MALAYSIAN_BANKS: readonly string[] = [
  "Maybank",
  "CIMB Bank",
  "Public Bank",
  "RHB Bank",
  "Hong Leong Bank",
  "AmBank",
  "Bank Islam",
  "OCBC Bank",
  "UOB Bank",
  "HSBC Bank",
  "Affin Bank",
  "Alliance Bank",
  "Bank Simpanan Nasional",
  "Bank Rakyat",
  "Agrobank",
  "MBSB Bank",
  "Standard Chartered",
  "Citibank",
];

/** The bank list's free-text way out: a supplier paid abroad (some bill in RMB). */
export const BANK_OTHER = "Other";

/** A supplier's payment terms. 50/50 and 30/70 are a deposit before and the rest on delivery. */
export const PAYMENT_TERMS: readonly string[] = [
  "COD",
  "NET 7",
  "NET 14",
  "NET 30",
  "NET 45",
  "NET 60",
  "NET 90",
  "50/50",
  "30/70",
  "Advance Payment",
];

/** The terms list's free-text way out. */
export const PAYMENT_TERMS_CUSTOM = "Custom";

const squash = (v: string | null | undefined): string => String(v ?? "").trim().replace(/\s+/g, " ").toUpperCase();

/** The entry of `list` a stored value is, case and spacing aside ("net  30" is
 *  NET 30; "HONG LEONG BANK" is Hong Leong Bank, as the database keeps a
 *  supplier's bank in upper case); null for a blank value or one not on the list. */
export function listEntryOf(list: readonly string[], value: string | null | undefined): string | null {
  const key = squash(value);
  if (!key) return null;
  return list.find((entry) => squash(entry) === key) ?? null;
}
