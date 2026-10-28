// Which AutoCount PODTL row is an already-imported ERP purchase-order line?
//
// The importers did not store the answer (that is the whole defect), so the
// repair has to recover it from what they DID store. Two facts make it
// recoverable without re-running either decoder:
//
//   1. supplier_sku is AutoCount's own ItemCode. A plain line carries it
//      verbatim; a sofa line carries `<ItemCode> <compartment>` (the owner's
//      supplier-SKU rule, so the factory sheet names the piece). So the AC line
//      an ERP row descends from is the one whose ItemCode is the row's
//      supplier_sku, or is that sku's prefix up to a space. LONGEST ItemCode
//      wins, so "AK-ARMOUR MATT (K)" never swallows "AK-ARMOUR MATT (K) XL".
//   2. ONE AutoCount sofa line becomes SEVERAL ERP compartment lines. That is
//      not ambiguity: all of them descend from that one PODTL row and all of
//      them correctly carry its DtlKey, its delivery date and its origin SO.
//
// Ambiguity is real only where one document has SEVERAL AutoCount lines sharing
// an ItemCode (59 of 663 groups in the committed snapshots). Those are split
// further by the fields the ERP faithfully copied — qty and Desc2 — which
// separates 56 of the 59. A group whose two sides do not partition the same way
// is refused whole.
//
// WHAT IS LEFT AFTER THAT SPLIT IS NOT INTERCHANGEABLE, AND AN EARLIER VERSION
// OF THIS FILE CLAIMED IT WAS. The claim was "identical on every field the ERP
// stores, so any bijection is the same set of facts" — and it is false in the
// real data. All 5 surviving buckets in the committed snapshots (10 AutoCount
// lines) carry DIFFERENT FromSODtlKeys, and on PO-000290 the two keys name two
// DIFFERENT PRODUCTS on the same sales order (60700 -> SO-000870 "MYLATEX
// LUMBARIA (K)", 60702 -> SO-000870 "NB-KHJ57(K)"). Zipping picks one by
// coin flip. The ERP rows are indistinguishable; the AUTOCOUNT lines are not,
// and the AutoCount side is where every value this repair writes comes from.
//
// So a bucket is zipped ONLY when its AutoCount lines agree on every value the
// repair would write from them — FromSODtlKey and DeliveryDate. When they
// disagree the bucket is REFUSED and both candidates are reported, because a
// wrong so_item_id or a wrong linked_ac_dtlkey is strictly worse than a NULL:
// NULL means "unknown, create" to the write-back, while a wrong DtlKey makes it
// APPEND a line instead of editing the one the operator changed.

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

/** ERP rows keyed by the AutoCount ItemCode their supplier_sku descends from. */
function bucketErpRows(erpRows, acCodes) {
  // longest first: a longer ItemCode is the more specific claim on a sku
  const codes = [...acCodes.keys()].sort((a, b) => b.length - a.length);
  const byCode = new Map();
  const unmatched = [];
  for (const row of erpRows) {
    const sku = norm(row.supplier_sku);
    const mat = norm(row.item_code);
    let hit = codes.find((c) => sku === c || sku.startsWith(c + " "));
    // A row whose supplier_sku was never written falls back to the ERP code the
    // mapping CSV produced for that AutoCount item.
    if (!hit && mat) hit = codes.find((c) => (acCodes.get(c)?.erpCodes ?? []).includes(mat));
    if (!hit) { unmatched.push(row); continue; }
    if (!byCode.has(hit)) byCode.set(hit, []);
    byCode.get(hit).push(row);
  }
  return { byCode, unmatched };
}

/* scm.purchase_order_items.id is a serial. localeCompare on its String() sorts
   [9, 10, 11, 12] as [10, 11, 12, 9] and [999, 1000] as [1000, 999], which
   splits one PO line's compartment rows across different AutoCount lines. Sort
   numerically when both ids are numbers; fall back to text for anything else. */
function byRowId(a, b) {
  const na = Number(a.id);
  const nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a.id).localeCompare(String(b.id));
}

/** The values this repair would copy off an AutoCount line onto an ERP row. */
const writtenValues = (l) => `${l.fromSoKey ?? "-"}|${l.deliveryDate ?? "-"}`;

/**
 * @param acLines  AutoCount PODTL rows for ONE document, each shaped
 *                 { key, itemCode, qty, desc2, erpCodes?, fromSoKey?, deliveryDate? }
 *                 — `key` is DtlKey. `fromSoKey` and `deliveryDate` are what the
 *                 repair would write from this line; they decide whether two
 *                 otherwise-identical lines are genuinely interchangeable.
 * @param erpRows  ERP purchase_order_items rows for that document, each shaped
 *                 { id, supplier_sku, item_code, qty, description2 }.
 * @returns { pairs, unmatchedErp, unmatchedAc, refused }
 *          pairs: { row, ac, how } where how is "sole" | "split" | "indistinguishable"
 */
export function matchAcLinesToErpRows(acLines, erpRows) {
  const acByCode = new Map();
  for (const l of acLines) {
    const c = norm(l.itemCode);
    if (!acByCode.has(c)) acByCode.set(c, { erpCodes: [], lines: [] });
    const g = acByCode.get(c);
    g.lines.push(l);
    for (const e of l.erpCodes ?? []) if (e) g.erpCodes.push(norm(e));
  }
  for (const g of acByCode.values()) g.lines.sort((a, b) => Number(a.key) - Number(b.key));

  const { byCode, unmatched } = bucketErpRows(erpRows, acByCode);
  const pairs = [];
  const refused = [];
  const seenAc = new Set();

  for (const [code, group] of acByCode) {
    const rows = (byCode.get(code) ?? []).slice().sort(byRowId);
    if (rows.length === 0) continue;

    // ONE AutoCount line: every ERP row under this code descends from it,
    // however many compartments it fanned out into.
    if (group.lines.length === 1) {
      for (const row of rows) pairs.push({ row, ac: group.lines[0], how: "sole" });
      seenAc.add(group.lines[0].key);
      continue;
    }

    /* SEVERAL AutoCount lines share this code. Split both sides by what the
       import copied verbatim; a bucket that lines up 1:1 is determined. */
    const acBuckets = new Map();
    for (const l of group.lines) {
      const k = `${Number(l.qty) || 0}|${norm(l.desc2)}`;
      if (!acBuckets.has(k)) acBuckets.set(k, []);
      acBuckets.get(k).push(l);
    }
    const rowBuckets = new Map();
    for (const r of rows) {
      const k = `${Number(r.qty) || 0}|${norm(r.description2)}`;
      if (!rowBuckets.has(k)) rowBuckets.set(k, []);
      rowBuckets.get(k).push(r);
    }
    const sameShape =
      acBuckets.size === rowBuckets.size &&
      [...acBuckets.keys()].every((k) => rowBuckets.has(k));
    if (!sameShape) {
      refused.push({
        code,
        acLines: group.lines.length,
        erpRows: rows.length,
        /* rowIds on THIS refusal too. The caller turns rowIds into the per-line
           reason list, so omitting them here made a refused row visible only in
           the group summary — and "every unrepaired line gets a reason" is the
           promise this report makes. Measured: HC-PO-009620 was the one row in
           production that fell through that gap. */
        rowIds: rows.map((r) => r.id),
        reason: "the AutoCount lines and the ERP rows do not split the same way on (qty, Desc2)",
      });
      continue;
    }

    for (const [k, acs] of acBuckets) {
      const rs = rowBuckets.get(k);
      if (acs.length === 1) {
        for (const row of rs) pairs.push({ row, ac: acs[0], how: "split" });
        seenAc.add(acs[0].key);
        continue;
      }
      /* The ERP rows are identical in every stored field, so which row is which
         AutoCount line is recorded NOWHERE. That is only harmless if the
         AutoCount lines AGREE on everything this repair would copy off them. */
      const distinct = [...new Set(acs.map(writtenValues))];
      if (distinct.length > 1) {
        refused.push({
          code,
          acLines: acs.length,
          erpRows: rs.length,
          candidates: acs.map((a) => ({ key: a.key, fromSoKey: a.fromSoKey ?? null, deliveryDate: a.deliveryDate ?? null })),
          rowIds: rs.map((r) => r.id),
          reason:
            "the ERP rows are identical in every stored field, but the AutoCount lines are NOT: they disagree on " +
            [
              new Set(acs.map((a) => a.fromSoKey ?? "-")).size > 1 ? "FromSODtlKey" : null,
              new Set(acs.map((a) => a.deliveryDate ?? "-")).size > 1 ? "DeliveryDate" : null,
            ].filter(Boolean).join(" and ") +
            ", so assigning one to a row would be a coin flip on a value that is written",
        });
        continue;
      }
      if (rs.length % acs.length !== 0) {
        refused.push({
          code,
          acLines: acs.length,
          erpRows: rs.length,
          candidates: acs.map((a) => ({ key: a.key, fromSoKey: a.fromSoKey ?? null, deliveryDate: a.deliveryDate ?? null })),
          rowIds: rs.map((r) => r.id),
          reason: `indistinguishable group does not divide evenly (${rs.length} rows over ${acs.length} AutoCount lines)`,
        });
        continue;
      }
      /* Past both refusals: the AutoCount lines agree on every value that gets
         written, so the only thing the zip still chooses is which DtlKey lands
         on which row — and every candidate carries the same facts. Rows are in
         numeric id order, so one PO line's consecutive compartment rows stay
         together in the same slice instead of being scattered by text sort. */
      const per = rs.length / acs.length;
      acs.forEach((ac, i) => {
        for (const row of rs.slice(i * per, (i + 1) * per)) {
          pairs.push({ row, ac, how: "indistinguishable" });
        }
        seenAc.add(ac.key);
      });
    }
  }

  const unmatchedAc = acLines.filter((l) => !seenAc.has(l.key));
  return { pairs, unmatchedErp: unmatched, unmatchedAc, refused };
}
