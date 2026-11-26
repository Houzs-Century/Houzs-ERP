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
  so_item_id: string | null;
  allocationCount: number;
  sourceAcDtlKey: number | null;
  sourceSoDocNo: string | null;
  sourceSoInBook: boolean;
  itemCode?: string | null;
  /** The product of the sales-order line it names. docs/bugs/0672 site 13. */
  sourceItemCode?: string | null;
}

export type PoTransferShape =
  | { kind: 'transfer'; dtlKeys: number[]; fromSoDocNo: string }
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

  const keys = lines.map((l) => l.sourceAcDtlKey as number);
  if (new Set(keys).size !== keys.length) {
    return {
      kind: 'create',
      reason:
        'two purchase lines name the same sales-order line, which a transfer would count twice',
    };
  }

  /* THE SAME PRODUCT ON BOTH SIDES — docs/bugs/0672 site 13.
     Every refusal above is about CARDINALITY or PRESENCE: how many lines, how
     many keys, how many source documents, whether the book has seen them. None
     asked whether the purchase-order line and the sales-order line it names are
     the same thing.

     The transfer is executed as `doc.DocTransfer(dtlKeys)`, and the key is the
     ONLY handle — `composeEdit` even strips ItemCode off a keyed line, so
     nothing in flight could reveal the mistake. A purchase line for a TRION
     naming a REGAL sales line would transfer the REGAL's book line into a
     purchase order for TRIONs, in a licensed account book, silently.

     A BLANK on either side is not agreement; it is the absence of anything to
     agree about, and it falls back too. This file's header states the rule the
     whole module is built on — "every case that is not certainly 1:1 is
     asserted to fall back" — and identity is part of 1:1. The fallback costs a
     link and writes nothing wrong. */
  const norm = (v: string | null | undefined) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  const crossed = lines.filter((l) => {
    const mine = norm(l.itemCode);
    const theirs = norm(l.sourceItemCode);
    return !mine || !theirs || mine !== theirs;
  });
  if (crossed.length) {
    return {
      kind: 'create',
      reason:
        `${crossed.length} line(s) name a sales-order line for a different product, so a transfer `
        + 'would address the wrong line in the account book',
    };
  }

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
 * The sales orders a purchase order was made from, as the book's `UDF_SONo`
 * ("SO Doc No."), in the ", " form the office plug-in uses for several numbers.
 *
 * It was the purchase order's `Ref` until docs/bugs/0926. The plug-in keeps the
 * order's REFERENCE in Ref and the order's number in UDF_SONo, so the book
 * showed an SO number where staff read the customer's reference.
 *
 * De-duplicated and sorted so the same purchase order produces the same string
 * on every edit; an unstable value would rewrite the account book's field for no
 * reason each time a line moved.
 */
export function poSourceSoNos(soDocNos: readonly (string | null | undefined)[]): string | null {
  const seen = [...new Set(
    soDocNos.map((d) => String(d ?? '').trim()).filter((d) => d !== ''),
  )].sort();
  if (!seen.length) return null;
  return seen.join(', ');
}
