// pnl-tree — the owner's P&L expense tree: the Cash Flow tree's own groups
// laid over the EXPENSES section of the chart (2026-09-19: pnl 那边的 account
// 显示要和 cash flow 一样 — 分父子 account). The P&L and the Performance P&L
// share it: their `expenses` block takes this tree, every other block keeps
// the chart's own (defaultLayout), so income, cost of sales and taxation
// read as they did.
//
// The shape (one tree, both companies; a group a company never uses is
// unticked for it, as on the Cash Flow):
//   Exhibition & roadshow expense (Houzs only) · Showrooms expense
//   Warehouse expense (Houzs only)
//   Administrative expense → Salary & related · Rental · Homestay · Marketing ·
//     Professional & statutory · Office & admin · Transport & logistics ·
//     Commission
//   Finance cost
// The Cash Flow's Cost of funds group has no P&L twin (owner 2026-09-21: 移去
// general expense, 改成 administrative expense): its Transport and Commission
// members file under Administrative expense, and its Purchases and Accounts
// payable are cost of sales and creditors — other blocks, other statements —
// so an expense the rules send there is listed as unmatched and lands in
// Office & admin.
// An account goes where the Cash Flow's rule sends it (groupOf — ONE rule
// table for both statements, so the two can never file an expense apart);
// an expense the rules place outside these groups — none on today's chart —
// lands in Office & admin and is listed.
//
// Pure: no database, no clock. The seeding script and its test both call it.

import { groupOf } from './cash-flow-tree.mjs';

const HOUZS_ONLY = [2]; // hidden for 2990 HOME (company 2)

/** The Cash Flow group an expense rule names → its home on the P&L tree. */
const HOME = {
  'cf:ops:cost:transport': 'pl:general:transport',
  'cf:ops:cost:commission': 'pl:general:commission',
  'cf:ops:exh': 'pl:exh',
  'cf:ops:showroom': 'pl:showroom',
  'cf:ops:warehouse': 'pl:warehouse',
  'cf:ops:general:salary': 'pl:general:salary',
  'cf:ops:general:rental': 'pl:general:rental',
  'cf:ops:general:homestay': 'pl:general:homestay',
  'cf:ops:general:marketing': 'pl:general:marketing',
  'cf:ops:general:professional': 'pl:general:professional',
  'cf:ops:general:office': 'pl:general:office',
  'cf:finance': 'pl:finance',
};
const FALLBACK = 'pl:general:office';

const cat = (id, label, children, extra = {}) => ({ kind: 'category', id, label, ...extra, children });

function skeleton() {
  return [
    cat('pl:exh', 'Exhibition & roadshow expense', [], { hiddenFor: HOUZS_ONLY }),
    cat('pl:showroom', 'Showrooms expense', []),
    cat('pl:warehouse', 'Warehouse expense', [], { hiddenFor: HOUZS_ONLY }),
    cat('pl:general', 'Administrative expense', [
      cat('pl:general:salary', 'Salary & related', []),
      cat('pl:general:rental', 'Rental - office & others', []),
      cat('pl:general:homestay', 'Homestay, hostel & accommodation', []),
      cat('pl:general:marketing', 'Advertising & marketing', []),
      cat('pl:general:professional', 'Professional & statutory', []),
      cat('pl:general:office', 'Office & admin', []),
      cat('pl:general:transport', 'Transport & logistics', []),
      cat('pl:general:commission', 'Commission', []),
    ]),
    cat('pl:finance', 'Finance cost', []),
  ];
}

const index = (items, into = new Map()) => {
  for (const it of items) if (it.kind === 'category') { into.set(it.id, it); index(it.children, into); }
  return into;
};

/** A category with nothing under it is dropped — a Purchases group with no
    expense account would only clutter the editor. */
const prune = (items) => items.flatMap((it) => {
  if (it.kind !== 'category') return [it];
  const children = prune(it.children);
  return children.length === 0 ? [] : [{ ...it, children }];
});

/** Where an expense account sits on the P&L tree — by the Cash Flow's rule for it. */
export function expenseHomeOf(code) {
  const g = groupOf(code);
  const home = HOME[g.id];
  return home ? { id: home, unmatched: Boolean(g.unmatched) } : { id: FALLBACK, unmatched: true };
}

/**
 * @param {Array<{code: string, name?: string}>} expenses — the EXPENSES-section accounts, both companies (codes unique)
 * @returns {{ items: object[], mapping: Array<{code: string, name: string, group: string, unmatched: boolean}>, unmatched: string[] }}
 */
export function buildPnlExpenseTree(expenses) {
  const tree = skeleton();
  const byId = index(tree);
  const mapping = [];
  const unmatched = [];
  const seen = new Set();
  for (const a of [...expenses].sort((x, y) => x.code.localeCompare(y.code))) {
    const code = String(a.code).trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const h = expenseHomeOf(code);
    byId.get(h.id).children.push({ kind: 'account', code });
    mapping.push({ code, name: a.name ?? '', group: h.id, unmatched: h.unmatched });
    if (h.unmatched) unmatched.push(code);
  }
  return { items: prune(tree), mapping, unmatched };
}

/** A report's whole layout: the chart's own tree (`base`, from defaultLayout), its expenses block replaced by the P&L expense tree. */
export const withExpenseTree = (base, items) => ({ version: 1, blocks: { ...base.blocks, expenses: items } });

export const topIdsOf = (items) => (items ?? []).map((it) => it.id);
