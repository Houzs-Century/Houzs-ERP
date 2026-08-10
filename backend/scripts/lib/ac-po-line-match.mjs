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
// separates 56 of the 59. Where even that does not separate them the ERP rows
// are identical in every stored field, so no evidence exists to prefer one
// assignment over the other; they are zipped in DtlKey order and REPORTED as
// indistinguishable rather than presented as a resolved fact. A group whose two
// sides do not partition the same way is refused whole.

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

/** ERP rows keyed by the AutoCount ItemCode their supplier_sku descends from. */
function bucketErpRows(erpRows, acCodes) {
  // longest first: a longer ItemCode is the more specific claim on a sku
  const codes = [...acCodes.keys()].sort((a, b) => b.length - a.length);
  const byCode = new Map();
  const unmatched = [];
  for (const row of erpRows) {
    const sku = norm(row.supplier_sku);
    const mat = norm(row.material_code);
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

/**
 * @param acLines  AutoCount PODTL rows for ONE document, each shaped
 *                 { key, itemCode, qty, desc2, erpCodes? } — `key` is DtlKey.
 * @param erpRows  ERP purchase_order_items rows for that document, each shaped
 *                 { id, supplier_sku, material_code, qty, description2 }.
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
    const rows = (byCode.get(code) ?? []).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
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
      /* Identical on every field the ERP stores, so which row is which
         AutoCount line is recorded NOWHERE. Any bijection is the same set of
         facts; zip in DtlKey order and say so. Refusing here would strand rows
         whose values are, in the ambiguous fields, interchangeable. */
      if (rs.length % acs.length !== 0) {
        refused.push({
          code,
          acLines: acs.length,
          erpRows: rs.length,
          reason: `indistinguishable group does not divide evenly (${rs.length} rows over ${acs.length} AutoCount lines)`,
        });
        continue;
      }
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
