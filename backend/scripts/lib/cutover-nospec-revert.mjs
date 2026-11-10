/* cutover-nospec-revert: the PURE half of revert-cutover-nospec-repair.mjs.
 *
 * WHY. Production run 42827135058 of repair-cutover-nospec-stock.mjs (#5611)
 * moved cutover stock out of the no-spec bucket into spec buckets for company 1
 * (Houzs Century) and costed 37 DO OUTs from it. Owner, 2026-11-10: revert it.
 * Houzs binds each SO line to a PO line and does not track stock by spec, so the
 * repair should never have run there.
 *
 * WHAT THE REPAIR WROTE, per (item, warehouse, spec) "group", all rows with
 * source_doc_no CUTOVER-NOSPEC-2026-11-10 and its notes prefix:
 *   - FROM row: ADJUSTMENT -q, variant_key ''. The FIFO trigger wrote one
 *     consumption per no-spec lot it drew, lowering that lot's qty_remaining;
 *   - TO rows: ADJUSTMENT +n per drawn lot, variant_key = spec. The trigger
 *     opened one lot per row ("minted"), stamped with the source lot's cost;
 *   - scm.fn_reconcile_uncosted_out then consumed every minted lot for DO OUTs
 *     of the spec bucket: one consumption per (OUT, lot), minted lots down to 0,
 *     and per OUT `total_cost_sen = COALESCE(total, 0) + added` and
 *     `unit_cost_sen = that / ABS(qty)` (migration 20261026T1600; it touches no
 *     other column). The run recorded no "before" values, so the prior cost is
 *     derived exactly: prior total = total now - SUM(the reconcile's
 *     consumptions on that OUT); prior unit = prior total / ABS(qty), which is
 *     what the trigger wrote (0 for an uncosted OUT).
 *
 * THE REVERT, the repo's own reversal pattern (fn_return_do_units_at_cost and
 * repair-do-resync-return-lots.mjs): consumptions are unwound back to the lots
 * that gave them, a movement is re-costed from the consumptions that remain, and
 * the ledger is balanced by NEW rows rather than by deleting history:
 *   1. delete the reconcile's consumptions; each minted lot back to full;
 *   2. each costed OUT back to its prior cost (exact inverse of the reconcile);
 *   3. delete the FROM row's consumptions; each no-spec lot gets its units back,
 *      so every original lot's qty_remaining is what it was before the run;
 *   4. the FROM row re-costed from what remains of its consumptions: 0;
 *   5. ADJUSTMENT -q in the spec bucket: the trigger consumes exactly the minted
 *      lots (the bucket's only open lots), closing them at their own cost, so
 *      the TO rows' value is taken back out;
 *   6. ADJUSTMENT +q in the no-spec bucket at cost 0 with its lot closed: the
 *      units already went back into the ORIGINAL lots in step 3.
 * Every bucket ends at its pre-repair movements and open lots; every lot at its
 * pre-repair qty_remaining (lots the run minted: closed); value nets to zero.
 *
 * REFUSED, and listed: anything written after the repair in a touched bucket
 * (a new DO, a GRN, a transfer), a minted lot reopened or drawn by anything but
 * the run's reconcile, or rows that do not have the shape the repair writes.
 */

export const REVERT_CONFIRM_PHRASE = 'REVERT THE CUTOVER NO-SPEC REPAIR';
export const REPAIR_RUN_ID = '42827135058';
export const REPAIR_DOC_NO = 'CUTOVER-NOSPEC-2026-11-10';
export const REPAIR_NOTES_PREFIX = 'Cutover no-spec stock moved to the shipped spec';
export const REVERT_DOC_PREFIX = 'CUTOVER-NOSPEC-REVERT';
export const REVERT_REASON_CODE = 'COUNT';
/* The reconcile ran in the repair's own transaction, so its consumptions carry
   (about) the repair rows' timestamp. Anything further off was written later. */
export const CONSUMED_AT_TOLERANCE_MS = 10 * 60_000;

/** The spec a repair row's notes name (`spec "<vk>". Lots consumed ...`), or null. */
export function specOfRepairNotes(notes) {
  const m = /; spec "(.*)"\. Lots consumed FIFO/.exec(String(notes ?? ''));
  return m ? m[1] : null;
}

/** The marker a revert row carries for the repair FROM row it balances. */
export const revertMarker = (fromRowId) => `repair row ${fromRowId}`;

/** The notes on each revert row: what it balances, which run, and why. */
export function revertNotes({ side, qty, specVk, fromRowId, ref, runId = REPAIR_RUN_ID, repairDocNo = REPAIR_DOC_NO }) {
  return `Reverts the cutover no-spec repair, run ${runId} (${repairDocNo}), owner instruction 2026-11-10: `
    + 'this company binds each SO line to a PO line and does not track stock by spec. '
    + `${ref}: ${side === 'empty' ? 'no-spec bucket' : 'spec bucket'} ${qty > 0 ? '+' : ''}${qty}; spec "${specVk}"; ${revertMarker(fromRowId)}.`;
}

/** Milliseconds of a timestamp; a zone-less one is UTC (the script reads them so). */
const ms = (t) => {
  if (typeof t === 'number') return Number.isFinite(t) ? t : null;
  if (t === null || t === undefined || t === '') return null;
  const v = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(String(t)) ? String(t) : `${t}Z`);
  return Number.isFinite(v) ? v : null;
};

/**
 * Split the repair's rows into groups: one FROM row and its TO rows per
 * (item, warehouse, spec). Rows that fit no group are returned as problems.
 * @param {Array<{ id: string, itemCode: string, warehouseId: string, vk: string, qty: number, notes: string, createdAt: string }>} rows
 */
export function groupRepairRows(rows) {
  const groups = new Map();
  const problems = [];
  const keyOf = (r, spec) => `${r.itemCode}\u0001${r.warehouseId}\u0001${spec}`;
  for (const r of rows) {
    const spec = specOfRepairNotes(r.notes);
    if (spec === null || spec === '') { problems.push(`repair row ${r.id}: its notes name no spec`); continue; }
    const k = keyOf(r, spec);
    if (!groups.has(k)) groups.set(k, { itemCode: r.itemCode, warehouseId: r.warehouseId, specVk: spec, from: [], to: [] });
    const g = groups.get(k);
    if (r.vk === '' && Number(r.qty) < 0) g.from.push(r);
    else if (r.vk === spec && Number(r.qty) > 0) g.to.push(r);
    else problems.push(`repair row ${r.id}: bucket "${r.vk}" qty ${r.qty} is neither the no-spec -q row nor a spec +n row`);
  }
  for (const g of groups.values()) {
    if (g.from.length !== 1) problems.push(`${g.itemCode} [${g.specVk}]: ${g.from.length} no-spec -q rows, expected 1`);
    if (g.to.length === 0) problems.push(`${g.itemCode} [${g.specVk}]: no spec +n rows`);
  }
  return { groups: [...groups.values()].filter((g) => g.from.length === 1 && g.to.length > 0), problems };
}

const sumBy = (xs, f) => xs.reduce((s, x) => s + Number(f(x)), 0);
const multiset = (xs) => xs.map((x) => `${x[0]}@${x[1]}`).sort().join(',');

/**
 * Plan the revert of one group.
 *
 * @param {{
 *   itemCode: string, warehouseId: string, specVk: string,
 *   from: { id: string, qty: number, totalCostSen: number, createdAt: string },
 *   to: Array<{ id: string, qty: number, unitCostSen: number }>,
 *   reverted: boolean,
 *   fromConsumptions: Array<{ id: string, lotId: string, qty: number, unitCostSen: number }>,
 *   emptyLots: Array<{ lotId: string, vk: string, qtyReceived: number, qtyRemaining: number }>,
 *   mintedLots: Array<{ lotId: string, movementId: string, vk: string, qtyReceived: number, qtyRemaining: number }>,
 *   mintedConsumptions: Array<{ id: string, lotId: string, movementId: string, qty: number, totalCostSen: number,
 *     movementType: string, sourceDocType: string, movementCreatedAt: string, consumedAt: string|null }>,
 *   outs: Array<{ movementId: string, qty: number, totalCostSen: number, consumedQty: number, doId: string, docNo: string, month: string }>,
 *   later: Array<{ id: string, movementType: string, docNo: string, vk: string, qty: number, createdAt: string }>,
 * }} g
 */
export function planGroupRevert(g) {
  const base = { itemCode: g.itemCode, warehouseId: g.warehouseId, specVk: g.specVk, fromRowId: g.from.id };
  if (g.reverted) return { ...base, status: 'already-reverted', problems: [], q: 0 };
  const problems = [];
  const q = -Number(g.from.qty);
  const repairTs = ms(g.from.createdAt);

  for (const l of g.later) {
    problems.push(`written after the repair: ${l.movementType} ${l.docNo || '-'} [${l.vk === '' ? '(no spec)' : l.vk}] qty ${l.qty} at ${l.createdAt}`);
  }

  /* FROM row: the units it drew, lot by lot, and the TO rows that received them. */
  if (sumBy(g.fromConsumptions, (c) => c.qty) !== q) problems.push(`the no-spec -${q} row has ${sumBy(g.fromConsumptions, (c) => c.qty)} unit(s) of consumptions, expected ${q}`);
  if (sumBy(g.to, (t) => t.qty) !== q) problems.push(`the spec +n rows add ${sumBy(g.to, (t) => t.qty)}, the no-spec row took ${q}`);
  if (multiset(g.fromConsumptions.map((c) => [c.qty, c.unitCostSen])) !== multiset(g.to.map((t) => [t.qty, t.unitCostSen]))) {
    problems.push('the spec +n rows do not match the no-spec lots drawn (quantity and cost per lot)');
  }
  const emptyById = new Map(g.emptyLots.map((l) => [l.lotId, l]));
  const restoreEmpty = new Map();
  for (const c of g.fromConsumptions) restoreEmpty.set(c.lotId, (restoreEmpty.get(c.lotId) ?? 0) + Number(c.qty));
  for (const [lotId, add] of restoreEmpty) {
    const l = emptyById.get(lotId);
    if (!l) { problems.push(`no-spec lot ${lotId} not found`); continue; }
    if (l.vk !== '') problems.push(`lot ${lotId} the -q row drew is in bucket "${l.vk}", not the no-spec bucket`);
    if (Number(l.qtyRemaining) + add > Number(l.qtyReceived)) problems.push(`no-spec lot ${lotId}: giving back ${add} would exceed what it received`);
  }

  /* Minted lots: one per TO row, fully drawn by the reconcile and by nothing else. */
  const mintedByMovement = new Map();
  for (const l of g.mintedLots) mintedByMovement.set(l.movementId, [...(mintedByMovement.get(l.movementId) ?? []), l]);
  for (const t of g.to) {
    const ls = mintedByMovement.get(t.id) ?? [];
    if (ls.length !== 1) problems.push(`the spec +${t.qty} row opened ${ls.length} lot(s), expected 1`);
    else if (Number(ls[0].qtyReceived) !== Number(t.qty) || ls[0].vk !== g.specVk) problems.push(`the lot opened by a spec +${t.qty} row received ${ls[0].qtyReceived} in "${ls[0].vk}"`);
  }
  const mintedIds = new Set(g.mintedLots.map((l) => l.lotId));
  for (const l of g.mintedLots) {
    if (Number(l.qtyRemaining) !== 0) problems.push(`a lot the repair opened holds ${l.qtyRemaining} again (something gave units back to it)`);
    const drawn = sumBy(g.mintedConsumptions.filter((c) => c.lotId === l.lotId), (c) => c.qty);
    if (drawn !== Number(l.qtyReceived)) problems.push(`a lot the repair opened (${l.qtyReceived}) has ${drawn} unit(s) of consumptions`);
  }
  for (const c of g.mintedConsumptions) {
    if (!mintedIds.has(c.lotId)) continue;
    const late = ms(c.movementCreatedAt) !== null && repairTs !== null && ms(c.movementCreatedAt) >= repairTs;
    const off = c.consumedAt && ms(c.consumedAt) !== null && repairTs !== null && Math.abs(ms(c.consumedAt) - repairTs) > CONSUMED_AT_TOLERANCE_MS;
    if (c.movementType !== 'OUT' || c.sourceDocType !== 'DO' || late || off) {
      problems.push(`a lot the repair opened was drawn by ${c.movementType} ${c.sourceDocType} ${c.movementId}${late ? ' created after the repair' : ''}${off ? ' at another time than the repair' : ''}`);
    }
  }

  /* The DO OUTs the reconcile costed: back to their prior cost. */
  const removed = new Map();
  for (const c of g.mintedConsumptions) {
    if (!mintedIds.has(c.lotId)) continue;
    const r = removed.get(c.movementId) ?? { qty: 0, sen: 0 };
    removed.set(c.movementId, { qty: r.qty + Number(c.qty), sen: r.sen + Number(c.totalCostSen) });
  }
  const outResets = [];
  for (const [movementId, r] of removed) {
    const o = g.outs.find((x) => x.movementId === movementId);
    if (!o) { problems.push(`DO OUT ${movementId} not found`); continue; }
    const toTotal = Number(o.totalCostSen) - r.sen;
    if (toTotal < 0) problems.push(`DO OUT ${o.docNo}: its cost is below what the reconcile added (changed since)`);
    const absQty = Math.abs(Number(o.qty));
    outResets.push({
      movementId, doId: o.doId, docNo: o.docNo, month: o.month, qty: absQty, qtyRemoved: r.qty,
      consumedAfter: Number(o.consumedQty) - r.qty,
      fromTotalSen: Number(o.totalCostSen), toTotalSen: toTotal, toUnitSen: absQty > 0 ? Math.trunc(toTotal / absQty) : 0,
    });
  }
  outResets.sort((a, b) => (a.docNo < b.docNo ? -1 : a.docNo > b.docNo ? 1 : a.movementId < b.movementId ? -1 : 1));

  if (problems.length) return { ...base, status: 'refused', problems, q };
  return {
    ...base, status: 'revert', problems: [], q,
    deleteConsumptionIds: [...g.mintedConsumptions.filter((c) => mintedIds.has(c.lotId)).map((c) => c.id), ...g.fromConsumptions.map((c) => c.id)],
    mintedRestores: g.mintedLots.map((l) => ({ lotId: l.lotId, add: Number(l.qtyReceived), expectRemaining: 0 })),
    emptyRestores: [...restoreEmpty].map(([lotId, add]) => ({ lotId, add, expectRemaining: Number(emptyById.get(lotId).qtyRemaining) })),
    outResets,
    fromRecost: { movementId: g.from.id, expectTotalSen: Number(g.from.totalCostSen), toTotalSen: 0 },
    specMinus: { vk: g.specVk, qty: -q, consumes: g.mintedLots.map((l) => ({ lotId: l.lotId, qty: Number(l.qtyReceived) })) },
    emptyPlus: { vk: '', qty: q },
  };
}

/**
 * The buckets of one (item, warehouse) after the planned reverts, from their
 * state now. Map vk -> { mov, lots }.
 */
export function bucketsAfterRevert(now, plans) {
  const after = new Map([...now].map(([vk, b]) => [vk, { mov: Number(b.mov), lots: Number(b.lots) }]));
  const at = (vk) => { if (!after.has(vk)) after.set(vk, { mov: 0, lots: 0 }); return after.get(vk); };
  for (const p of plans) {
    if (p.status !== 'revert') continue;
    const e = at('');
    e.mov += p.emptyPlus.qty;
    e.lots += sumBy(p.emptyRestores, (r) => r.add);
    const s = at(p.specVk);
    s.mov += p.specMinus.qty;
    s.lots += sumBy(p.mintedRestores, (r) => r.add) - sumBy(p.specMinus.consumes, (c) => c.qty);
  }
  return after;
}

/**
 * The buckets of one (item, warehouse) before the repair, derived from the rows
 * alone: movements without the repair's and the revert's rows; open lots without
 * the lots those rows opened, plus what the repair's -q rows still hold drawn.
 * @param {Map<string, { mov: number, lots: number }>} now
 * @param {Array<{ vk: string, qty: number }>} ownRows the repair's and the revert's movements
 * @param {Array<{ vk: string, qtyRemaining: number }>} ownLots the lots those rows opened
 * @param {Array<{ vk: string, qty: number }>} drawnByRepair consumptions of the repair's -q rows that still exist, by lot bucket
 */
export function bucketsBeforeRepair(now, ownRows, ownLots, drawnByRepair) {
  const pre = new Map([...now].map(([vk, b]) => [vk, { mov: Number(b.mov), lots: Number(b.lots) }]));
  const at = (vk) => { if (!pre.has(vk)) pre.set(vk, { mov: 0, lots: 0 }); return pre.get(vk); };
  for (const r of ownRows) at(r.vk).mov -= Number(r.qty);
  for (const l of ownLots) if (Number(l.qtyRemaining) > 0) at(l.vk).lots -= Number(l.qtyRemaining);
  for (const c of drawnByRepair) at(c.vk).lots += Number(c.qty);
  return pre;
}

/** Buckets equal: every key in either map at the same movements and open lots. */
export function sameBuckets(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].every((k) => {
    const x = a.get(k) ?? { mov: 0, lots: 0 };
    const y = b.get(k) ?? { mov: 0, lots: 0 };
    return x.mov === y.mov && x.lots === y.lots;
  });
}

/** The signature the apply re-checks inside its transaction. */
export function planSignature(plans) {
  return JSON.stringify(plans.map((p) => [p.fromRowId, p.status, p.q,
    (p.outResets ?? []).map((o) => [o.movementId, o.qtyRemoved, o.toTotalSen]),
    (p.emptyRestores ?? []).map((r) => [r.lotId, r.add, r.expectRemaining]),
    (p.deleteConsumptionIds ?? []).slice().sort()]));
}

/**
 * Plan one (item, warehouse): its groups, the buckets now / after the revert /
 * before the repair, and whether the revert may run. Any problem in any group,
 * or an after-revert state that is not exactly the pre-repair one, refuses the
 * whole (item, warehouse): its groups share the no-spec bucket.
 *
 * @param {{
 *   groups: Array<Parameters<typeof planGroupRevert>[0]>,
 *   now: Map<string, { mov: number, lots: number }>,
 *   ownRows: Array<{ vk: string, qty: number }>,
 *   ownLots: Array<{ vk: string, qtyRemaining: number }>,
 *   drawnByRepair: Array<{ vk: string, qty: number }>,
 * }} input
 */
export function planPair({ groups, now, ownRows, ownLots, drawnByRepair }) {
  const plans = groups.map(planGroupRevert);
  const problems = plans.flatMap((p) => p.problems.map((m) => `[${p.specVk}] ${m}`));
  const touched = new Set(['', ...groups.map((g) => g.specVk)]);
  const nowT = new Map([...touched].map((vk) => [vk, now.get(vk) ?? { mov: 0, lots: 0 }]));
  const pre = bucketsBeforeRepair(nowT, ownRows, ownLots, drawnByRepair);
  const after = bucketsAfterRevert(nowT, plans);
  const toRevert = plans.filter((p) => p.status === 'revert');

  /* The spec -q row must consume exactly the lots the repair opened: the spec
     bucket may hold no other open lot. */
  for (const p of toRevert) {
    const lots = Number(nowT.get(p.specVk)?.lots ?? 0);
    if (lots !== 0) problems.push(`[${p.specVk}] the spec bucket holds ${lots} open unit(s) the repair did not leave there`);
  }
  /* Two groups may give units back to the same no-spec lot. */
  const lotAdd = new Map();
  for (const p of toRevert) for (const r of p.emptyRestores) lotAdd.set(r.lotId, (lotAdd.get(r.lotId) ?? 0) + r.add);
  for (const g of groups) for (const l of g.emptyLots) {
    if (lotAdd.has(l.lotId) && Number(l.qtyRemaining) + lotAdd.get(l.lotId) > Number(l.qtyReceived)) {
      problems.push(`no-spec lot ${l.lotId}: giving back ${lotAdd.get(l.lotId)} would exceed what it received`);
    }
  }
  if (toRevert.length && !problems.length && !sameBuckets(after, pre)) problems.push('the state after the revert would not equal the state before the repair');

  const status = problems.length ? 'refused' : toRevert.length ? 'revert' : 'already-reverted';
  return { plans, pre, after, now: nowT, problems: [...new Set(problems)], status };
}
