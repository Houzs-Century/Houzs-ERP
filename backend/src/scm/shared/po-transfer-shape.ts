// ----------------------------------------------------------------------------
// po-transfer-shape — can this purchase order be a TRANSFER from its sales
// order in AutoCount, or must it be a plain create?
//
// THE OWNER ASKED FOR BOTH, and this is the function that decides which.
// AutoCount's `AddSOToPOTransferDetail(Int64)` builds the purchase order FROM
// the sales order's lines, which is the right shape only when the two sides
// agree line for line. Houzs deliberately buys in a shape where they often do
// not:
//
//   mig 0235, the owner's decision of 2026-08-01 — ONE PO line can serve
//   SEVERAL customers plus stock at once. The live example is
//   2990-PO-2606-023: one qty-5 MAKOTO line covering SO-036 x1 + SO-029 x1
//   AND 3 for stock.
//
// A transfer cannot express that. It would either split a line the business
// deliberately consolidated, or drop the stock quantity, which belongs to no
// sales order at all. So a consolidated purchase is CREATED, and the source
// document numbers go in the PO's `Ref` — a field the ERP has never sent, so
// it is free, and `CreatePo` already applies it.
//
// REFUSING TO TRANSFER IS ALWAYS SAFE: a create is what happens today. The
// rule is therefore written to transfer only when it is certain, and to fall
// back on any doubt.
// ----------------------------------------------------------------------------

/** One purchase-order line, as much of it as this decision needs. */
export interface PoLineShape {
  id: string;
  /** The single-valued link. NULL means the line is for stock. */
  so_item_id: string | null;
  /**
   * Allocation rows for this line. PRESENT means the line was consolidated and
   * the allocations are authoritative (mig 0235) — which is exactly the case a
   * transfer cannot carry.
   */
  allocationCount: number;
  /**
   * AutoCount's own key for the SALES ORDER line behind `so_item_id`, when the
   * book has one. A transfer is addressed by this key and by nothing else, so a
   * line whose source was never sent to AutoCount cannot be transferred.
   */
  sourceAcDtlKey: number | null;
  /**
   * The ERP sales order this line was raised for.
   *
   * A transfer needs ONE source document, not one per line: the drain holds the
   * operation until the PARENT has an AutoCount number
   * (`payload.fromDoc` -> `FromDocNo`), and there is only one such anchor. Lines
   * drawn from several sales orders therefore fall back to a create, where the
   * Ref names them all.
   */
  sourceSoDocNo: string | null;
  /**
   * Is the source sales order already in the account book?
   *
   * Read from `mfg_sales_orders.linked_ac_docno`. It is what tells a key that
   * does not exist YET from one that never will — see the `wait` shape.
   */
  sourceSoInBook: boolean;
}

export type PoTransferShape =
  | { kind: 'transfer'; dtlKeys: number[]; fromSoDocNo: string }
  /**
   * The sales order is not in the account book YET, so its line keys do not
   * exist yet either. This is a transfer that cannot be addressed at this
   * instant — NOT a document that can never be one.
   *
   * The distinction is the whole point. `create` used to swallow this case, and
   * a purchase order raised in the same minute as its sales order silently
   * became a create with no link to it in the book. Measured on production
   * 2026-08-25: HC-PO-2608-007 from HC-SO-2608-008. The five before it
   * transferred correctly — they were raised long enough afterwards. A race,
   * not a rule, and a create is the one answer that cannot be taken back.
   */
  | { kind: 'wait'; fromSoDocNo: string; reason: string }
  | { kind: 'create'; reason: string };

/**
 * The decision, and the REASON when it is no.
 *
 * The reason is not decoration: it lands in the outbox row and on the sync
 * page, so an operator looking at a purchase order with no transfer link can
 * see it was a choice rather than a failure.
 */
export function poTransferShape(lines: readonly PoLineShape[]): PoTransferShape {
  if (!lines.length) return { kind: 'create', reason: 'the purchase order has no lines' };

  const consolidated = lines.filter((l) => l.allocationCount > 0).length;
  if (consolidated) {
    return {
      kind: 'create',
      reason:
        `${consolidated} line(s) are consolidated across several sales orders or carry stock `
        + 'quantity, which AutoCount\'s SO-to-PO transfer cannot represent — the source SO '
        + 'numbers go in Ref instead',
    };
  }

  const forStock = lines.filter((l) => l.so_item_id == null).length;
  if (forStock) {
    return {
      kind: 'create',
      reason:
        `${forStock} line(s) are for stock and belong to no sales order, so there is nothing `
        + 'to transfer them from',
    };
  }

  const keylessLines = lines.filter((l) => l.sourceAcDtlKey == null);
  if (keylessLines.length) {
    /* NOT YET vs NEVER. A line whose sales order is not in the book yet has no
       key because nothing has issued one — waiting produces the key. A line
       whose sales order IS in the book and still has no key is a real gap, and
       a create is the honest answer there. */
    const waitingOn = [...new Set(keylessLines
      .filter((l) => l.so_item_id != null && !l.sourceSoInBook)
      .map((l) => String(l.sourceSoDocNo ?? '').trim())
      .filter((v) => v !== ''))];
    if (waitingOn.length === 1 && keylessLines.every((l) => l.so_item_id != null && !l.sourceSoInBook)) {
      return {
        kind: 'wait',
        fromSoDocNo: waitingOn[0],
        reason:
          `${keylessLines.length} line(s) come from ${waitingOn[0]}, which is not in the account `
          + 'book yet, so its line keys do not exist yet either. The transfer waits for it rather '
          + 'than becoming a create that could never be linked back.',
      };
    }
    return {
      kind: 'create',
      reason:
        `${keylessLines.length} line(s) name a sales-order line the account book has no key for, so the `
        + 'transfer cannot address them',
    };
  }

  /* DISTINCT keys, because two PO lines pointing at one SO line is the
     consolidated case wearing different clothes — the allocations table is the
     supported way to say that, and a duplicate here means the data disagrees
     with itself. Transferring the same source line twice would double the
     quantity in the account book. */
  const keys = lines.map((l) => l.sourceAcDtlKey as number);
  if (new Set(keys).size !== keys.length) {
    return {
      kind: 'create',
      reason:
        'two purchase lines name the same sales-order line, which a transfer would count twice',
    };
  }

  /* ONE source document. The drain waits on the parent's AutoCount number and
     has exactly one anchor to wait on, so a purchase order drawing on several
     sales orders cannot be expressed as a transfer at all — it becomes a create
     whose Ref names every one of them. */
  const sources = [...new Set(lines.map((l) => String(l.sourceSoDocNo ?? '').trim()))];
  if (sources.length !== 1 || sources[0] === '') {
    return {
      kind: 'create',
      reason: sources.length > 1
        ? `the lines come from ${sources.length} different sales orders, and a transfer has one source`
        : 'the source sales order cannot be named',
    };
  }

  return { kind: 'transfer', dtlKeys: keys, fromSoDocNo: sources[0] };
}

/**
 * The `Ref` a CREATED purchase order carries: the sales orders it was raised
 * for.
 *
 * Only reached on the create path — a transfer needs no reference because
 * AutoCount's own DocTransfer link is the reference, and a stronger one.
 *
 * De-duplicated and sorted so the same purchase order produces the same string
 * on every edit; an unstable Ref would rewrite the account book's field for no
 * reason each time a line moved.
 */
export function poSourceRef(soDocNos: readonly (string | null | undefined)[]): string | null {
  const seen = [...new Set(
    soDocNos.map((d) => String(d ?? '').trim()).filter((d) => d !== ''),
  )].sort();
  if (!seen.length) return null;
  return seen.join(', ');
}
