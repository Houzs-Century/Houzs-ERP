// ----------------------------------------------------------------------------
// supplier-code — the number a new supplier gets when nobody types one.
//
// Owner 2026-11-20 (「正常我开supplier时，默认是公司名的字母；至于是400或405也要可以选」):
// a code is the kind (400 trade supplier / 405 other creditor), a dash, the
// first letter of the company name, and the next number in that letter's run
// — TENAGA NASIONAL as an other creditor after 405-T001 is 405-T002.
//
// The NEXT number, never the first gap: a gap is usually a creditor that was
// renamed or retired, and handing its old number to someone else is how one
// company's history ends up under another's code.
// ----------------------------------------------------------------------------

export type SupplierCodeKind = '400' | '405';

export const isSupplierCodeKind = (v: unknown): v is SupplierCodeKind => v === '400' || v === '405';

/** The letter a company's code takes: its name's first letter or digit,
 *  skipping leading punctuation ("(M) SDN" is not a name). Null when the
 *  name has none. */
export function supplierCodeLetter(name: string | null | undefined): string | null {
  const m = /[A-Z0-9]/.exec(String(name ?? '').toUpperCase());
  return m ? m[0] : null;
}

/**
 * The next free code for `kind` and the name's letter, given every code
 * already taken. Null when the name has no letter or digit to file it under.
 */
export function nextSupplierCode(
  kind: SupplierCodeKind,
  name: string | null | undefined,
  taken: Iterable<string | null | undefined>,
): string | null {
  const letter = supplierCodeLetter(name);
  if (!letter) return null;
  const run = new RegExp(`^${kind}-${letter}(\\d+)$`);
  let max = 0;
  for (const code of taken) {
    const m = run.exec(String(code ?? '').trim().toUpperCase());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${kind}-${letter}${String(max + 1).padStart(3, '0')}`;
}
