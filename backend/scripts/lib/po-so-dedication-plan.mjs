// ---------------------------------------------------------------------------
// po-so-dedication-plan.mjs — who should each purchase line be bought FOR?
//
// PURE: rows in, a plan out. No filesystem, no database, no process.exit. The
// runner (scripts/repair-po-so-item-dedication.mjs) does the I/O, the
// downstream guards and the write, and owns the verdict. Everything decidable
// from the two documents alone is decided here so it can be tested without a
// database — see po-so-dedication-plan.test.mjs.
//
// WHAT THE COLUMN MEANS. `scm.purchase_order_items.so_item_id` is the
// DEDICATION: this purchase line was raised for THAT sales line. The app's own
// operator-facing gate — soLinkTargetRefusal in scm/routes/mfg-purchase-orders.ts
// — refuses a bind whose codes disagree with 409 `so_link_material_mismatch`,
// because "binding a PO line for one SKU to an SO line for another makes every
// downstream reader lie". A row that disagrees therefore cannot have been made
// through the UI; it arrived with the migration, and it is a defect against a
// rule this codebase already states.
//
// MATCHED BY CODE AND SEAT, NEVER BY POSITION. The two documents do not list
// their lines in the same order and there is no reason they should. Pairing by
// position is how a 28" single seater ends up dedicated to a 26" build.
//
// IT REFUSES RATHER THAN PICKS. Every case where the answer is not FORCED — two
// candidate sales lines, none, a pointer that leaves the document pair, a
// cancelled target, a quantity that would over-convert — is returned as a
// refusal and left for a person. A plausible guess about which sofa a purchase
// was for is worse than a visible gap.
//
// THE ONE THING THAT IS NOT A GUESS is a bucket where every candidate on both
// sides is INDISTINGUISHABLE from its siblings - two identical `1NA`
// compartments of one sofa. Any bijection there produces the same state, so it
// is a relabelling and not a choice. It fires only when the caller supplies a
// `fingerprint` and every fingerprint in the bucket matches.
// ---------------------------------------------------------------------------

/** Codes are compared the way the app compares them: trimmed, upper-cased. */
export const K = (s) => String(s ?? '').trim().toUpperCase();

/** Seat depth as a comparable token. Absent on both sides still matches. */
export const seatKey = (s) => (s === null || s === undefined || s === '' ? '' : String(s).trim());

/** The bucket a line belongs to: same code AND same seat, or it is not the same piece. */
const bucketOf = (row) => JSON.stringify([K(row.item_code), seatKey(row.seat)]);

/**
 * Are these rows INDISTINGUISHABLE - not merely the same piece, but carrying
 * no observable difference at all?
 *
 * `fingerprint` is the CALLER's, and it must be built from every column the
 * caller read except the row's own identity (`id`, `line_no`) and the pointer
 * being decided (`so_item_id`). A caller that supplies none gets `false`, which
 * keeps the old refusal - this widening can never fire by omission.
 *
 * WHY IT MATTERS. A sofa build carries two `1NA` compartments because the sofa
 * physically has two, and the importer wrote them as two rows with the same
 * code, the same seat, the same quantity, the same money, the same variants and
 * the same Desc2. Pairing purchase line A with sales line B or with sales line
 * C is then a RELABELLING: no downstream reader can tell the two apart, so
 * neither answer is more right than the other and there is nothing to guess
 * about. Refusing costs something real - a hard-bound sales line with no
 * dedication can never reach READY, because readiness is read through its OWN
 * dedicated purchase line's received quantity.
 *
 * The moment ANY column differs - a price, a colour, a seat, a special, a
 * received quantity - the fingerprints differ and the bucket is refused exactly
 * as before. That is the whole guard: this does not compare less, it compares
 * MORE, and only acts when the comparison finds nothing to choose between.
 */
const allIdentical = (rows) => {
  if (rows.length < 2) return false;
  const first = rows[0]?.fingerprint;
  if (first === undefined || first === null || first === '') return false;
  return rows.every((r) => r.fingerprint === first);
};

const label = (row) => `${K(row.item_code)}${seatKey(row.seat) ? ` @${seatKey(row.seat)}"` : ''}`;

/**
 * Plan the dedications for ONE (sales order, purchase order) pair.
 *
 * @param {object} args
 * @param {Array<{id: string, item_code: string, qty: number, seat: string|null, so_item_id: string|null, fingerprint?: string}>} args.poRows
 *        every sofa line of the purchase order
 * @param {Array<{id: string, item_code: string, qty: number, seat: string|null, cancelled: boolean, fingerprint?: string}>} args.soRows
 *        every sofa line of the sales order
 *
 * `fingerprint` is OPTIONAL and, when given, must be built from every column
 * the caller read except `id`, `line_no` and `so_item_id`. It is used only to
 * settle a bucket of INDISTINGUISHABLE rows - see allIdentical above. Omit it
 * and the planner behaves exactly as it did before.
 * @returns {{
 *   moves: Array<{poItemId: string, poCode: string, seat: string, from: string|null, to: string, why: 'mismatch'|'unbound'}>,
 *   keeps: Array<{poItemId: string, poCode: string, to: string}>,
 *   refusals: string[],
 *   freedSoItemIds: string[],
 *   belongs: boolean,
 * }}
 */
export function planDedication({ poRows = [], soRows = [] } = {}) {
  const moves = [];
  const keeps = [];
  const refusals = [];

  const soById = new Map(soRows.map((r) => [r.id, r]));

  /* Does this purchase order evidence that it belongs to this sales order at
     all? One line already dedicated to a line of it is the evidence. Without
     that, an unbound purchase line is NOT a missing pointer — it may simply be
     a purchase for stock, and inventing a dedication would be a guess. */
  const belongs = poRows.some((r) => r.so_item_id && soById.has(r.so_item_id));

  /* Pass 1 — classify. A pointer is KEPT when it names a line of this sales
     order whose code and seat are the purchase line's own. */
  const needy = [];
  for (const po of poRows) {
    if (po.so_item_id) {
      const target = soById.get(po.so_item_id);
      if (!target) {
        refusals.push(
          `${label(po)}: its dedication names ${po.so_item_id}, which is not a line of this sales order — left alone, a pointer that leaves the document pair is not this repair's to move`,
        );
        continue;
      }
      if (bucketOf(target) === bucketOf(po) && !target.cancelled) {
        keeps.push({ poItemId: po.id, poCode: K(po.item_code), to: target.id });
        continue;
      }
      needy.push({ po, why: 'mismatch', from: po.so_item_id });
      continue;
    }
    if (!belongs) {
      refusals.push(
        `${label(po)}: it carries no dedication, and no line of this purchase order has a dedication to this sales order — nothing evidences that the two documents belong together`,
      );
      continue;
    }
    needy.push({ po, why: 'unbound', from: null });
  }

  /* Pass 2 — the candidate pool. A sales line already KEPT by a purchase line
     is spoken for and can never be a candidate; a cancelled line has no demand
     to buy against, exactly as soLinkTargetRefusal rules. */
  const spokenFor = new Set(keeps.map((k) => k.to));
  const free = new Map(); // bucket -> [soRow]
  for (const so of soRows) {
    if (so.cancelled || spokenFor.has(so.id)) continue;
    const b = bucketOf(so);
    if (!free.has(b)) free.set(b, []);
    free.get(b).push(so);
  }

  /* Pass 3 — assign, but only where the answer is FORCED. Grouping the needy
     purchase lines by bucket makes the decision order-independent: N purchase
     lines competing for M sales lines is one question, and it has a forced
     answer only when N === M === 1. */
  const byBucket = new Map();
  for (const n of needy) {
    const b = bucketOf(n.po);
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b).push(n);
  }
  for (const [b, group] of byBucket) {
    const cands = free.get(b) ?? [];
    /* N purchase lines against N sales lines is forced WHEN THERE IS NOTHING TO
       CHOOSE: every purchase line in the bucket identical to the others, every
       sales line identical to the others. Any bijection then produces the same
       state, so pairing them in order is not a guess. */
    if (group.length > 1 && group.length === cands.length
        && allIdentical(group.map((n) => n.po)) && allIdentical(cands)) {
      for (let i = 0; i < group.length; i++) {
        const n = group[i];
        const target = cands[i];
        const poQty = Number(n.po.qty ?? 0);
        const soQty = Number(target.qty ?? 0);
        if (poQty > soQty) {
          refusals.push(
            `${label(n.po)}: the purchase line orders ${poQty} against a sales line of ${soQty} - ${poQty} > ${soQty} would exceed the demand, REFUSED`,
          );
          continue;
        }
        moves.push({ poItemId: n.po.id, poCode: K(n.po.item_code), seat: seatKey(n.po.seat), from: n.from, to: target.id, why: n.why });
      }
      continue;
    }
    if (group.length !== 1 || cands.length !== 1) {
      const who = group.map((n) => label(n.po)).join(', ');
      refusals.push(
        cands.length === 0
          ? `${who}: no sales line on this order carries that code at that seat and is still unclaimed — REFUSED, not guessed`
          : `${who}: ${group.length} purchase line(s) and ${cands.length} sales line(s) could pair here, so no pairing is forced — REFUSED, not guessed`,
      );
      continue;
    }
    const [n] = group;
    const [target] = cands;
    const poQty = Number(n.po.qty ?? 0);
    const soQty = Number(target.qty ?? 0);
    if (poQty > soQty) {
      refusals.push(
        `${label(n.po)}: the purchase line orders ${poQty} against a sales line of ${soQty} — ${poQty} > ${soQty} would exceed the demand, REFUSED`,
      );
      continue;
    }
    moves.push({ poItemId: n.po.id, poCode: K(n.po.item_code), seat: seatKey(n.po.seat), from: n.from, to: target.id, why: n.why });
  }

  /* What the repair RELEASES: sales lines a purchase line points at today and
     will not after. That is the surplus placeholder whose only reason for
     surviving is the pointer, and it is what
     apply-sofa-compartment-corrections.mjs is waiting to remove under its own
     money and downstream guards. This repair never deletes it. */
  const after = new Set([...keeps.map((k) => k.to), ...moves.map((m) => m.to)]);
  const freedSoItemIds = [...new Set(moves.map((m) => m.from).filter(Boolean))].filter((id) => !after.has(id));

  return { moves, keeps, refusals, freedSoItemIds, belongs };
}
