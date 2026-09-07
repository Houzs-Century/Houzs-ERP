// ----------------------------------------------------------------------------
// so-stock-staleness — "is this line's PENDING stale, or is it true?", in ONE
// place.
//
// WHY IT IS A MODULE. `probe-so-stock-status-stale.mjs` owned this arithmetic
// privately. The go-live gate needs the SAME answer for a different question —
// it reports 220 orders as "AutoCount behind the ERP", and on some of them the
// ERP's own stored `stock_status` is the stale side, which would make that
// sentence wrong in the owner's favour. A second copy of a staleness rule is how
// the two scripts come to disagree about which system is behind, so there is one
// copy and both import it.
//
// ── WHAT THE BRACKET MEANS, AND WHY IT IS A BRACKET ────────────────────────
// The FIFO walk is NOT replayed — that needs the allocator itself, which takes
// the global lock, and a read-only check must never block a production
// recompute. So the answer is a floor and a ceiling:
//
//   UPPER  a non-READY line whose own bucket holds ANY on-hand stock. Some of
//          these are legitimately PENDING because an older order already claimed
//          the units — FIFO competition this cannot see.
//   LOWER  the subset where the bucket's on-hand is >= the TOTAL outstanding
//          demand of every non-READY line in that bucket. FIFO competition
//          cannot explain those: there is enough for all of them and they are
//          still PENDING. That is stale projection, or nothing.
//
// Demand is `qty`, NOT qty-minus-delivered: a partly-shipped line overstates its
// own demand, which can only make LOWER smaller. The conservative direction is
// deliberate — LOWER is a floor and must not be flattered.
//
// EXCLUDED, because the bucket lens does not describe them, and reported so the
// exclusion stays visible:
//   · SOFA lines — allocated by whole-set dye-lot batch coverage, not buckets.
//   · SERVICE lines — no inventory.
//   · lines on an order with NO processing date — correctly PENDING by the
//     owner's own rule (「有 processing date 才来分配」).
//   · lines on a terminal order — the allocator excludes those entirely.
//
// NO `.ts` IMPORTS HERE, deliberately. The predicates that decide SERVICE and
// TERMINAL live in `src/scm/shared/` as TypeScript, and their callers already
// import them; this module takes them as ARGUMENTS instead so it stays a plain
// `.mjs` that any script can load, with or without tsx. They are REQUIRED, not
// optional: an absent predicate would silently widen the population, and a
// staleness count that quietly grew is worse than one that fails to build.
//
// NO SHEBANG — a test may import this (CLAUDE.md: a `#!` that is not at byte 0
// is a load-time SyntaxError under vitest on Windows).
// ----------------------------------------------------------------------------

export const WH_NONE = "NOWH";

/** The allocator's own bucket key: warehouse :: item :: variant. */
export const bucketKey = (warehouseId, itemCode, variantKey) =>
  `${warehouseId ?? WH_NONE}::${itemCode}::${variantKey}`;

/**
 * On-hand per bucket, from `scm.inventory_balances` rows.
 *
 * MUST be fed the VIEW, never a naive `sum(qty)` over `inventory_movements`:
 * the ledger stores OUT as a POSITIVE quantity and the view is what negates it
 * by `movement_type`, so a raw sum answers a different question and hides every
 * negative (recorded 2026-08-18).
 */
export function onHandByBucket(balanceRows) {
  const onHand = new Map();
  for (const b of balanceRows) {
    const key = bucketKey(b.warehouse_id, b.item_code, b.variant_key ?? "");
    onHand.set(key, (onHand.get(key) ?? 0) + Number(b.qty ?? 0));
  }
  return onHand;
}

/**
 * Split SO lines by WHY each one is or is not a staleness candidate.
 *
 * The order of the tests matters: a line is attributed to the FIRST reason that
 * explains it, so nothing is double-counted and nothing correctly-PENDING lands
 * in the bracket.
 *
 * `isServiceLine`, `isTerminalStatus` and `variantKeyOf` are REQUIRED (see the
 * header). `processedOf` decides the processing-date gate — pass the accessor
 * rather than a column name, because the two callers read it off different
 * shapes.
 */
export function classifyStockLines(lines, { isServiceLine, isTerminalStatus, variantKeyOf, processedOf }) {
  for (const [name, fn] of Object.entries({ isServiceLine, isTerminalStatus, variantKeyOf, processedOf })) {
    if (typeof fn !== "function") throw new Error(`so-stock-staleness: ${name} is required and must be a function`);
  }
  const out = { ready: 0, service: 0, sofa: 0, gated: 0, terminal: 0, candidates: [] };
  for (const l of lines) {
    if (!l.item_code) continue;
    if (isTerminalStatus(l)) { out.terminal += 1; continue; }
    if (isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code, category: null })) { out.service += 1; continue; }
    if (String(l.item_group ?? "").toUpperCase().includes("SOFA")) { out.sofa += 1; continue; }
    if (String(l.stock_status ?? "").toUpperCase() === "READY") { out.ready += 1; continue; }
    if (!processedOf(l)) { out.gated += 1; continue; }
    out.candidates.push({ ...l, bucket: bucketKey(l.warehouse_id, l.item_code, variantKeyOf(l)) });
  }
  return out;
}

/**
 * The bracket itself. `upper` and `lower` are the candidate LINES, not counts,
 * so a caller can roll them up per order.
 */
export function stalenessBracket(candidates, onHand) {
  const demand = new Map();
  for (const c of candidates) demand.set(c.bucket, (demand.get(c.bucket) ?? 0) + Number(c.qty ?? 0));
  const upper = candidates.filter((c) => (onHand.get(c.bucket) ?? 0) > 0);
  const lower = upper.filter((c) => (onHand.get(c.bucket) ?? 0) >= (demand.get(c.bucket) ?? 0));
  return { upper, lower, demand };
}
