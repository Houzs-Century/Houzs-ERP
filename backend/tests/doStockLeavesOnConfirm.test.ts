// Stock leaves the warehouse when the delivery order is CONFIRMED, and it
// leaves exactly once.
//
// THE OWNER, 2026-08-22: 「once confirmed就代表出货了 就是直接扣库存」 and
// 「draft 没出货，Confirmed就代表出货了 然后delivered只是记录而已，记录送到了」.
// `LOADED` is what every screen renders as **Confirmed** (status-pill.ts), so
// the deduction moved from `DISPATCHED` to `LOADED` and `Delivered` became a
// record of arrival rather than the thing that moves anything.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT — stated plainly, because a test
// that overstates its reach is how the next reader comes to trust a thing that
// is not true.
//
//   · The RULE is exercised for real. `ladderWalk` below runs a delivery order
//     up the status ladder against a fake movement table, using the SAME
//     predicate the route uses to decide the write (`DO_SHIPPED_STATES`
//     membership, imported from its one home) and the SAME guard shape
//     `deductInventoryForDo` opens with (any existing OUT row for this DO and it
//     returns without writing). The assertions are about behaviour: which hop
//     writes, and how many rows exist afterwards.
//   · The CODE is pinned structurally. The handler needs a live database and a
//     Hono context to execute, so the source assertions below hold the route to
//     the two shapes the simulation models. If either drifts, the simulation
//     stops describing the code and this file fails rather than going quietly
//     green — the failure mode `check-shared-mirrors` and the classifyTests pin
//     exist to prevent elsewhere.
//
// PRODUCTION SAFETY, MEASURED RATHER THAN ARGUED. Promoting `LOADED` cannot
// re-deduct anything that already shipped:
//   · run 32573972467 (2026-08-22) — 44 delivery orders: 30 DISPATCHED, 12
//     DELIVERED, 2 CANCELLED, and ZERO in DRAFT / LOADED / IN_TRANSIT / SIGNED /
//     INVOICED. Nothing occupies the promoted state, and the 30 DISPATCHED rows
//     never transition, so nothing re-fires on them.
//   · run 32574476216 (2026-08-22, check-duplicate-movements.mjs section 0, read
//     from pg_indexes) — `uq_inv_mov_do_source_v2` is live on
//     scm.inventory_movements, UNIQUE over (source_doc_type, source_doc_id,
//     item_code, variant_key, COALESCE(correction_seq,0)) WHERE
//     source_doc_type='DO'. `movement_type` is not in the key, so Postgres
//     refuses a second primary posting even if the application guard were
//     bypassed. The same run reports ZERO multi-row DO buckets in production.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DO_SHIPPED_STATES,
  DO_PRESHIP_STATES,
  DO_STOCK_OUT_STATES,
  DO_STATUSES,
  CONFIRM_HOP_STATES,
  doCountsAsDelivered,
} from '../src/scm/shared/do-shipped-states';

const ROUTE = readFileSync(
  resolve(__dirname, '../src/scm/routes/delivery-orders-mfg.ts'),
  'utf8',
);

/* ── The simulation ─────────────────────────────────────────────────────────
   A delivery order walked up a ladder of statuses, against a fake
   inventory_movements table. Both rules come from the code under test:

     WHEN does the OUT fire?  entry into a member of DO_SHIPPED_STATES —
                              imported, never re-typed here.
     WHEN is it suppressed?   deductInventoryForDo's guard #1: if any row exists
                              for (source_doc_type='DO', this DO, 'OUT'), return
                              without writing.

   Returns the status at which the first OUT landed, and every write attempted,
   so a test can assert on both the moment and the count. */
function ladderWalk(ladder: readonly string[]): { firstOutAt: string | null; rows: number; attempts: string[] } {
  const movements: Array<{ source_doc_type: string; source_doc_id: string; movement_type: string }> = [];
  const DO_ID = 'do-under-test';
  const attempts: string[] = [];
  let firstOutAt: string | null = null;

  for (const toStatus of ladder) {
    if (!(DO_SHIPPED_STATES as readonly string[]).includes(toStatus)) continue;
    attempts.push(toStatus);
    // deductInventoryForDo, guard #1 — the existence check, verbatim in shape.
    const existing = movements.filter(
      (m) => m.source_doc_type === 'DO' && m.source_doc_id === DO_ID && m.movement_type === 'OUT',
    ).length;
    if (existing > 0) continue; // already deducted — no-op
    movements.push({ source_doc_type: 'DO', source_doc_id: DO_ID, movement_type: 'OUT' });
    if (firstOutAt === null) firstOutAt = toStatus;
  }
  return { firstOutAt, rows: movements.length, attempts };
}

describe('the inventory OUT fires when the delivery order is Confirmed', () => {
  it('DRAFT -> LOADED (Confirm) writes the OUT — this is the hop that moves stock', () => {
    const walk = ladderWalk(['DRAFT', 'LOADED']);
    expect(walk.firstOutAt).toBe('LOADED');
    expect(walk.rows).toBe(1);
  });

  it('a DRAFT alone writes nothing — a draft has not shipped', () => {
    const walk = ladderWalk(['DRAFT']);
    expect(walk.firstOutAt).toBeNull();
    expect(walk.rows).toBe(0);
  });

  it('the full ladder deducts once, at Confirmed, and never again', () => {
    const walk = ladderWalk(['DRAFT', 'LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED']);
    expect(walk.firstOutAt).toBe('LOADED');
    expect(walk.rows).toBe(1);
    /* Every rung past Confirm REACHED the deduction and was refused by the
       guard — that is the property under test, not "they were skipped". */
    expect(walk.attempts).toEqual(['LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED']);
  });

  it('a jump straight from DRAFT to DELIVERED still deducts exactly once', () => {
    const walk = ladderWalk(['DRAFT', 'DELIVERED']);
    expect(walk.firstOutAt).toBe('DELIVERED');
    expect(walk.rows).toBe(1);
  });

  it('re-entering a shipped state a second time writes nothing', () => {
    const walk = ladderWalk(['DRAFT', 'LOADED', 'DISPATCHED', 'LOADED', 'DISPATCHED']);
    expect(walk.rows).toBe(1);
    expect(walk.attempts).toHaveLength(4);
  });
});

describe('the sets that carry the ruling', () => {
  it('LOADED is a shipped state — Confirmed means the stock has left', () => {
    expect(DO_SHIPPED_STATES as readonly string[]).toContain('LOADED');
    expect(DO_STOCK_OUT_STATES as readonly string[]).toContain('LOADED');
  });

  it('pre-ship is DRAFT alone, so a Confirmed DO can never fall back to un-shipped', () => {
    expect([...DO_PRESHIP_STATES]).toEqual(['DRAFT']);
    /* The PATCH guard refuses stock-out -> pre-ship. With LOADED on the shipped
       side, LOADED -> DRAFT is now refused; that is what stops a Confirmed
       delivery orphaning its OUT movement. */
    for (const s of DO_STOCK_OUT_STATES) {
      expect(DO_PRESHIP_STATES as readonly string[]).not.toContain(s);
    }
  });

  it('a Confirmed delivery counts as delivered, because its stock is out', () => {
    expect(doCountsAsDelivered('LOADED')).toBe(true);
    expect(doCountsAsDelivered('loaded')).toBe(true);
    expect(doCountsAsDelivered('DRAFT')).toBe(false);
    expect(doCountsAsDelivered('CANCELLED')).toBe(false);
  });

  it('the vocabulary is still exactly the eight scm.do_status labels', () => {
    /* Promoting a status must not duplicate or drop one: DO_STATUSES is built
       from the shipped set, so a careless edit could have listed LOADED twice. */
    expect([...DO_STATUSES].sort()).toEqual(
      ['CANCELLED', 'DELIVERED', 'DISPATCHED', 'DRAFT', 'INVOICED', 'IN_TRANSIT', 'LOADED', 'SIGNED'],
    );
    expect(new Set(DO_STATUSES).size).toBe(DO_STATUSES.length);
  });
});

/* ── THE CREATE PATH — where all 30 live delivery orders come from ──────────

   The status PATCH is the MINORITY path. Production run 32573972467 shows every
   live delivery order was raised by a plain non-draft create, which deducts at
   creation and performs no transition at all. On 2026-08-22 those creates were
   moved from DISPATCHED to LOADED so that raising a delivery order lands on
   Confirmed — the owner's 「我们是只要出DO就扣了库存了不是吗？」, confirming that
   raising one already takes the stock out.

   THE MOMENT THE STOCK IS DEDUCTED DOES NOT CHANGE. That is the whole risk
   question, and these assertions are what hold it: the deduction, the SO sync
   and the customer email on BOTH create paths are gated on `body.asDraft`, never
   on the status literal. A create that silently stopped deducting is the worst
   outcome this change could have, so it is pinned rather than reasoned about. */
describe('creating a delivery order still deducts, and now lands on Confirmed', () => {
  /* Each create path, sliced from its status literal to the end of its
     asDraft-gated block, so an assertion cannot be satisfied by the other one. */
  function createPath(nth: 1 | 2): string {
    const marks = [...ROUTE.matchAll(/status: \(body\.asDraft === true\) \? 'DRAFT' : '(\w+)',/g)];
    expect(marks, 'expected exactly two create paths').toHaveLength(2);
    const at = marks[nth - 1]!.index!;
    const gate = ROUTE.indexOf('if (body.asDraft !== true) {', at);
    expect(gate, `create path ${nth}: asDraft-gated block not found`).toBeGreaterThan(at);
    return ROUTE.slice(at, ROUTE.indexOf('\n  }', gate));
  }

  it('both create paths land LOADED (Confirmed), not DISPATCHED', () => {
    const landed = [...ROUTE.matchAll(/status: \(body\.asDraft === true\) \? 'DRAFT' : '(\w+)',/g)]
      .map((m) => m[1]);
    expect(landed).toEqual(['LOADED', 'LOADED']);
  });

  it.each([1, 2] as const)('create path %i still deducts stock at creation', (nth) => {
    const seg = createPath(nth);
    expect(seg).toContain('deductInventoryForDo(sb,');
  });

  it.each([1, 2] as const)(
    'create path %i gates the deduction on asDraft, NOT on the status it lands in',
    (nth) => {
      const seg = createPath(nth);
      /* The property that makes renaming the landing status safe. If the gate
         ever reads the status set instead, moving a status silently moves the
         deduction with it — the failure this whole file exists to prevent. */
      expect(seg).toContain('if (body.asDraft !== true) {');
      expect(seg).not.toMatch(/SHIPPED_STATES\.includes/);
      expect(seg).not.toMatch(/DO_SHIPPED_STATES/);
    },
  );

  it.each([1, 2] as const)(
    'create path %i still syncs the SO and still emails the customer',
    (nth) => {
      const seg = createPath(nth);
      /* A create performs NO transition, so the PATCH handler's copies of these
         never run for it. They must be here, on the create itself. */
      expect(seg).toContain('syncSoDeliveredFromDo(sb,');
      expect(seg).toContain('maybeSendDeliveryOrderEmail(sb, c.env,');
    },
  );

  it('the create email does not go through the transition-hop test', () => {
    /* The create calls maybeSendDeliveryOrderEmail directly, so CONFIRM_HOP_STATES
       is irrelevant to it and a create emails exactly once regardless of which
       status it lands in. Asserted because "the email still fires" is the claim,
       and the mechanism is what makes it true. */
    for (const nth of [1, 2] as const) {
      expect(createPath(nth)).not.toContain('CONFIRM_HOP_STATES');
    }
  });

  it('LOADED is a shipped state, so the create lands with its stock accounted for', () => {
    /* Ties the rename to the ledger: a DO created LOADED must read as stock-out
       everywhere, or the create would deduct into a status the readers call
       un-shipped — the orphan this change exists to avoid. */
    expect(DO_STOCK_OUT_STATES as readonly string[]).toContain('LOADED');
    expect(doCountsAsDelivered('LOADED')).toBe(true);
  });
});

describe('the route implements the two rules the simulation models', () => {
  it('the OUT is gated on the SHARED shipped set, not a hand-typed list', () => {
    expect(ROUTE).toMatch(/const SHIPPED_STATES: string\[\] = \[\.\.\.DO_SHIPPED_STATES\]/);
    const branch = ROUTE.slice(ROUTE.indexOf('let movementErrors: string[] = [];\n  let emailNotice'));
    expect(branch).toContain('if (SHIPPED_STATES.includes(toStatus)) {');
    expect(branch).toContain('movementErrors = await deductInventoryForDo(sb, id, user.id);');
  });

  it('deductInventoryForDo still opens with the existence check that makes it idempotent', () => {
    const at = ROUTE.indexOf('async function deductInventoryForDo(');
    expect(at, 'deductInventoryForDo not found').toBeGreaterThan(-1);
    const fn = ROUTE.slice(at, ROUTE.indexOf('/* Forward-compat (mig 0057)', at));
    expect(fn).toContain("from('inventory_movements')");
    expect(fn).toContain("count: 'exact'");
    expect(fn).toContain(".eq('source_doc_type', 'DO')");
    expect(fn).toContain('.eq(\'source_doc_id\', deliveryOrderId)');
    expect(fn).toContain(".eq('movement_type', 'OUT')");
    expect(fn).toMatch(/if \(\(existing \?\? 0\) > 0\) return \[\];/);
  });

  it('there is exactly ONE deduction trigger on the status PATCH', () => {
    /* The whole point of shared/do-shipped-states.ts is that the write has one
       trigger. A second call added beside this one would deduct on a rule
       nobody could find from the constant. Anchored on the HANDLER, not on a
       comment: the first version of this assertion keyed off the comment above
       the branch and went silently green the moment that comment was reworded,
       which is the failure mode a structural pin exists to avoid. */
    const at = ROUTE.indexOf('export const patchDeliveryOrderStatusHandler');
    expect(at, 'status handler not found').toBeGreaterThan(-1);
    const calls = ROUTE.slice(at).match(/await deductInventoryForDo\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('the confirm email follows the confirm hop rather than the DISPATCHED literal', () => {
    /* Leaving this on `toStatus === 'DISPATCHED'` alone would have ENDED the
       customer email silently, since Confirm no longer writes DISPATCHED. The
       pair is named in the shared module so the next move of the confirm step
       has to look at it. */
    expect(CONFIRM_HOP_STATES as readonly string[]).toContain('LOADED');
    expect(CONFIRM_HOP_STATES as readonly string[]).toContain('DISPATCHED');
    /* Searched from the HANDLER: the create path carries its own copy of this
       comment earlier in the file, and anchoring on the first hit tested the
       wrong branch. */
    const handler = ROUTE.indexOf('export const patchDeliveryOrderStatusHandler');
    const at = ROUTE.indexOf('Customer DO email (owner trigger "A"', handler);
    expect(at, 'email branch not found in the status handler').toBeGreaterThan(-1);
    const seg = ROUTE.slice(at, ROUTE.indexOf('}', ROUTE.indexOf('maybeSendDeliveryOrderEmail', at)));
    expect(seg).toContain('CONFIRM_HOP_STATES');
    expect(seg).not.toMatch(/toStatus === 'DISPATCHED'/);
  });
});
