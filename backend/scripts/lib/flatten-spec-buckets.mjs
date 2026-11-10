/* flatten-spec-buckets — the PURE half of flatten-spec-buckets.mjs.
 *
 * Two spec buckets of one item at one warehouse whose movement balances are
 * exact opposites (+n in one, -n in the other) while neither holds an open lot:
 * the item total is right, the split by spec is not. Found on CODY-(K) at KL
 * WAREHOUSE (company 2) after #5597: DO 2990-DO-2611-016 shipped the "Leg 4"
 * unit and the line was later re-specced to "Leg 4 + Total 24", leaving
 * "Leg 4" at +1 and "Leg 4 + Total 24" at -1 with no unit of either on the
 * shelf. Owner approved flattening both to 0 (2026-11-10).
 *
 * HOW THE CORRECTION IS RECORDED. One signed ADJUSTMENT per bucket (-n in the
 * plus bucket, +n in the minus bucket), reason COUNT, notes naming the document
 * and the reason. The FIFO trigger (scm.fn_inventory_movement_fifo) decides
 * what each does to lots:
 *   - the negative ADJUSTMENT runs fn_consume_fifo on that exact bucket; with no
 *     open lot there it consumes nothing (the script re-checks that under the
 *     write and rolls back if any consumption appears);
 *   - the positive ADJUSTMENT always opens a lot row. It is closed in the same
 *     transaction (qty_remaining 0, cost 0), the pattern 0088 / 0198 / 0291
 *     already use for a balancing movement: movement ledger corrected, no open
 *     lot added, no value moved.
 */

export const CONFIRM_PHRASE = 'FLATTEN THESE TWO SPEC BUCKETS';
export const REASON_CODE = 'COUNT';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read and check the inputs. Every one is required: the pair is named, never found.
 * @param {Record<string, string|undefined>} env
 * @returns {{ ok: true, input: { companyId: number, warehouseId: string, itemCode: string, fromVk: string, toVk: string, ref: string, reason: string } } | { ok: false, errors: string[] }}
 */
export function parseInputs(env) {
  const errors = [];
  const companyId = Number(env.COMPANY_ID);
  if (!(Number.isInteger(companyId) && companyId > 0)) errors.push('COMPANY_ID must be a positive integer');
  const warehouseId = String(env.WAREHOUSE_ID ?? '').trim();
  if (!UUID_RE.test(warehouseId)) errors.push('WAREHOUSE_ID must be the warehouse uuid');
  const itemCode = String(env.ITEM_CODE ?? '').trim();
  if (!itemCode) errors.push('ITEM_CODE is required');
  /* Variant keys are compared byte for byte, so they are NOT trimmed or
     re-cased here: a key that only matches after cleaning is a different bucket. */
  const fromVk = env.FROM_VK ?? '';
  const toVk = env.TO_VK ?? '';
  if (!fromVk) errors.push('FROM_VK is required (the exact variant_key)');
  if (!toVk) errors.push('TO_VK is required (the exact variant_key)');
  if (fromVk && toVk && fromVk === toVk) errors.push('FROM_VK and TO_VK are the same bucket');
  const ref = String(env.REF ?? '').trim();
  if (!ref) errors.push('REF is required (the document the movement notes name, e.g. the DO number)');
  const reason = String(env.REASON ?? '').trim();
  if (!reason) errors.push('REASON is required (why, in a few words, for the movement notes)');
  if (errors.length) return { ok: false, errors };
  return { ok: true, input: { companyId, warehouseId, itemCode, fromVk, toVk, ref, reason } };
}

const bucketOf = (buckets, vk) => buckets.get(vk) ?? { mov: 0, lots: 0 };
const total = (buckets, field) => [...buckets.values()].reduce((s, b) => s + Number(b[field] ?? 0), 0);

/**
 * Why the pair must be left alone, as a list (empty = it may be flattened).
 * @param {Map<string, { mov: number, lots: number }>} buckets every bucket of the item at the warehouse
 */
export function refuseReasons(buckets, fromVk, toVk) {
  const from = bucketOf(buckets, fromVk);
  const to = bucketOf(buckets, toVk);
  const out = [];
  if (!buckets.has(fromVk)) out.push(`no movement or lot carries FROM_VK "${fromVk}" for this item here`);
  if (!buckets.has(toVk)) out.push(`no movement or lot carries TO_VK "${toVk}" for this item here`);
  if (from.mov === 0 && to.mov === 0) out.push('both buckets already have movements 0: nothing to flatten');
  else if (from.mov + to.mov !== 0) out.push(`movement balances are not exact opposites (${from.mov} and ${to.mov})`);
  if (from.lots !== 0) out.push(`FROM bucket holds ${from.lots} open lot unit(s): real stock, not a ledger split`);
  if (to.lots !== 0) out.push(`TO bucket holds ${to.lots} open lot unit(s): real stock, not a ledger split`);
  return out;
}

/**
 * The movements that bring both buckets to 0, and every bucket before / after.
 * @returns {{ refusals: string[], moves: Array<{ vk: string, qty: number, closesMintedLot: boolean }>, before: Map, after: Map, totalBefore: { mov: number, lots: number }, totalAfter: { mov: number, lots: number } }}
 */
export function planFlatten(buckets, fromVk, toVk) {
  const refusals = refuseReasons(buckets, fromVk, toVk);
  const moves = [];
  const after = new Map([...buckets].map(([vk, b]) => [vk, { mov: Number(b.mov), lots: Number(b.lots) }]));
  if (refusals.length === 0) {
    for (const vk of [fromVk, toVk]) {
      const mov = bucketOf(buckets, vk).mov;
      if (mov === 0) continue;
      /* Negative first: it must consume nothing, and is checked before the
         positive one opens (and closes) its lot. */
      moves.push({ vk, qty: -mov, closesMintedLot: -mov > 0 });
      after.set(vk, { mov: 0, lots: bucketOf(after, vk).lots });
    }
    moves.sort((a, b) => a.qty - b.qty);
  }
  const totalBefore = { mov: total(buckets, 'mov'), lots: total(buckets, 'lots') };
  const totalAfter = { mov: total(after, 'mov'), lots: total(after, 'lots') };
  if (refusals.length === 0 && (totalBefore.mov !== totalAfter.mov || totalBefore.lots !== totalAfter.lots)) {
    refusals.push(`the item total would change (movements ${totalBefore.mov} -> ${totalAfter.mov}, open lots ${totalBefore.lots} -> ${totalAfter.lots})`);
    moves.length = 0;
  }
  return { refusals, moves, before: buckets, after, totalBefore, totalAfter };
}

/** The movement notes: the document, the reason, and what this row is. */
export function movementNotes({ ref, reason, fromVk, toVk, vk, qty }) {
  const side = vk === fromVk ? 'FROM' : 'TO';
  return `Spec bucket flatten (owner approved), ref ${ref}: ${reason}. `
    + `${side} bucket ${qty > 0 ? '+' : ''}${qty}; pair "${fromVk}" / "${toVk}". `
    + 'Ledger correction only: no lot consumed; any lot this row opens is closed at once.';
}

/**
 * What the next allocation recompute is expected to do to the open SO lines of
 * the two buckets. so-stock-allocation.ts reads scm.inventory_balances (the
 * MOVEMENT ledger, not lots) per (warehouse, item, variant_key), so the bucket's
 * movement balance is the pool these lines draw on. A line counted ready off its
 * own received PO (bound mode) keeps that and takes its units out of the pool
 * first. This is a projection of one bucket in isolation, in the given order
 * (callers pass the allocator's priority: delivery date, then SO number); the
 * worker's recompute decides.
 *
 * @param {Array<{ id: string, doc_no: string, vk: string, qty: number, stock_status: string|null, stock_qty_ready: number|null, bound_received: number }>} lines
 * @param {Map<string, { mov: number }>} before
 * @param {Map<string, { mov: number }>} after
 */
export function projectSoLines(lines, before, after) {
  const out = [];
  for (const vk of [...new Set(lines.map((l) => l.vk))]) {
    const mine = lines.filter((l) => l.vk === vk);
    const pool = (m) => Math.max(0, Number(bucketOf(m, vk).mov));
    let left = pool(after);
    for (const l of mine) {
      const bound = Math.min(Number(l.bound_received ?? 0), Number(l.qty ?? 0));
      if (bound > 0) left = Math.max(0, left - bound);
    }
    for (const l of mine) {
      const ready = ['READY', 'PARTIAL'].includes(String(l.stock_status ?? '')) ? Number(l.stock_qty_ready ?? 0) : 0;
      const bound = Math.min(Number(l.bound_received ?? 0), Number(l.qty ?? 0));
      let keep;
      if (bound > 0) keep = Math.min(ready, bound);
      else { keep = Math.min(ready, left); left -= keep; }
      const status = keep <= 0 ? (ready > 0 ? 'PENDING' : String(l.stock_status ?? 'PENDING')) : keep >= ready ? String(l.stock_status) : 'PARTIAL';
      out.push({
        ...l, poolBefore: Number(bucketOf(before, vk).mov), poolAfter: Number(bucketOf(after, vk).mov),
        readyBefore: ready, readyAfter: keep, statusAfter: status, changes: keep !== ready,
        why: bound > 0 ? 'bound to its own received PO: the pool does not decide it'
          : keep !== ready ? `the bucket no longer backs ${ready - keep} unit(s)` : 'unchanged',
      });
    }
  }
  return out;
}
