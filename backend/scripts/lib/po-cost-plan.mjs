/* Which imported PO line gets which supplier price — the whole decision, with
   no database and no filesystem, so it can be executed and measured in a test
   instead of being reasoned about in a review comment.
   stamp-po-line-costs.mjs supplies the AutoCount snapshot and the ERP rows and
   does nothing else but print this module's answer and write it.

   THE BUG THIS MODULE EXISTS TO PREVENT. The first version resolved a price per
   (PoNo, ItemCode, Desc2) but looked the TARGET up by (PoNo, Desc2) alone.
   Desc2 carries the fabric, the leg and the gap; it does NOT carry the SIZE,
   which lives in the item code. So two bed sizes on one purchase order share a
   Desc2, and the priced one's money landed on the unpriced one:

     PO-009826  HOK-DIVAN ONLY (K) RM470.00 -> stamped onto ... ONLY (Q) x3
     PO-009802  HOK-2041 (A) (SS)  RM641.50 -> stamped onto ... (A) (Q)  x1

   Both are wrong by more than the queen's own history allows (+44.6%, +9.7%),
   and both would then read as PRICED, so the receipt gate could never catch
   them. The item code is now part of every key.

   THE THREE ROUTES TO A TARGET, most exact first.
     1. linked_ac_dtlkey (migration 0273) is the line's own AutoCount identity,
        so it is a 1:1 match needing no signature at all. It IS populated in
        production: backfill-ac-line-keys.mjs ran with mode=APPLY on 2026-08-10
        (Actions run 31416597720) and set 275 of 864 imported PO lines, leaving
        589 with no AutoCount match. So this route fires today for the lines it
        reaches, and routes 2-3 carry the rest. Do not re-add the old claim that
        the key "was never stored" -- that was true only before that run, and
        the stamp script's header repeated it for a while after it stopped
        being true.
     2. supplier_sku holds the RAW AutoCount ItemCode: import-ac-outstanding-po
        stores `sku: l.ItemCode` into it verbatim. That makes it a better key
        than the mapping CSV, because a sofa line whose ERP code was MINTED
        rather than mapped still carries the AutoCount code here.
     3. item_code via the AutoCount<->ERP mapping CSV, the pair every other
        cutover script uses.
   All three carry the item code. A line no route reaches keeps its zero and is
   listed -- a blank the receipt gate refuses, never a plausible wrong number. */

/* Desc2 arrives with curly quotes, inch marks written three different ways,
   stray newlines and doubled spaces. Fold all of that away so the same physical
   build keyed by two different typists still matches. */
export const sig = (s) => (s ?? "").toString().toUpperCase()
  .replace(/[‘’“”`]/g, '"')
  .replace(/''/g, '"')
  .replace(/[^A-Z0-9"#+]/g, "");

/** Item codes are compared the way every other cutover script compares them. */
export const normCode = (s) => (s ?? "").toString().trim().toUpperCase().replace(/\s+/g, " ");

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/* The pricing waterfall, unchanged and deliberately so: a backtest over 11,239
   priced AutoCount purchase lines measured item+Desc2 at 97.3% exact / 0.4%
   MAPE, against 9.7% / 32.2% for last-cost and 2.1% / 112.5% for MAX. */
export function buildPricer(book) {
  const hist = [...book.history].sort((a, b) => (a.DocDate < b.DocDate ? -1 : 1));
  const byItemSig = new Map();
  for (const h of hist) {
    const k = `${normCode(h.ItemCode)}|${sig(h.Desc2)}`;
    if (!byItemSig.has(k)) byItemSig.set(k, []);
    byItemSig.get(k).push(h);
  }
  const samePo = new Map();
  for (const g of book.samePoGr) {
    if (Number(g.UnitPrice) > 0) samePo.set(`${g.PoNo}|${normCode(g.ItemCode)}|${sig(g.Desc2)}`, Number(g.UnitPrice));
  }
  /* PRICE-STABLE items only: enough recent evidence, and that evidence agrees.
     A bespoke sofa never qualifies, which is the point -- its price is a
     property of the build, not of the code. */
  const cutoff = Date.now() - 24 * 30 * 24 * 3600 * 1000;
  const stable = new Map();
  for (const item of new Set(hist.map((h) => normCode(h.ItemCode)))) {
    const ps = hist.filter((h) => normCode(h.ItemCode) === item && new Date(h.DocDate).getTime() >= cutoff).map((h) => Number(h.UnitPrice));
    if (ps.length < 4) continue;
    const m = median(ps);
    if (m > 0 && ps.filter((p) => Math.abs(p - m) / m <= 0.02).length / ps.length >= 0.8) stable.set(item, m);
  }
  return (line) => {
    const code = normCode(line.ItemCode);
    const s = sig(line.Desc2);
    const t1 = samePo.get(`${line.PoNo}|${code}|${s}`);
    if (t1 > 0) return { tier: "T1_gr_for_this_po_line", price: t1 };
    const t2 = byItemSig.get(`${code}|${s}`);
    if (t2 && t2.length) {
      const p = Number(t2[t2.length - 1].UnitPrice);
      if (p > 0) return { tier: "T2_item_desc2_signature", price: p };
    }
    const t3 = stable.get(code);
    if (t3 > 0) return { tier: "T3_price_stable_item", price: t3 };
    return null;
  };
}

/** Reasons an ERP line is left at zero. Every unplanned line carries exactly one. */
export const SKIP = {
  NO_AC_LINE: "no AutoCount line matched this ERP line",
  NO_PRICE: "AutoCount line has no defensible price",
  AMBIGUOUS: "two AutoCount lines propose different prices for this ERP line",
  CODE_MISMATCH: "the ERP line's DtlKey points at a different item code",
};

/**
 * Decide what to write.
 *
 * @param book     the AutoCount snapshot: { poLines, samePoGr, history }
 * @param erpRows  rows of scm.purchase_order_items already filtered to
 *                 imported + unpriced + open, each
 *                 { id, item_code, supplier_sku, description2, qty,
 *                   received_qty, linked_ac_dtlkey, ac_doc, po_number }
 * @param codeMap  AutoCount ItemCode -> ERP item_code (normalised keys)
 * @returns { plan, skipped, stats } — `plan` has ONE entry per ERP row id and
 *          is exactly the set APPLY writes; `skipped` is its complement over
 *          erpRows, so the two together account for every row read.
 */
export function planStamps({ book, erpRows, codeMap = new Map() }) {
  const priceOf = buildPricer(book);
  const erpCodeFor = (acItemCode) => codeMap.get(normCode(acItemCode)) ?? normCode(acItemCode);

  /* ERP side, indexed the two ways a line can be addressed. The DtlKey is the
     line's own identity (migration 0273) and needs no signature; the doc + code
     + Desc2 triple is the fallback for lines the key backfill has not reached. */
  const byDtlKey = new Map();
  const dupDtlKeys = new Set();
  const bySupplierSku = new Map();
  const byMaterialCode = new Map();
  const push = (m, k, r) => { if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
  for (const r of erpRows) {
    if (r.linked_ac_dtlkey != null && r.linked_ac_dtlkey !== "") {
      const dk = String(r.linked_ac_dtlkey);
      if (byDtlKey.has(dk)) dupDtlKeys.add(dk); else byDtlKey.set(dk, r);
    }
    const s = sig(r.description2);
    if (r.supplier_sku) push(bySupplierSku, `${r.ac_doc}|${normCode(r.supplier_sku)}|${s}`, r);
    push(byMaterialCode, `${r.ac_doc}|${normCode(r.item_code)}|${s}`, r);
  }
  /* A DtlKey claimed by two ERP rows is not an identity, so it is not used. */
  for (const dk of dupDtlKeys) byDtlKey.delete(dk);

  /* Every proposal aimed at each ERP row, so a row wanted at two different
     prices can be refused instead of taking whichever arrived last. */
  const proposals = new Map();
  const vetoed = new Set();
  const propose = (row, p) => {
    if (!proposals.has(row.id)) proposals.set(row.id, []);
    proposals.get(row.id).push(p);
  };

  const stats = { acOpenLines: 0, matchedByDtlKey: 0, matchedBySupplierSku: 0, matchedByMaterialCode: 0, acLinesWithNoErpLine: 0, acLinesWithNoPrice: 0 };

  for (const line of book.poLines) {
    const open = Number(line.Qty) - Number(line.TransferedQty ?? 0);
    if (!(open > 0)) continue;
    stats.acOpenLines++;

    const erpCode = erpCodeFor(line.ItemCode);
    let targets = [];
    let route = null;
    const dk = line.PoDtlKey == null ? null : String(line.PoDtlKey);
    const keyed = dk ? byDtlKey.get(dk) : undefined;
    if (keyed) {
      /* Trust the key only while it agrees with the code. A DtlKey pointing at
         a different item is a broken backfill, and following it would be the
         same wrong-size stamp this module exists to stop. */
      if (normCode(keyed.item_code) !== erpCode) {
        /* VETO, not merely "this line does not price it". A row whose stored
           AutoCount identity points at a different item has identity data we
           cannot trust, so no other route may rescue it either -- the whole
           point of the key is that it is the most exact evidence available, and
           the most exact evidence disagreeing is a reason to stop. */
        vetoed.add(keyed.id);
        propose(keyed, { reject: SKIP.CODE_MISMATCH, acLine: line });
        continue;
      }
      targets = [keyed];
      route = "dtlkey";
      stats.matchedByDtlKey++;
    } else {
      const s = sig(line.Desc2);
      const bySku = bySupplierSku.get(`${line.PoNo}|${normCode(line.ItemCode)}|${s}`);
      if (bySku && bySku.length) {
        targets = bySku; route = "supplier_sku+desc2"; stats.matchedBySupplierSku++;
      } else {
        targets = byMaterialCode.get(`${line.PoNo}|${erpCode}|${s}`) ?? [];
        if (targets.length > 0) { route = "item_code+desc2"; stats.matchedByMaterialCode++; }
      }
    }

    if (targets.length === 0) { stats.acLinesWithNoErpLine++; continue; }

    const hit = priceOf(line);
    if (!hit) {
      stats.acLinesWithNoPrice++;
      for (const t of targets) propose(t, { reject: SKIP.NO_PRICE, acLine: line });
      continue;
    }
    const centi = Math.round(hit.price * 100);
    for (const t of targets) propose(t, { centi, tier: hit.tier, route, acLine: line });
  }

  const plan = [];
  const skipped = [];
  for (const row of erpRows) {
    if (vetoed.has(row.id)) { skipped.push({ row, reason: SKIP.CODE_MISMATCH }); continue; }
    const ps = proposals.get(row.id) ?? [];
    const priced = ps.filter((p) => p.centi != null);
    if (priced.length === 0) {
      const rejected = ps.find((p) => p.reject);
      skipped.push({ row, reason: rejected ? rejected.reject : SKIP.NO_AC_LINE });
      continue;
    }
    /* Same price proposed twice is one write. DIFFERENT prices is a refusal:
       a wrong figure is worse than the zero already there, because the zero is
       visible and the receipt gate refuses it. */
    const distinct = [...new Set(priced.map((p) => p.centi))];
    if (distinct.length > 1) {
      skipped.push({ row, reason: SKIP.AMBIGUOUS, prices: distinct.sort((a, b) => a - b), from: priced.map((p) => p.acLine) });
      continue;
    }
    const win = priced[0];
    plan.push({
      id: row.id,
      poNumber: row.po_number,
      acDoc: row.ac_doc,
      code: row.item_code,
      description2: row.description2,
      qty: Number(row.qty) - Number(row.received_qty ?? 0),
      centi: win.centi,
      tier: win.tier,
      route: win.route,
      fromAcItemCode: win.acLine.ItemCode,
      fromAcDtlKey: win.acLine.PoDtlKey ?? null,
      fromAcDesc2: win.acLine.Desc2 ?? null,
    });
  }
  return { plan, skipped, stats };
}
