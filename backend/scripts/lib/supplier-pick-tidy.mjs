// ----------------------------------------------------------------------------
// supplier-pick-tidy — which typed supplier payment terms and banks the new pick
// lists take back, and what to (owner 2026-11-24: 「改，连旧资料一起整理」). Pure:
// tidy-supplier-terms-banks.mjs reads and writes, this decides. Every answer
// carries its reason, for the plan the owner reads before anything is written.
//
// A value is changed only by a rule below; anything else is LEFT AS TYPED (it
// stays the form's Custom / Other text) and the plan names it.
// ----------------------------------------------------------------------------
import { MALAYSIAN_BANKS, PAYMENT_TERMS, listEntryOf } from '../../src/scm/shared/pick-lists.ts';

/** How a picked bank is stored: the database upper-cases a supplier's bank
 *  (scm.upper_typed_text on scm.suppliers.bank_name). */
export const storedBank = (entry) => entry.toUpperCase();

/** A phone number typed into the terms box: digits (8 or more), spaces, dashes, a leading +. */
export const looksLikePhone = (s) => /^\+?[\d\s-]+$/.test(s) && s.replace(/\D/g, '').length >= 8;

/** The term a stored payment term is, or null when no rule knows it.
 *  "30 DAYS", "30 days", "30 terms", "NET30", "Net 30 days" → NET 30 (only a
 *  NET n the list has); "C.O.D." → COD; the list's own entries in any case. */
function termOf(s) {
  const entry = listEntryOf(PAYMENT_TERMS, s);
  if (entry) return { entry, why: 'the list entry, spelled another way' };
  if (s.toUpperCase().replace(/[.\s]/g, '') === 'COD') return { entry: 'COD', why: 'cash on delivery' };
  const m = /^(?:NET\s*)?(\d{1,3})\s*(?:DAYS?|TERMS?)?$/i.exec(s);
  if (m && /\D/.test(s)) {
    const net = listEntryOf(PAYMENT_TERMS, `NET ${Number(m[1])}`);
    if (net) return { entry: net, why: `${Number(m[1])} days` };
  }
  return null;
}

/** What one stored payment term becomes: { to, why } (to null = cleared), or
 *  null to leave it: blank, already the list's spelling, or no rule for it. */
export function tidyTerm(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const t = termOf(s);
  if (t) return t.entry === raw ? null : { to: t.entry, why: t.why };
  if (looksLikePhone(s)) return { to: null, why: 'a phone number, not a term' };
  return null;
}

/* Short names a bank goes by, to its list entry. Only ones that cannot mean another bank. */
const BANK_SHORT_NAMES = new Map([
  ['HLBB', 'Hong Leong Bank'], ['HLB', 'Hong Leong Bank'],
  ['MBB', 'Maybank'], ['MALAYAN BANKING', 'Maybank'],
  ['PBB', 'Public Bank'], ['CIMB', 'CIMB Bank'], ['RHB', 'RHB Bank'],
  ['BSN', 'Bank Simpanan Nasional'],
]);
/* The company's legal suffix: "PUBLIC BANK BERHAD", "MAYBANK BHD", "HONG LEONG BANK (M) BERHAD". */
const LEGAL_SUFFIX = /\s+(?:\((?:M|MALAYSIA)\)\s+)?(?:MALAYSIA\s+)?(?:BERHAD|BHD\.?)$/i;

/** The list entry a stored bank is, or null when no rule knows it. */
function bankOf(s) {
  const entry = listEntryOf(MALAYSIAN_BANKS, s);
  if (entry) return { entry, why: 'the list entry, spelled another way' };
  const bare = s.replace(LEGAL_SUFFIX, '').trim();
  const short = BANK_SHORT_NAMES.get(bare.toUpperCase().replace(/\s+/g, ' '));
  if (short) return { entry: short, why: bare === s ? 'its short name' : 'its short name, with "Berhad"' };
  if (bare !== s) {
    const named = listEntryOf(MALAYSIAN_BANKS, bare);
    if (named) return { entry: named, why: 'its company name ("Berhad")' };
  }
  return null;
}

/** What one stored bank becomes: { to, why } (to = the entry as stored, upper
 *  case), or null to leave it: blank, already right, or no rule for it (a bank
 *  abroad stays as typed under Other). */
export function tidyBank(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const b = bankOf(s);
  if (!b) return null;
  const to = storedBank(b.entry);
  return to === raw ? null : { to, why: b.why };
}

/** A stored value as the shape check reads it: a list entry as stored, or not. */
export const termIsOnList = (v) => PAYMENT_TERMS.includes(v);
export const bankIsOnList = (v) => MALAYSIAN_BANKS.some((e) => storedBank(e) === v);

/** The plan for one company's suppliers: every change, and what is left as typed.
 *  rows: [{ id, code, payment_terms, bank_name }]. */
export function planFor(companyId, rows) {
  const changes = [];
  const leftAsTyped = [];
  for (const r of rows) {
    for (const [field, raw, tidy, onList] of [
      ['payment_terms', r.payment_terms, tidyTerm, termIsOnList],
      ['bank_name', r.bank_name, tidyBank, bankIsOnList],
    ]) {
      const t = tidy(raw);
      if (t) changes.push({ companyId, id: r.id, code: r.code, field, from: raw, to: t.to, why: t.why });
      else if (String(raw ?? '').trim() && !onList(raw)) leftAsTyped.push({ companyId, id: r.id, code: r.code, field, value: raw });
    }
  }
  return { changes, leftAsTyped };
}

/** A value as the public Actions log may show it: a phone number is not printed. */
export const shown = (v) => (v === null || v === undefined ? '(blank)' : looksLikePhone(String(v).trim()) ? '(a phone number)' : JSON.stringify(v));
