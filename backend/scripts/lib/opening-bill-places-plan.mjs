/* The rules behind set-opening-bill-places.mjs: Finance's choices of where
   payments of the opening bills read in the Cash Flow (owner 2026-11-25,
   「要，做 A」), as asked for, checked against the company and turned into
   changes. Imported by backend/tests/openingBillPlacesPlan.test.mjs. */

/** A place as stored: exactly one of account / category; null = no choice. */
export const placeText = (p) => (p === null ? '(none)' : p.account !== null ? p.account : `@${p.category}`);
const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.account === b.account && a.category === b.category);

/** "KEY>PLACE,KEY>PLACE" — a place is an account code, @<category id>, or - to clear. */
export function parsePairs(text, what) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const at = item.indexOf('>');
    if (at <= 0 || at === item.length - 1) return { ok: false, message: `${what}: "${item}" is not KEY>PLACE` };
    const key = item.slice(0, at).trim();
    const placeRaw = item.slice(at + 1).trim();
    if (seen.has(key)) return { ok: false, message: `${what}: ${key} is named twice` };
    seen.add(key);
    const place = placeRaw === '-' ? null
      : placeRaw.startsWith('@') ? { account: null, category: placeRaw.slice(1) }
        : { account: placeRaw, category: null };
    if (place !== null && (place.account === '' || place.category === '')) return { ok: false, message: `${what}: ${key} has an empty place` };
    out.push({ key, place });
  }
  return { ok: true, pairs: out };
}

/** The ids of the Cash Flow categories this company prints (an unticked one and all under it left out). */
export function visibleCategories(tree, companyId) {
  const out = new Set();
  const walk = (list) => {
    for (const it of Array.isArray(list) ? list : []) {
      if (!it || it.kind !== 'category') continue;
      if (Array.isArray(it.hiddenFor) && it.hiddenFor.includes(companyId)) continue;
      out.add(String(it.id));
      walk(it.children);
    }
  };
  walk(tree?.blocks?.accounts);
  return out;
}

/**
 * The plan for one company. `asked`: { suppliers: [{key, place}], bills: [{key, place}] }.
 * `facts`: suppliers by code → id (only those with opening bills), opening bills by number → id,
 * the company's accounts by code → { money, active }, the visible category ids, and the current
 * choices by supplier id and by bill id. Anything that does not check out refuses the plan.
 */
export function planFor(asked, facts) {
  const refused = [];
  const changes = [];
  const checkPlace = (label, p) => {
    if (p === null) return;
    if (p.account !== null) {
      const a = facts.accounts.get(p.account);
      if (!a || !a.active) refused.push(`${label}: ${p.account} is not an active account of this company`);
      else if (a.money) refused.push(`${label}: ${p.account} is a bank or cash account`);
    } else if (!facts.categories.has(p.category)) refused.push(`${label}: @${p.category} is not on this company's Cash Flow`);
  };
  for (const { key, place } of asked.suppliers) {
    const id = facts.supplierIdOf.get(key);
    if (!id) { refused.push(`supplier ${key}: no supplier of this company with that code has an opening bill`); continue; }
    checkPlace(`supplier ${key}`, place);
    const from = facts.supplierPlaces.get(id) ?? null;
    if (!same(from, place)) changes.push({ kind: 'supplier', key, id, from, to: place });
  }
  for (const { key, place } of asked.bills) {
    const id = facts.billIdOf.get(key);
    if (!id) { refused.push(`bill ${key}: not an opening bill of this company`); continue; }
    checkPlace(`bill ${key}`, place);
    const from = facts.billPlaces.get(id) ?? null;
    if (!same(from, place)) changes.push({ kind: 'bill', key, id, from, to: place });
  }
  return { refused, changes };
}

/** What is wrong with the choices as re-read: a planned place that did not land, or a row of the wrong shape. */
export function shapeProblems(changes, now, facts) {
  const out = [];
  for (const c of changes) {
    const got = (c.kind === 'supplier' ? now.suppliers : now.bills).get(c.id) ?? null;
    if (!same(got, c.to)) out.push(`${c.kind} ${c.key} holds ${placeText(got)}, planned ${placeText(c.to)}`);
  }
  for (const [kind, map] of [['supplier', now.suppliers], ['bill', now.bills]]) {
    for (const [id, p] of map) {
      if ((p.account === null) === (p.category === null)) out.push(`${kind} ${id} holds neither or both of an account and a category`);
      else if (p.account !== null && !facts.accounts.has(p.account)) out.push(`${kind} ${id} holds ${p.account}, not an account of this company`);
    }
  }
  return out;
}
