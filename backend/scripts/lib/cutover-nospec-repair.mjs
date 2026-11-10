/* cutover-nospec-repair: the PURE half of repair-cutover-nospec-stock.mjs.
 *
 * WHAT WENT WRONG. The AutoCount cutover (2026-08-29) imported opening stock
 * with NO spec: the migrated GRNs were `migrated_no_stock`, so the cutover lots
 * sit in the item's EMPTY variant_key bucket. Every DO since then ships the
 * spec, so the spec bucket goes negative (its OUTs consume nothing and stay
 * uncosted) while the no-spec bucket is never consumed. Production run
 * 42819884842 (check-variant-key-drift.mjs, section C, company 1): 228 of 284
 * negative buckets after the cutover have an empty-key sibling holding the stock.
 *
 * THE REPAIR, per (company, item, warehouse), owner approved 2026-11-10:
 *   - the empty bucket gives up q units: one ADJUSTMENT -q there. The FIFO
 *     trigger consumes its open lots oldest first, at their real cost;
 *   - the negative spec bucket receives the same units: one ADJUSTMENT +n per
 *     consumed lot, so each opened lot carries exactly that source lot's cost,
 *     in the source lots' order;
 *   - scm.fn_reconcile_uncosted_out (0154, the reconcile every stock IN runs)
 *     then costs the bucket's uncosted DO OUTs from those lots, oldest OUT first.
 *     planUncostedRetrocost (src/scm/lib/oversell-retrocost.ts) is its pure
 *     mirror, kept in lockstep by its own test; the plan below runs it, so the
 *     plan names the DO OUTs the SQL will cost. Nothing here costs anything.
 *
 * WHAT IS LEFT ALONE, with the reason printed:
 *   - a negative bucket with another stocked spec sibling. If any is a
 *     different value (`different-value`: another fabric), it is for people;
 *     if one is merely closer (format / field-one-side / same-key) it belongs to
 *     the variant-key repair, not to the cutover stock;
 *   - an empty bucket whose open lots carry a NULL variant_key (the FIFO trigger
 *     matches the key exactly, so an ADJUSTMENT with '' could not consume them);
 *   - units the reconcile could not cost (drop-ship, cancelled, strict-batch or
 *     non-DO OUTs): moving them would leave lots open in the spec bucket.
 *
 * NEVER: invents stock (q is capped by the empty bucket's open lots AND its
 * movement balance, so neither goes below 0), or prints money.
 * This module imports TypeScript, so it runs under tsx (the runner does) or vitest.
 */
import { planUncostedRetrocost } from '../../src/scm/lib/oversell-retrocost.ts';
import { classifyPair } from './variant-key-drift.mjs';

export const CONFIRM_PHRASE = 'MOVE CUTOVER NO-SPEC STOCK TO THE SHIPPED SPEC';
export const DOC_PREFIX = 'CUTOVER-NOSPEC';
export const REASON_CODE = 'COUNT';

export const SKIP = {
  'different-value': 'a stocked sibling has a different value (another fabric): leave it for people',
  'closer-sibling': 'another stocked spec sibling is closer than the no-spec bucket: the variant-key repair, not this one',
  'spec-has-lots': 'the spec bucket holds open lots',
  'empty-null-vk': 'the no-spec bucket\'s open lots carry a NULL variant_key, which an ADJUSTMENT cannot consume',
  'empty-none': 'the no-spec bucket holds nothing it can give (open lots or movement balance at 0)',
  'empty-exhausted': 'older negative buckets of the same item already took all the no-spec stock',
  'nothing-reconcilable': 'no uncosted DO OUT the reconcile may cost (drop-ship, cancelled, strict-batch or not a DO)',
};

/**
 * ALLOW_CLOSED_MONTHS="2026-09,2026-10" -> Set of months.
 * @returns {{ ok: true, months: Set<string> } | { ok: false, error: string }}
 */
export function parseAllowedMonths(raw) {
  const parts = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(p));
  if (bad.length) return { ok: false, error: `ALLOW_CLOSED_MONTHS must be YYYY-MM,... (bad: ${bad.join(', ')})` };
  return { ok: true, months: new Set(parts) };
}

/**
 * Closed stock months this repair changes. The stock close replays value on
 * movement_date (acc/stock-close.ts), so costing a DO OUT dated in month M
 * lowers the closing value of M and of every later month; the balancing
 * ADJUSTMENT pair, dated today, nets to zero. So: every closed month at or after
 * the earliest month a DO OUT gets cost in.
 * @param {string[]} costedMonths 'YYYY-MM' of each DO OUT that gets cost
 * @param {string[]} closedMonths 'YYYY-MM' with an active STOCKADJ closing entry
 */
export function affectedClosedMonths(costedMonths, closedMonths) {
  if (costedMonths.length === 0) return [];
  const first = [...costedMonths].sort()[0];
  return [...new Set(closedMonths)].filter((m) => m >= first).sort();
}

/** Affected closed months the operator has not named in ALLOW_CLOSED_MONTHS. */
export function unallowedMonths(affected, allowed) {
  return affected.filter((m) => !allowed.has(m));
}

const byTimeThenId = (ta, ia, tb, ib) => (ta < tb ? -1 : ta > tb ? 1 : ia < ib ? -1 : ia > ib ? 1 : 0);

/**
 * Why this negative bucket must not take the no-spec stock, or null.
 * @param {string} vk the negative bucket's key
 * @param {Array<{ vk: string, lotOpen: number }>} stocked buckets of the item at the warehouse holding open lots
 */
export function siblingSkip(vk, stocked) {
  const others = stocked.filter((s) => s.vk !== vk && s.vk !== '' && Number(s.lotOpen) > 0);
  const diff = others.find((s) => classifyPair(vk, s.vk).cls === 'different-value');
  if (diff) return { code: 'different-value', sibling: diff.vk };
  if (others.length) return { code: 'closer-sibling', sibling: others[0].vk, cls: classifyPair(vk, others[0].vk).cls };
  return null;
}

/**
 * Plan one (company, item, warehouse).
 *
 * @param {{
 *   empty: { mov: number, lots: Array<{ lotId: string, receivedAt: string, qtyRemaining: number, unitCostSen: number, rawVk: string|null }> } | null,
 *   negatives: Array<{ vk: string, mov: number, lotOpen: number, firstOutAt: string,
 *     outs: Array<import('../../src/scm/lib/oversell-retrocost.ts').RetroOutMovement & { docNo: string, month: string }> }>,
 *   stocked: Array<{ vk: string, lotOpen: number }>,
 *   cutoffTs: string,
 * }} input
 */
export function planItemWarehouse({ empty, negatives, stocked, cutoffTs }) {
  const emptyLots = (empty?.lots ?? []).filter((l) => Number(l.qtyRemaining) > 0)
    .map((l) => ({ ...l, qtyRemaining: Number(l.qtyRemaining) }))
    .sort((a, b) => byTimeThenId(a.receivedAt, a.lotId, b.receivedAt, b.lotId));
  const emptyLotQty = emptyLots.reduce((s, l) => s + l.qtyRemaining, 0);
  const emptyMov = Number(empty?.mov ?? 0);
  const emptyBefore = { mov: emptyMov, lots: emptyLotQty };
  const fixes = [];
  const skips = [];

  const ordered = [...negatives].sort((a, b) => byTimeThenId(a.firstOutAt, a.vk, b.firstOutAt, b.vk));
  let blocker = null;
  if (emptyLots.some((l) => l.rawVk === null)) blocker = 'empty-null-vk';
  else if (Math.min(emptyMov, emptyLotQty) <= 0) blocker = 'empty-none';
  let left = blocker ? 0 : Math.min(emptyMov, emptyLotQty);
  let lotIdx = 0;

  for (const neg of ordered) {
    const before = { mov: Number(neg.mov), lots: Number(neg.lotOpen) };
    const skip = (code, extra = {}) => skips.push({ vk: neg.vk, code, why: SKIP[code], before, ...extra });
    const sib = siblingSkip(neg.vk, stocked);
    if (sib) { skip(sib.code, { sibling: sib.sibling, cls: sib.cls }); continue; }
    if (before.lots !== 0) { skip('spec-has-lots'); continue; }
    if (blocker) { skip(blocker); continue; }
    const need = -before.mov;
    if (need <= 0) continue;

    /* How much the reconcile can cost in this bucket: run its mirror against one
       lot as large as the hole. Units beyond that would stay as open lots. */
    const reach = planUncostedRetrocost(neg.outs, [{ lotId: 'probe', receivedAt: '0', qtyRemaining: need, unitCostSen: 0 }], cutoffTs).totalRetroQty;
    if (reach <= 0) { skip('nothing-reconcilable'); continue; }
    if (left <= 0) { skip('empty-exhausted'); continue; }
    const qty = Math.min(need, reach, left);

    /* The empty bucket's lots, oldest first, exactly as fn_consume_fifo walks them. */
    const takes = [];
    let want = qty;
    while (want > 0 && lotIdx < emptyLots.length) {
      const lot = emptyLots[lotIdx];
      const take = Math.min(lot.qtyRemaining, want);
      takes.push({ lotId: lot.lotId, receivedAt: lot.receivedAt, qty: take, unitCostSen: Number(lot.unitCostSen ?? 0) });
      lot.qtyRemaining -= take;
      want -= take;
      if (lot.qtyRemaining === 0) lotIdx += 1;
    }
    left -= qty;

    /* The reconcile over the lots the +rows open, in take order (the script
       stamps their received_at so the SQL walks them in this same order). */
    const lots = takes.map((t, i) => ({ lotId: String(i).padStart(6, '0'), receivedAt: String(i).padStart(6, '0'), qtyRemaining: t.qty, unitCostSen: t.unitCostSen }));
    const retro = planUncostedRetrocost(neg.outs, lots, cutoffTs);
    const outById = new Map(neg.outs.map((o) => [o.movementId, o]));
    const costed = retro.lines.map((l) => ({
      movementId: l.movementId, doId: l.doId, qty: l.retroQty, stillShort: l.stillShortQty,
      docNo: outById.get(l.movementId)?.docNo ?? '-', month: outById.get(l.movementId)?.month ?? '-',
      createdAt: outById.get(l.movementId)?.createdAt ?? '',
    }));
    fixes.push({
      vk: neg.vk, need, qty, capped: qty < need, residual: need - qty, takes, costed,
      before, after: { mov: before.mov + qty, lots: 0 },
    });
  }

  const moved = fixes.reduce((s, f) => s + f.qty, 0);
  return { emptyBefore, emptyAfter: { mov: emptyMov - moved, lots: emptyLotQty - moved }, fixes, skips, moved };
}

/**
 * The state an apply leaves, as the planner's input: the empty lots drawn down,
 * each fixed bucket's movements raised, each costed OUT's consumption raised.
 * Used to prove a re-run plans nothing, in tests and after an apply.
 */
export function stateAfter(input, plan) {
  const taken = new Map();
  for (const f of plan.fixes) for (const t of f.takes) taken.set(t.lotId, (taken.get(t.lotId) ?? 0) + t.qty);
  const consumed = new Map();
  for (const f of plan.fixes) for (const c of f.costed) consumed.set(c.movementId, (consumed.get(c.movementId) ?? 0) + c.qty);
  const fixed = new Map(plan.fixes.map((f) => [f.vk, f]));
  return {
    ...input,
    empty: input.empty && {
      mov: Number(input.empty.mov) - plan.moved,
      lots: input.empty.lots.map((l) => ({ ...l, qtyRemaining: Number(l.qtyRemaining) - (taken.get(l.lotId) ?? 0) })),
    },
    negatives: input.negatives.map((n) => ({
      ...n,
      mov: Number(n.mov) + (fixed.get(n.vk)?.qty ?? 0),
      outs: n.outs.map((o) => ({ ...o, alreadyConsumedQty: o.alreadyConsumedQty + (consumed.get(o.movementId) ?? 0) })),
    })).filter((n) => n.mov < 0),
    stocked: input.stocked.map((s) => (s.vk === '' ? { ...s, lotOpen: Number(s.lotOpen) - plan.moved } : s)).filter((s) => s.lotOpen > 0),
  };
}

/** The notes on each ADJUSTMENT row: what moved where, and why. */
export function movementNotes({ side, qty, specVk, ref }) {
  return `Cutover no-spec stock moved to the shipped spec (owner approved 2026-11-10), ${ref}: `
    + `${side === 'from' ? 'no-spec bucket' : 'spec bucket'} ${qty > 0 ? '+' : ''}${qty}; spec "${specVk}". `
    + 'Lots consumed FIFO from the no-spec bucket; their cost reaches the uncosted DO OUTs through fn_reconcile_uncosted_out.';
}
