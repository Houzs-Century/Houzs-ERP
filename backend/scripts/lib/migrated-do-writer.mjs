// The ONE home for "turn AutoCount delivery lines into ERP delivery orders that
// move no stock". Extracted verbatim from create-migrated-documents.mjs on
// 2026-09-07 so a SECOND source of AutoCount DO rows could reuse the rule
// instead of copying it - a second copy of an import rule is this repo's most
// expensive recurring bug class, and this particular rule has already been
// repaired three times (docs/bugs/0016, 0030, 0043, 0617).
//
// TWO CALLERS, ONE MATCHER:
//   create-migrated-documents.mjs  rows from data/ac-partial-dos.json.gz
//                                  (the cutover cut: partial deliveries against
//                                  orders that were still open at migration)
//   sync-ac-delta.mjs              rows projected from
//                                  data/ac-reconcile-truth.json.gz (every DO
//                                  line in the book, including the ones raised
//                                  after the cut - the fidelity snapshot is 307
//                                  DO documents behind and cannot see them)
//
// A ROW IS: { DoNo, DoDate, SoNo, ItemCode, LineDesc, Qty, DebtorCode, DebtorName }
// LineDesc / DebtorCode / DebtorName may be null - the truth projection has no
// column for them. Blank stays blank (COPY, NEVER COMPUTE); the debtor NAME
// falls back to the sales order's own, because delivery_orders.debtor_name is
// NOT NULL and the order is the same customer by construction.
//
// THE LINE'S WAREHOUSE COMES FROM THE BOOK, NOT FROM THE SALES ORDER.
// AutoCount records a Location per DODTL row and the owner ruled on 2026-09-07
// that those codes ARE our stock warehouses (「HQ PGG 就是我们的 stock warehouse
// location」), so a row's `Location` is copied to `location` and resolved to
// `warehouse_id` through SALESLOC - the SHARED map in lib/ac-stock-compare.mjs,
// IMPORTED rather than re-typed, because a location table that exists in one
// script and not another is how stock silently moves between branches.
// An unmapped code stays NULL and is COUNTED; it is never guessed, and NULL
// simply leaves the reader on resolveDoLineWarehouses, which is what every
// reader does today. That fallback is right on 363 of the 366 book lines that
// carry a location and WRONG on 3 (DO-000097 shipped from HQ against a PG order
// line), which is the whole reason the stated value is worth storing.
//
// NO INVENTORY MOVEMENT, EVER. On-hand entered the ERP once through the
// AutoCount balance snapshot, which already counts these units as gone. Every
// header written here carries migrated_no_stock = true (migration 0276), which
// is the instruction to every future reconcile and repair job to leave it
// alone. Writing a movement for one of these double-counts the stock.
import fs from "node:fs";
import path from "node:path";

import { SALESLOC } from "./ac-stock-compare.mjs";

export const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

export function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

/** AutoCount ItemCode -> ERP item code, from the cutover's own mapping sheet. */
export function loadAcErpItemMap(dataDir) {
  const csv = fs.readFileSync(path.join(dataDir, "autocount-erp-mapping-1561.csv"), "utf8")
    .replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }
  return byAc;
}

export const sofaModelOf = (erp) => {
  const ALIAS = { 5530: "9028", 5536: "9058", 5537: "8030", 5540: "8030" };
  const m = (erp || "").replace(/-1S$/i, "").toUpperCase();
  return ALIAS[m] || m;
};

/** ERP sales-order lines indexed the two ways an AutoCount delivery line can name them. */
export function indexSoLines(soItems) {
  const soByKey = new Map();
  const soByModel = new Map();
  for (const it of soItems) {
    const code = norm(it.item_code);
    const k = `${it.ac}|${code}`;
    if (!soByKey.has(k)) soByKey.set(k, []);
    soByKey.get(k).push(it);
    /* A sofa arrives in the ERP as one line per COMPARTMENT, so an AutoCount
       delivery line naming the whole model can never match a code. Index the
       build by its model prefix as well, exactly as the photo importer does. */
    const dash = code.indexOf("-");
    if (dash < 0) continue;
    const mk = `${it.ac}|${code.slice(0, dash)}`;
    if (!soByModel.has(mk)) soByModel.set(mk, []);
    soByModel.get(mk).push(it);
  }
  return { soByKey, soByModel };
}

/* TWO WAYS THIS WRITER INSERTED THE SAME DELIVERY LINE TWICE, both fixed here.
   Measured on production 2026-08-11: 8 migrated documents, 18 surplus lines,
   every one an EXACT duplicate of its twin - same item, same qty, same
   so_item_id - so they are a double INSERT, not two real AutoCount lines.

     1. `targets` took cands[0] unconditionally, so a SECOND AutoCount row of
        the same item code on the same order produced a second delivery line
        pointing at the FIRST sales-order line. Consuming the candidates in
        order fixes the duplicate AND the mis-link underneath it: two rows of
        one code are two deliveries against two different lines.
     2. the sofa branch re-pushed EVERY compartment of a build each time
        another AutoCount row named the same model, multiplying a 3-piece
        sofa by however many rows AutoCount wrote.

   HC-SO-001920 is the visible one: 1 unit ordered, 4 delivery lines. */
export function buildMigratedDoPlan({ rows, itemMap, soItems, done = new Set() }) {
  const { soByKey, soByModel } = indexSoLines(soItems);
  const byDo = new Map();
  /* `byDoc` is the SAME drops, attributed to the delivery note they came off.
     The four counters below say HOW MANY book lines this run could not place;
     they cannot say WHICH DOCUMENT is now short, and that is the difference
     between "13 lines missed" and "DO-001800 has no lines at all, so it does
     not exist in the ERP, and DO-001953 exists with two of its four".
     create-migrated-documents.mjs reported only the counters, so both shapes
     were invisible: 2 documents vanished from the corpus and the run printed
     "DO documents: 82" — the count AFTER the loss — with nothing subtracted
     from anything. The reconcile then printed those 2 as "(owner-declined)".
     Attribution is what turns a total into a finding. */
  const stats = { noSoLine: 0, unmapped: 0, exhausted: 0, collapsed: 0, missExamples: [], missCodes: new Map(), byDoc: new Map(), unmappedLocations: new Map() };
  const noteDoc = (doNo, field, entry) => {
    let d = stats.byDoc.get(doNo);
    if (!d) { d = { bookLines: 0, kept: 0, dropped: [] }; stats.byDoc.set(doNo, d); }
    if (field === "book") d.bookLines += 1;
    else if (field === "kept") d.kept += 1;
    else d.dropped.push(entry);
    return d;
  };
  const taken = new Map();      // `DoNo|SoNo|code`  -> candidate SO lines already claimed
  const modelDone = new Set();  // `DoNo|SoNo|model` -> the whole build is already on this DO
  for (const r of rows) {
    noteDoc(r.DoNo, "book");
    const erp = itemMap.get(norm(r.ItemCode));
    if (!erp) {
      stats.unmapped++;
      noteDoc(r.DoNo, "dropped", { so: r.SoNo, code: r.ItemCode, desc: r.LineDesc ?? null, qty: r.Qty ?? null, why: "the mapping sheet has no ERP code for it" });
      continue;
    }
    /* Exact code first, then the build's compartment lines. A sofa AutoCount
       shipped as one whole unit corresponds to EVERY compartment of that build
       here, so all of them are marked delivered - otherwise the pieces stay
       outstanding and the set can be shipped a second time. */
    const cands = soByKey.get(`${r.SoNo}|${norm(erp)}`) ?? [];
    let targets = null;
    if (cands.length) {
      const ck = `${r.DoNo}|${r.SoNo}|${norm(erp)}`;
      const used = taken.get(ck) ?? 0;
      /* Out of distinct sales-order lines to claim. Reusing one is what created
         the duplicates, so the row is skipped and counted LOUDLY instead - the
         same choice backfill-ac-line-keys.mjs makes when a group's counts
         disagree, and for the same reason: a wrong link is worse than none. */
      if (used >= cands.length) {
        stats.exhausted++;
        noteDoc(r.DoNo, "dropped", { so: r.SoNo, code: norm(erp), desc: r.LineDesc ?? null, qty: r.Qty ?? null, why: `all ${cands.length} matching sales-order line(s) are already claimed by an earlier line of this same delivery` });
        continue;
      }
      taken.set(ck, used + 1);
      targets = [cands[used]];
    } else {
      const mk = `${r.DoNo}|${r.SoNo}|${sofaModelOf(erp)}`;
      if (modelDone.has(mk)) {
        stats.collapsed++;
        noteDoc(r.DoNo, "dropped", { so: r.SoNo, code: norm(erp), desc: r.LineDesc ?? null, qty: r.Qty ?? null, why: `every compartment of sofa ${sofaModelOf(erp)} is already on this delivery` });
        continue;
      }
      const pieces = soByModel.get(`${r.SoNo}|${sofaModelOf(erp)}`);
      if (pieces && pieces.length) { modelDone.add(mk); targets = pieces; }
    }
    if (!targets || !targets.length) {
      stats.noSoLine++;
      stats.missCodes.set(erp, (stats.missCodes.get(erp) ?? 0) + 1);
      if (stats.missExamples.length < 5) stats.missExamples.push({ so: r.SoNo, erp: norm(erp) });
      noteDoc(r.DoNo, "dropped", { so: r.SoNo, code: norm(erp), desc: r.LineDesc ?? null, qty: r.Qty ?? null, why: "that sales order carries no line with this item code" });
      continue;
    }
    noteDoc(r.DoNo, "kept");
    if (!byDo.has(r.DoNo)) byDo.set(r.DoNo, { doNo: r.DoNo, date: r.DoDate, so: targets[0].doc_no, acSo: r.SoNo,
      debtorCode: r.DebtorCode || null, debtorName: (r.DebtorName || "").trim() || null, items: [] });
    /* The book's own per-line location. Blank stays blank - COPY, NEVER
       COMPUTE - and a row from a projection with no Location column at all
       arrives undefined, which is the same answer. */
    const loc = String(r.Location ?? "").trim() || null;
    if (loc && !SALESLOC[loc.toUpperCase()]) {
      stats.unmappedLocations.set(loc, (stats.unmappedLocations.get(loc) ?? 0) + 1);
    }
    for (const t of targets) {
      byDo.get(r.DoNo).items.push({ code: t.item_code, name: r.LineDesc, qty: Math.round(Number(r.Qty || 0)),
        soItemId: t.id, group: t.item_group ?? null, variants: t.variants ?? null, desc2: t.description2 ?? null,
        location: loc,
        /* The MONEY, from the same row the normal create path reads it from.
           Omitted until docs/bugs/0617-the-migrated-delivery-orders-carried-no-money-at-all.md
           while the GRN writer always carried it. */
        unitPriceSen: t.unit_price_sen ?? 0, discountSen: t.discount_sen ?? 0, unitCostSen: t.unit_cost_sen ?? 0 });
    }
  }
  /* The invariant, asserted rather than inferred. Whatever the mapping above
     decides, one document may not carry the same sales-order line at the same
     quantity twice. The two fixes above remove the known causes; this refuses
     the SHAPE, so a future mapping path cannot reintroduce it silently. */
  for (const d of byDo.values()) {
    const seen = new Set(); const keep = [];
    for (const it of d.items) {
      const k = `${it.soItemId}|${norm(it.code)}|${it.qty}`;
      if (seen.has(k)) {
        stats.collapsed++;
        noteDoc(d.doNo, "dropped", { so: d.acSo, code: norm(it.code), desc: it.name ?? null, qty: it.qty, why: "an identical line (same order line, same quantity) is already on this delivery" });
        continue;
      }
      seen.add(k); keep.push(it);
    }
    d.items = keep;
  }
  const plan = [...byDo.values()].filter((d) => !done.has(d.doNo));
  return { plan, byDo, stats };
}

export const migratedDoNumber = (acDoNo) => `HC-${acDoNo}`;

/* AutoCount location code -> the ERP warehouse uuid, through the SHARED map.
 * `warehouseByCode` is keyed on scm.warehouses.CODE, which is what
 * backfill-so-line-warehouse.mjs resolves against and what the live master
 * actually holds (`KL WAREHOUSE`, `PG WAREHOUSE`, `HQ`, ... - measured
 * 2026-09-07). A code with no home returns null; the caller has already counted
 * it, and null leaves the reader on the resolution it uses today. */
export function resolveWarehouse(loc, warehouseByCode) {
  if (!loc || !warehouseByCode) return null;
  const k = String(loc).trim().toUpperCase();
  if (!k) return null;
  return warehouseByCode.get(String(SALESLOC[k] ?? k).toUpperCase()) ?? warehouseByCode.get(k) ?? null;
}

/** One migrated delivery order, header + lines, inside ONE transaction.
 *  `warehouseByCode` is REQUIRED and may legitimately be an empty Map. It is not
 *  optional because its absence DECIDES something - every line's warehouse
 *  silently NULL - and this repo's standing rule is that a parameter which
 *  decides is never optional (docs/bugs/0098, BUG CLASS optional-param-noop). */
export async function insertMigratedDo(sql, d, { companyId, sysUser, debtorFallback = null, warehouseByCode }) {
  const doNo = migratedDoNumber(d.doNo);
  return sql.begin(async (tx) => {
    const [hdr] = await tx`INSERT INTO scm.delivery_orders
        (do_number, so_doc_no, debtor_code, debtor_name, status, do_date, currency,
         company_id, created_by, notes, migrated_no_stock, linked_ac_docno)
      VALUES (${doNo}, ${d.so}, ${d.debtorCode},
              ${d.debtorName ?? debtorFallback ?? "(unnamed)"},
              'DELIVERED', ${(d.date || "").slice(0, 10) || null}, 'MYR',
              ${companyId}, ${sysUser},
              ${`mirrors AutoCount delivery ${d.doNo}. No stock movement: the balance snapshot already counts these units as delivered.`},
              true, ${d.doNo})
      RETURNING id`;
    /* THE PRICE COLUMNS ARE NOT OPTIONAL. They were omitted here while the GRN
       half of create-migrated-documents.mjs wrote unit_price_sen and
       line_total_sen - one file, two answers. They default to 0 NOT NULL, so
       the omission is silent, and it is NOT cosmetic: the DO line's price
       prefills a new Sales Invoice (do-line-remaining.ts:326 ->
       SalesInvoiceFromDo.tsx:321), the SI price-drift guard skips a zero by
       design ("no ratio to drift from"), and migrated_no_stock gates the SI and
       the PI but NOT the DO->SI path. An operator invoicing one of these would
       have been prefilled RM 0.00 with nothing said. See
       docs/bugs/0617-the-migrated-delivery-orders-carried-no-money-at-all.md. */
    let hdrTotal = 0;
    for (const it of d.items) {
      const unit = Math.round(Number(it.unitPriceSen ?? 0));
      const cost = Math.round(Number(it.unitCostSen ?? 0));
      /* THE DISCOUNT IS DELIBERATELY NOT CARRIED, and this is the one place
         this writer departs from the interactive create path
         (delivery-orders-mfg.ts:4048 does `(qty * unit) - discount`).
         `mfg_sales_order_items.discount_sen` is a LINE-level amount, not a
         per-unit one, and one migrated SO line is routinely split across
         several AutoCount delivery notes (that is what `taken`/`used` above is
         counting). Copying the whole discount onto each split would deduct it
         once per delivery. Dividing it needs a rule nobody has written. */
      const disc = 0;
      const lineTotal = Math.max(0, Math.round(Number(it.qty) * unit));
      hdrTotal += lineTotal;
      await tx`INSERT INTO scm.delivery_order_items
          (delivery_order_id, so_item_id, item_code, description, uom, qty, company_id,
           item_group, variants, description2,
           unit_price_sen, discount_sen, line_total_sen, unit_cost_sen, line_cost_sen,
           location, warehouse_id)
        VALUES (${hdr.id}, ${it.soItemId}, ${it.code}, ${it.name || null}, 'UNIT', ${it.qty}, ${companyId},
                ${it.group}, ${it.variants ? sql.json(it.variants) : null}, ${it.desc2},
                ${unit}, ${disc}, ${lineTotal}, ${cost}, ${Math.round(Number(it.qty) * cost)},
                ${it.location ?? null}, ${resolveWarehouse(it.location, warehouseByCode)})`;
    }
    /* The header total is Sigma line_total_sen everywhere else
       (delivery-orders-mfg.ts:461). Written here so the list's Amount column and
       its Revenue tile do not read RM 0.00 over priced lines. */
    await tx`UPDATE scm.delivery_orders
                SET local_total_sen = ${hdrTotal}, line_count = ${d.items.length}
              WHERE id = ${hdr.id}`;
    return { id: hdr.id, doNo, lines: d.items.length, totalSen: hdrTotal };
  });
}
