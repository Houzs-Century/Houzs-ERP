/* The pure rules behind import-product-barcodes.mjs: what a valid EAN-13 is,
   and how a supplier's item code is matched to an ERP product code. */

/** EAN-13: the last digit is the check digit of the first twelve. */
export function ean13Valid(code) {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

/** A code as the matcher sees it: trimmed, inner whitespace collapsed, upper case. */
export const normCode = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

/** The supplier's export prefixes Akemi codes with "AK-" / "AK "; the ERP mostly does not. */
export const stripAk = (s) => normCode(s).replace(/^AK[- ]+/, '');
