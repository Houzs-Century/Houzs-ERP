// The rules of the supplier change-code tool (scripts/recode-suppliers.mjs),
// kept pure so the tests pin them.
//
// A supplier's code is the creditor number Finance reads, and the books carry
// it as text: every journal line its paper posts holds it as party_code, and
// so does each supplier credit note. The prefix also picks the creditor
// control (acc/rules.ts apControlRole): 400- is trade (AP, 400-0000), 405- is
// "other creditors" (AP_OTHER, 405-0000). Editing the code alone leaves the
// ledger on the old code and the balance on the old control, which is why the
// supplier screen refuses it once a supplier has history
// (scm/lib/supplier-finance.ts). This tool moves the code WITH its history.
//
// Owner 2026-11-20 (A: 连旧账一起搬): the history moves as if the supplier had
// always carried the new code, the way 0349 moved the first 405 bill.

import { apControlRole, DEFAULT_ROLE_CODES } from '../../src/acc/rules.ts';

const CODE = /^[0-9]{3}-[A-Z0-9]+$/;

/**
 * Read MAP="OLD:NEW,OLD:NEW". Refuses anything that could land two suppliers
 * on one code or depend on the order the pairs run in.
 *
 * @param {string | null | undefined} text
 * @returns {{ ok: true, pairs: Array<{ oldCode: string, newCode: string }> } | { ok: false, reason: string }}
 */
export function parseRecodeMap(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, reason: 'MAP is empty: give OLD:NEW pairs separated by commas' };
  const pairs = [];
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const bits = item.split(':');
    if (bits.length !== 2) return { ok: false, reason: `"${item}" is not OLD:NEW` };
    const oldCode = bits[0].trim().toUpperCase();
    const newCode = bits[1].trim().toUpperCase();
    if (!CODE.test(oldCode)) return { ok: false, reason: `"${oldCode}" is not a creditor code like 400-A001` };
    if (!CODE.test(newCode)) return { ok: false, reason: `"${newCode}" is not a creditor code like 405-A001` };
    if (oldCode === newCode) return { ok: false, reason: `${oldCode} maps to itself` };
    pairs.push({ oldCode, newCode });
  }
  if (pairs.length === 0) return { ok: false, reason: 'MAP has no pairs' };
  const olds = new Set();
  const news = new Set();
  for (const p of pairs) {
    if (olds.has(p.oldCode)) return { ok: false, reason: `${p.oldCode} appears twice as an old code` };
    if (news.has(p.newCode)) return { ok: false, reason: `${p.newCode} is the new code of two suppliers` };
    olds.add(p.oldCode);
    news.add(p.newCode);
  }
  /* A chain (A->B, B->C) or a swap (A->B, B->A) would make the result depend
     on which pair runs first, and the unique code index would refuse a swap
     halfway through. Two runs do it safely; one run never tries. */
  for (const p of pairs) {
    if (olds.has(p.newCode)) return { ok: false, reason: `${p.newCode} is both a new code and an old code: run the chain as two separate runs` };
  }
  return { ok: true, pairs };
}

/**
 * The creditor control account codes for a company: its acc_account_roles
 * rows over the defaults, as acc/rules.ts resolveRoles reads them.
 *
 * @param {Array<{ role: string, account_code: string | null }>} rows
 * @returns {{ AP: string, AP_OTHER: string }}
 */
export function creditorControls(rows) {
  const out = { AP: DEFAULT_ROLE_CODES.AP, AP_OTHER: DEFAULT_ROLE_CODES.AP_OTHER };
  for (const r of rows ?? []) {
    if ((r.role === 'AP' || r.role === 'AP_OTHER') && r.account_code) out[r.role] = r.account_code;
  }
  return out;
}

/**
 * Which control account the supplier's ledger lines move between, or null when
 * the old and the new code book to the same control.
 *
 * @param {string} oldCode
 * @param {string} newCode
 * @param {{ AP: string, AP_OTHER: string }} controls
 * @returns {{ from: string, to: string } | null}
 */
export function controlMove(oldCode, newCode, controls) {
  const from = controls[apControlRole(oldCode)];
  const to = controls[apControlRole(newCode)];
  return from === to ? null : { from, to };
}
