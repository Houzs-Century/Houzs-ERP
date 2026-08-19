#!/usr/bin/env node
// READ-ONLY. Everything the two sofa audits left unexplained, one section per
// open question. No writes, no DDL, one statement per query, no APPLY.
//
//   A. COMPARTMENT ON THE FIELD
//      check-sofa-bedframe-completeness.mjs:199-200 decides a sofa build's
//      compartment completeness from the import-time `SOFA UNPARSED` remark,
//      BEFORE it looks at whether a compartment code is actually on the line.
//      HC-PO-000254 is scored incomplete on all three of its lines while
//      carrying 5526-1ABOX(LHF) + 5526-2A(RHF) + 5526-1NA, which the owner
//      supplied by hand after the import. This section scores the same two
//      populations BOTH ways over ONE snapshot - the remark rule replicated
//      exactly, and a field rule that asks the data instead - so the two
//      numbers are comparable rather than quoted at each other. The residue
//      splits three ways, and only the third is a defect:
//        (i)   no compartment on the code, or the piece SKU is not minted
//        (ii)  compartment present and minted, remark now STALE
//        (iii) compartment present and minted, but the Desc2 decodes to a
//              DIFFERENT piece set - the build really is wrong
//
//   B. THE SHORT POs
//      LEG 1 of check-sofa-chain-alignment.mjs found builds whose PO carries
//      FEWER pieces than the SO. A missing piece is either covered elsewhere
//      or the factory under-builds the order, and the multiset test alone
//      cannot tell those apart. Four questions per build, all answered from
//      data: is the SO line CANCELLED; do the QUANTITIES actually balance
//      (two SO lines of one code against one PO line of qty 2 is not a short
//      order); is there a SECOND purchase order against the same sales order;
//      and was the piece bought on a PO line that simply lost its link.
//
//   C. VARIANT DIFFERENCES BY DIRECTION
//      "16 disagree" says nothing about WHICH side is wrong. Every axis is
//      classified parent-empty / child-empty / conflicting, because the first
//      example (HC-SO-000822 -> HC-PO-000275) is the PO carrying a full fabric
//      and divan stack against an SO carrying none - the sales order is the
//      thin one, and filling the PO from it would erase real data.
//
//   D. THE LINK
//      How many of the unlinked PO lines are a stock purchase (legitimate:
//      the link is procurement provenance, docs/modules/document-traceability.md)
//      versus a link that was lost, and which document holds the dangling one.
//
//   F. LEG 2 (PO -> GRN) ADJUDICATED BY DIRECTION AND BY TIME
//      A GRN is a SNAPSHOT of the PO at receipt. A difference is therefore not
//      automatically a defect, and rewriting the GRN to match a later PO
//      correction would destroy the receipt record. Every differing pair and
//      every piece-set difference is classified:
//        (a) the PO was CORRECTED AFTER the GRN was created — legitimate
//            history. Proved by comparing the PO line's own age against the
//            GRN's, not by assuming it.
//        (b) the SNAPSHOT WAS WRITTEN WRONG at creation — the GRN predates no
//            correction and still fails to carry what its PO line held.
//        (c) a GENUINE CONFLICT — both sides state a value and they disagree.
//      Only (b) and (c) get a proposed fix, and only as a proposal.
//
//   G. THE SO/PO VARIANT CONFLICTS, WITH AUTOCOUNT'S OWN TEXT AS THE TIE-BREAK
//      Section C says 14 pairs name different values on the customer's order
//      and the factory's order. This prints the decision table: model, axis,
//      SO value, PO value, whether the build is already DOWNSTREAM (a GRN or a
//      DO exists, so it may be built), and — the part that usually decides it —
//      whether the AutoCount Desc2 TEXT on each document agrees with the SO or
//      with the PO. No winner is chosen here. This is what the owner decides
//      from.
//
//   H. THE CANCELLATION SURFACE, INTROSPECTED
//      "不可以删只可以 cancel" needs a column to cancel INTO. The two line
//      tables are NOT symmetrical and assuming they are is how a repair script
//      dies at 42703 mid-run. Asked of information_schema, never assumed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { provenanceNoteRe } from "./lib/transfer-vocabulary.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const LIST = process.env.LIST !== "0";
const CAP = Number(process.env.CAP || 25);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
/* The ONE name of the Processing Date column, spliced as SQL text rather than
   bound as a parameter — see lib/so-processing-date.mjs for why. */
const PDATE = soProcessingDateFragment(sql);

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const modelOf = (code) => { const c = norm(code); const d = c.indexOf("-"); const b = d < 0 ? c : c.slice(0, d); return SOFA_MODEL_ALIAS[b] || b; };
const compOf = (code) => { const c = norm(code); const d = c.indexOf("-"); return d < 0 ? "" : c.slice(d + 1); };
const pieceOf = (grp, code) => (grp === "sofa" ? compOf(code) : norm(code));
const bag = (xs) => xs.map(norm).sort();
function multisetDiff(have, want) {
  const a = bag(have), b = bag(want);
  if (a.join("|") === b.join("|")) return null;
  const L = [...a], R = [...b];
  const miss = bag(want).filter((x) => { const i = L.indexOf(x); if (i < 0) return true; L.splice(i, 1); return false; });
  const extra = bag(have).filter((x) => { const i = R.indexOf(x); if (i < 0) return true; R.splice(i, 1); return false; });
  return { miss, extra };
}
const AXES = ["fabricCode", "colourId", "fabricId", "seatHeight", "depth", "divanHeight", "legHeight", "gap"];
const vget = (v, k) => { const x = (v || {})[k]; return x === undefined || x === null || String(x).trim() === "" ? null : String(x).trim(); };
const anyVariant = (v) => AXES.some((k) => vget(v, k) !== null);
const pct = (n, d) => (d === 0 ? "0 rows" : `${n}/${d}`);
const show = (arr, label) => {
  if (!LIST) return;
  if (!arr.length) { log(`      ${label}: none`); return; }
  log(`      --- ${label} (${arr.length}; showing up to ${CAP}) ---`);
  for (const t of arr.slice(0, CAP)) for (const ln of String(t).split("\n")) log(ln);
  if (arr.length > CAP) log(`      ... ${arr.length - CAP} more (raise CAP)`);
};

async function main() {
  log(`READ-ONLY sofa cutover residue diagnostic — company ${CO}`);

  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(prods.map((p) => norm(p.code)));
  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  const reclOf = (m) => RECL.some((s) => codeSet.has(norm(m + s)));

  /* Same two populations as check-sofa-bedframe-completeness.mjs, so section A
     is comparable to its numbers line for line: EVERY sofa/bedframe PO line,
     and sofa/bedframe SO lines on orders that have been PROCEEDED.
     PROCEEDED is read off internal_expected_dd, in step with that script — the
     Processing Date the UI writes, not the IN_PRODUCTION-only proceeded_at
     stamp. The two must move together or "line for line" stops being true. */
  const poRows = (await sql`
    SELECT i.id::text AS id, p.po_number AS doc, p.id::text AS po_hdr_id, p.linked_ac_docno AS ac,
           UPPER(COALESCE(p.status::text, '')) AS po_status, COALESCE(p.notes, '') AS po_notes,
           i.item_code AS code, i.item_group AS grp, i.description2 AS d2, i.variants,
           COALESCE(i.notes, '') AS remark, i.qty, i.received_qty, i.so_item_id::text AS so_item_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group IN ('bedframe', 'sofa')
     ORDER BY p.po_number`).map((r) => ({ ...r }));

  const soProceeded = (await sql`
    SELECT i.id::text AS id, h.doc_no AS doc, h.linked_ac_docno AS ac, i.item_code AS code,
           i.item_group AS grp, i.description2 AS d2, i.variants, COALESCE(i.remark, '') AS remark,
           i.qty, i.cancelled, i.stock_status
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group IN ('bedframe', 'sofa')
       AND h.${PDATE} IS NOT NULL
     ORDER BY h.doc_no, i.line_no`).map((r) => ({ ...r }));

  /* Sections B/C/D need EVERY sofa/bedframe SO line, proceeded or not, because
     a PO line's so_item_id may name an order that was never proceeded. */
  const soAll = (await sql`
    SELECT i.id::text AS id, i.doc_no AS doc, i.item_code AS code, i.item_group AS grp,
           i.variants, i.description2 AS d2, i.qty, i.cancelled, i.stock_status, i.line_no,
           UPPER(COALESCE(h.status::text, '')) AS so_status, h.proceeded_at
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
     WHERE i.company_id = ${CO} AND i.item_group IN ('bedframe', 'sofa')
     ORDER BY i.doc_no, i.line_no`).map((r) => ({ ...r }));

  // ══ A. COMPARTMENT ON THE FIELD ═════════════════════════════════════════
  log("");
  log("=== A. COMPARTMENT COMPLETENESS: the remark rule vs the field");
  log("    Same snapshot, scored twice. REMARK RULE = check-sofa-bedframe-completeness.mjs:199-200");
  log("    replicated exactly (an import-time SOFA UNPARSED note fails the whole build before the");
  log("    code is looked at). FIELD RULE = the line carries a minted {model}-{piece} code, and");
  log("    where the Desc2 can still be decoded the build agrees with it.");

  for (const [pop, rows] of [["PO", poRows], ["SO", soProceeded]]) {
    const builds = new Map();
    for (const r of rows) {
      if (r.grp !== "sofa") continue;
      const k = `${r.doc}|${modelOf(r.code)}|${norm(r.d2).slice(0, 140)}`;
      if (!builds.has(k)) builds.set(k, []);
      builds.get(k).push(r);
    }
    const state = new Map(); // line id -> { hasRemark, decodable, diff, want }
    for (const [, b] of builds) {
      const f = b[0];
      const hasRemark = b.some((r) => /SOFA UNPARSED/i.test(r.remark || ""));
      const ps = parseSofa(f.d2, modelOf(f.code), reclOf(modelOf(f.code)));
      const decodable = ps.conf !== "low" && (ps.pieces || []).length > 0;
      const diff = decodable ? multisetDiff(b.map((r) => compOf(r.code)), ps.pieces) : null;
      for (const r of b) state.set(r.id, { hasRemark, decodable, diff, want: ps.pieces || [], build: b, why: ps.why || [] });
    }

    const sofa = rows.filter((r) => r.grp === "sofa");
    let oldOk = 0, newOk = 0;
    const bI = [], bIIa = [], bIIb = [], bIIIhidden = [], bIIIvisible = [];
    for (const r of sofa) {
      const s = state.get(r.id);
      const comp = compOf(r.code);
      const minted = codeSet.has(norm(r.code));
      const fieldBad = !comp || !minted;

      // REMARK RULE, exactly as the sibling scores it
      const oldBad = fieldBad || s.hasRemark || (!s.hasRemark && s.decodable && s.diff);
      if (!oldBad) oldOk++;
      // FIELD RULE: the remark is not consulted at all
      const newBad = fieldBad || (s.decodable && s.diff);
      if (!newBad) newOk++;

      const line = `      ${r.doc}${r.ac ? ` (AC ${r.ac})` : ""}  ${r.code}  x${r.qty}`;
      if (fieldBad) {
        bI.push(`${line}\n         ${!comp ? `no {model}-{piece} suffix on the code` : `piece SKU not minted in mfg_products`}`);
      } else if (s.decodable && s.diff) {
        const t = `${line}\n         build has ${s.build.map((x) => compOf(x.code)).join("+")}; Desc2 decodes ${s.want.join("+")}`
          + `\n         Desc2 asks for and the document lacks: ${s.diff.miss.join(", ") || "(none)"}`
          + `\n         document has and the Desc2 never asked for: ${s.diff.extra.join(", ") || "(none)"}`
          + `\n         Desc2: ${JSON.stringify(String(r.d2 || "").slice(0, 110))}`;
        (s.hasRemark ? bIIIhidden : bIIIvisible).push(t);
      } else if (s.hasRemark) {
        /* The remark is a BUILD-level flag, so print the build's copy of it.
           Printing the line's own would show an empty string for the siblings
           of the flagged row and read as if nothing were flagged. */
        const carried = (s.build.find((x) => /SOFA UNPARSED/i.test(x.remark || "")) || {}).remark || "";
        (s.decodable ? bIIb : bIIa).push(`${line}\n         build remark: ${JSON.stringify(String(carried).slice(0, 90))}`
          + `\n         ${s.decodable ? `Desc2 decodes ${s.want.join("+")} and the document AGREES` : `Desc2 still cannot be decoded (${(s.why || []).join("; ") || "unreadable"}) — the pieces on the line came from a human`}`);
      }
    }
    /* (ii) is NOT residue. It is exactly the set the remark rule fails and the
       field rule passes, so it must equal the gap between the two totals — and
       that identity is asserted rather than asserted-about. */
    const stale = bIIa.length + bIIb.length;
    const realBad = bI.length + bIIIhidden.length + bIIIvisible.length;
    log("");
    log(`    ${pop} SOFA lines: ${sofa.length}`);
    log(`      complete under the REMARK rule (what is reported today)  ${pct(oldOk, sofa.length)}`);
    log(`      complete under the FIELD rule (what the data supports)   ${pct(newOk, sofa.length)}`);
    log(`      (ii) present + minted, remark now STALE                  ${stale}   (Desc2 undecodable ${bIIa.length} / Desc2 decodes and agrees ${bIIb.length})`);
    log(`           ^ these are FIELD-COMPLETE lines the remark rule fails. ${newOk} - ${oldOk} = ${newOk - oldOk}, and (ii) = ${stale}: ${newOk - oldOk === stale ? "they match, as they must" : "MISMATCH — the two rules differ for some other reason too"}`);
    log(`      STILL INCOMPLETE on the field:                           ${realBad}`);
    log(`        (i)   no compartment on the code / SKU not minted      ${bI.length}`);
    log(`        (iii) present + minted, Desc2 says DIFFERENT           ${bIIIhidden.length + bIIIvisible.length}   (hidden behind the remark ${bIIIhidden.length} / already visible ${bIIIvisible.length})`);
    log(`      arithmetic: ${newOk} complete + ${realBad} incomplete = ${newOk + realBad}, of ${sofa.length}: ${newOk + realBad === sofa.length ? "balances" : "DOES NOT BALANCE"}`);
    show(bIIIhidden.concat(bIIIvisible), `${pop} (iii) — the only real compartment defects`);
    show(bI, `${pop} (i) — no compartment / not minted`);
    show(bIIa, `${pop} (ii-a) — stale remark, Desc2 undecodable (owner-supplied pieces)`);
    show(bIIb, `${pop} (ii-b) — stale remark, Desc2 decodes and the document agrees`);
  }

  // ══ B. THE SHORT POs ════════════════════════════════════════════════════
  log("");
  log("=== B. BUILDS WHOSE PO CARRIES FEWER PIECES THAN THE SO");
  log("    A missing piece is only a short order if the QUANTITY is short too, no sibling PO");
  log("    covers it, and the SO line is not cancelled. All four tested per build.");

  const soById = new Map(soAll.map((r) => [r.id, r]));
  const soBuilds = new Map();
  for (const r of soAll) {
    if (r.cancelled) continue;
    const k = `${r.doc}|${modelOf(r.code)}|${norm(r.d2).slice(0, 140)}`;
    if (!soBuilds.has(k)) soBuilds.set(k, { doc: r.doc, grp: r.grp, model: modelOf(r.code), d2: r.d2, so: [], po: [] });
    soBuilds.get(k).so.push(r);
    r.build = soBuilds.get(k);
  }
  const poBySoDoc = new Map(); // SO doc -> every PO line linked to any of its lines
  for (const p of poRows) {
    if (!p.so_item_id) continue;
    const s = soById.get(p.so_item_id);
    if (!s) continue;
    if (s.build) s.build.po.push(p);
    if (!poBySoDoc.has(s.doc)) poBySoDoc.set(s.doc, []);
    poBySoDoc.get(s.doc).push(p);
  }
  /* Cancelled SO lines were dropped from the build above; a piece the PO lacks
     may be sitting on one, which is the whole point of looking. */
  const cancelledByDoc = new Map();
  for (const r of soAll) if (r.cancelled) { if (!cancelledByDoc.has(r.doc)) cancelledByDoc.set(r.doc, []); cancelledByDoc.get(r.doc).push(r); }

  const shortReports = [];
  let nShort = 0, nQtyBalances = 0, nCancelExplains = 0, nSiblingCovers = 0, nGenuine = 0;
  for (const b of soBuilds.values()) {
    if (!b.po.length) continue;
    /* multisetDiff(have, want).miss = what WANT asks for and HAVE lacks. The
       PO is the "have" and the SO is the "want", so miss is exactly the set of
       pieces the customer ordered and the factory was not asked to build.
       Getting this pair the wrong way round reports a clean chain. */
    const d = multisetDiff(b.po.map((r) => pieceOf(b.grp, r.code)), b.so.map((r) => pieceOf(b.grp, r.code)));
    if (!d || !d.miss.length) continue;
    nShort++;
    const lines = [`      ${b.doc} -> ${[...new Set(b.po.map((x) => x.doc))].join(",")}   ${b.grp} ${b.model}`,
                   `         SO pieces : ${b.so.map((r) => pieceOf(b.grp, r.code)).join("+")}`,
                   `         PO pieces : ${b.po.map((r) => pieceOf(b.grp, r.code)).join("+")}`,
                   `         PO lacks  : ${d.miss.join(", ")}`];
    /* QUANTITY is the test the multiset cannot make. Two SO lines of one code
       against one PO line of qty 2 is the same order, differently written. */
    const soQty = new Map(), poQty = new Map();
    for (const r of b.so) soQty.set(pieceOf(b.grp, r.code), (soQty.get(pieceOf(b.grp, r.code)) ?? 0) + Number(r.qty || 0));
    for (const r of b.po) poQty.set(pieceOf(b.grp, r.code), (poQty.get(pieceOf(b.grp, r.code)) ?? 0) + Number(r.qty || 0));
    const qtyRows = [...new Set([...soQty.keys(), ...poQty.keys()])].map((k) => `${k} SO=${soQty.get(k) ?? 0} PO=${poQty.get(k) ?? 0}`);
    lines.push(`         quantities: ${qtyRows.join(" | ")}`);
    const qtyBalances = [...new Set([...soQty.keys(), ...poQty.keys()])].every((k) => (soQty.get(k) ?? 0) === (poQty.get(k) ?? 0));

    const verdicts = [];
    if (qtyBalances) { verdicts.push("QUANTITIES BALANCE per piece code — the piece list differs only in how many ROWS carry it, not in how much is being bought"); nQtyBalances++; }
    // a cancelled SO line carrying the missing piece
    const canc = (cancelledByDoc.get(b.doc) ?? []).filter((r) => d.miss.includes(norm(pieceOf(b.grp, r.code))));
    if (canc.length) { verdicts.push(`CANCELLED SO line carries ${canc.map((r) => pieceOf(b.grp, r.code)).join(", ")} — not ordered any more`); nCancelExplains++; }
    // a sibling PO against the same SO document that carries the missing piece
    const sibs = (poBySoDoc.get(b.doc) ?? []).filter((p) => !b.po.some((x) => x.id === p.id) && d.miss.includes(norm(pieceOf(b.grp, p.code))));
    if (sibs.length) { verdicts.push(`a SECOND purchase order on the same sales order carries it: ${[...new Set(sibs.map((p) => `${p.doc}:${p.code}`))].join(", ")}`); nSiblingCovers++; }
    // the piece bought on a PO line that lost its link: same code AND same Desc2
    const lost = poRows.filter((p) => !p.so_item_id && d.miss.includes(norm(pieceOf(b.grp, p.code)))
      && norm(p.d2).slice(0, 140) === norm(b.d2).slice(0, 140) && norm(b.d2));
    if (lost.length) verdicts.push(`bought on an UNLINKED PO line with the same AutoCount text: ${[...new Set(lost.map((p) => `${p.doc}:${p.code}`))].join(", ")}`);
    // what the SO says about the missing lines
    const missSo = b.so.filter((r) => d.miss.includes(norm(pieceOf(b.grp, r.code))));
    if (missSo.length) lines.push(`         the SO lines the PO does not cover: ${missSo.map((r) => `${r.code} qty=${r.qty} stock_status=${r.stock_status ?? "-"}`).join(" | ")}`);
    const allPoOnDoc = [...new Set((poBySoDoc.get(b.doc) ?? []).map((p) => p.doc))];
    lines.push(`         purchase orders touching ${b.doc}: ${allPoOnDoc.join(", ") || "(none)"}`);

    if (!verdicts.length) { verdicts.push("NOTHING COVERS IT — the factory is being asked for fewer pieces than the customer ordered"); nGenuine++; }
    lines.push(`         VERDICT: ${verdicts.join("; ")}`);
    shortReports.push(lines.join("\n"));
  }
  log(`    builds whose PO lacks a piece            ${nShort}`);
  log(`      explained: quantities balance          ${nQtyBalances}`);
  log(`      explained: a cancelled SO line         ${nCancelExplains}`);
  log(`      explained: a second PO on the same SO  ${nSiblingCovers}`);
  log(`      NOT EXPLAINED (genuine short order)    ${nGenuine}`);
  show(shortReports, "every short build, with its evidence");

  // ══ C. VARIANT DIFFERENCES BY DIRECTION ═════════════════════════════════
  log("");
  log("=== C. SO -> PO VARIANT DIFFERENCES, BY DIRECTION");
  log("    parent-empty = the SALES ORDER is the thin one (fill the SO from the PO).");
  log("    child-empty  = the PURCHASE ORDER is the thin one (fill the PO from the SO).");
  log("    conflict     = both sides state a value and they disagree — needs a human.");
  let cParentEmpty = 0, cChildEmpty = 0, cMixed = 0, cConflict = 0, cChildBlank = 0;
  const axisTally = new Map();
  const detail = [];
  for (const p of poRows) {
    if (!p.so_item_id) continue;
    const s = soById.get(p.so_item_id);
    if (!s) continue;
    const pe = [], ce = [], cf = [];
    for (const k of AXES) {
      const a = vget(s.variants, k), b = vget(p.variants, k);
      if (a === b) continue;
      if (a === null) pe.push(`${k}: SO - vs PO ${b}`);
      else if (b === null) ce.push(`${k}: SO ${a} vs PO -`);
      else if (norm(a) !== norm(b)) cf.push(`${k}: SO ${a} vs PO ${b}`);
      if (a !== b) axisTally.set(k, (axisTally.get(k) ?? 0) + 1);
    }
    if (!pe.length && !ce.length && !cf.length) continue;
    const childBlank = !anyVariant(p.variants);
    if (childBlank) cChildBlank++;
    let kind;
    if (cf.length) { kind = "CONFLICT"; cConflict++; }
    else if (pe.length && ce.length) { kind = "MIXED"; cMixed++; }
    else if (pe.length) { kind = "SO IS EMPTY -> fill the SO from the PO"; cParentEmpty++; }
    else { kind = "PO IS EMPTY -> fill the PO from the SO"; cChildEmpty++; }
    detail.push(`      ${s.doc} -> ${p.doc}  ${p.grp} ${p.code}  [${kind}${childBlank ? ", the PO line carries NO variants at all" : ""}]\n`
      + [...pe, ...ce, ...cf].map((x) => `         ${x}`).join("\n"));
  }
  log(`    linked pairs that differ on at least one axis   ${detail.length}`);
  log(`      SO empty, PO has the value                    ${cParentEmpty}`);
  log(`      PO empty, SO has the value                    ${cChildEmpty}`);
  log(`      MIXED (each side empty on a different axis)   ${cMixed}`);
  log(`      CONFLICT (both stated, different)             ${cConflict}`);
  log(`      of all the above, PO lines carrying NO variants at all: ${cChildBlank}`);
  log(`    per-axis: ${[...axisTally.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") || "0 rows"}`);
  show(detail, "every differing pair, with the direction");

  // ══ D. THE LINK ═════════════════════════════════════════════════════════
  log("");
  log("=== D. THE so_item_id LINK ON PURCHASE ORDER LINES");
  const unlinked = poRows.filter((r) => !r.so_item_id);
  const linkedIds = new Set(poRows.filter((r) => r.so_item_id).map((r) => r.po_hdr_id));
  const mixedHdr = unlinked.filter((r) => linkedIds.has(r.po_hdr_id));
  const pureStock = unlinked.filter((r) => !linkedIds.has(r.po_hdr_id));
  // The provenance label (either era, via the shared list) OR a bare doc-number
  // shape — this one is a HEURISTIC for "the note talks about an order at all",
  // so it stays broader than the parser on purpose.
  const mentionsSo = unlinked.filter(
    (r) => provenanceNoteRe().test(String(r.po_notes ?? "")) || /HC-SO-|SO-\d/i.test(String(r.po_notes ?? "")),
  );
  log(`    PO lines with a NULL so_item_id            ${unlinked.length} of ${poRows.length}`);
  log(`      on a PO where NO line is linked          ${pureStock.length}   (a stock purchase: nothing to point at — provenance, not a defect)`);
  log(`      on a PO where OTHER lines ARE linked     ${mixedHdr.length}   (same document, some lines claimed and some not — the candidates for a LOST link)`);
  log(`      on a PO whose notes name a sales order   ${mentionsSo.length}   (a shared buy raised before the per-line link existed)`);
  /* A lost link is testable, not a feeling: does an SO line exist that this PO
     line plainly belongs to - same code AND the same AutoCount text - and is
     that SO line not already claimed by another PO line? */
  const claimed = new Set(poRows.filter((r) => r.so_item_id).map((r) => r.so_item_id));
  const soByCodeD2 = new Map();
  for (const s of soAll) {
    if (!norm(s.d2)) continue;
    const k = `${norm(s.code)}|${norm(s.d2).slice(0, 140)}`;
    if (!soByCodeD2.has(k)) soByCodeD2.set(k, []);
    soByCodeD2.get(k).push(s);
  }
  const lostCandidates = [];
  for (const p of mixedHdr) {
    if (!norm(p.d2)) continue;
    const cands = (soByCodeD2.get(`${norm(p.code)}|${norm(p.d2).slice(0, 140)}`) ?? []).filter((s) => !claimed.has(s.id) && !s.cancelled);
    if (cands.length === 1) lostCandidates.push(`      ${p.doc}  ${p.code} x${p.qty}  -> unclaimed SO line ${cands[0].doc} line ${cands[0].line_no} (same code, same AutoCount text)`);
  }
  log(`      of those, an unclaimed SO line matches on code AND AutoCount text: ${lostCandidates.length}`);
  show(lostCandidates, "PO lines whose link looks recoverable (PROPOSAL ONLY — nothing is written)");

  const dangling = poRows.filter((r) => r.so_item_id && !soById.has(r.so_item_id));
  log(`    PO lines whose so_item_id names a row that is not a company-${CO} sofa/bedframe SO line: ${dangling.length}`);
  for (const p of dangling.slice(0, CAP)) {
    /* "Dangling" has three very different causes and only one is a defect:
       the target may be a NON sofa/bedframe line (out of this audit's scope,
       perfectly alive), it may belong to another company, or it may be gone. */
    const [hit] = await sql`SELECT i.id::text AS id, i.doc_no, i.item_code, i.item_group, i.company_id,
                                   i.cancelled, i.line_no
                              FROM scm.mfg_sales_order_items i WHERE i.id = ${p.so_item_id}::uuid LIMIT 1`;
    if (!hit) log(`      ${p.doc}  ${p.code} x${p.qty}  so_item_id=${p.so_item_id}  -> NO SUCH ROW: the sales-order line was deleted while the PO kept pointing at it`);
    else log(`      ${p.doc}  ${p.code} x${p.qty}  -> ALIVE: ${hit.doc_no} line ${hit.line_no} ${hit.item_code} group=${hit.item_group} company=${hit.company_id} cancelled=${hit.cancelled}`
      + `  (not a defect if the group is outside sofa/bedframe — this audit's scope, not the data, is what excluded it)`);
  }

  // ══ E. ROWS ALREADY DELETED IN PRODUCTION ═══════════════════════════════
  log("");
  log('=== E. "不可以删只可以 cancel" — WAS ANYTHING ACTUALLY DELETED?');
  log("    apply-sofa-compartment-corrections.mjs DELETEs a surplus line when the corrected build");
  log("    holds fewer pieces than the document does. Run 31393696809 (APPLY=1, 13:35Z) logged");
  log("    'removed 2'. A log line is not evidence, so this asks the DATABASE instead: for every");
  log("    build the correction file names, does the document still hold at least as many sofa");
  log("    lines as the correction's target piece list?");
  let DATA = null;
  try { DATA = JSON.parse(fs.readFileSync(path.join(here, "data", "sofa-compartment-corrections-2026-08.json"), "utf8")); }
  catch { log("    correction data file not readable — section skipped"); }
  if (DATA) {
    const soByDocAll = new Map();
    for (const r of soAll) { if (!soByDocAll.has(r.doc)) soByDocAll.set(r.doc, []); soByDocAll.get(r.doc).push(r); }
    /* soAll excludes nothing, but a DELETED row is by definition absent from it,
       so a shortfall against the target list is the deletion's fingerprint. */
    const shortfalls = [], intact = [];
    for (const c of DATA.corrections) {
      for (const doc of c.docs.filter((d) => /^HC-SO-/.test(d))) {
        const all = (soByDocAll.get(doc) ?? []).filter((r) => r.grp === "sofa");
        const rows = c.desc2Match ? all.filter((r) => String(r.d2 ?? "").includes(c.desc2Match)) : all;
        if (!rows.length) continue;
        const model = norm(c.model || modelOf(rows[0].code));
        const want = c.pieces.map((p) => (norm(p).startsWith(model + "-") ? norm(p) : `${model}-${norm(p)}`));
        const line = `      ${doc}  ${model}  now holds ${rows.length} line(s): ${rows.map((r) => `${compOf(r.code)}${r.cancelled ? "(CANCELLED)" : ""}`).join("+")}`
          + `\n         the correction's target was ${want.length}: ${c.pieces.join("+")}`;
        if (rows.length < want.length) shortfalls.push(line + "\n         SHORTFALL — the document holds FEWER lines than the correction aimed at");
        else intact.push(line);
      }
    }
    log(`    corrected sales orders checked against their target piece list: ${intact.length + shortfalls.length}`);
    log(`      document holds at least the target number of lines            ${intact.length}`);
    log(`      document holds FEWER than the target                          ${shortfalls.length}`);
    show(shortfalls, "documents short of their own target");

    /* The two the log named, in full, so the restoration item is actionable
       rather than a claim. A build the correction re-shaped from 3 rows to 2
       should now show 2 live rows and NO cancelled third: that absence is the
       deleted row. */
    for (const doc of ["HC-SO-012624", "HC-SO-013167"]) {
      const rows = (soByDocAll.get(doc) ?? []).filter((r) => r.grp === "sofa");
      log(`    ${doc}: ${rows.length} sofa line(s) in the database now`);
      if (!rows.length) { log("      the document has no sofa lines at all"); continue; }
      for (const r of rows) log(`      line ${r.line_no}  ${r.code}  qty=${r.qty}  cancelled=${r.cancelled}`);
      const cancelled = rows.filter((r) => r.cancelled).length;
      log(`      live ${rows.length - cancelled} / cancelled ${cancelled}.`
        + ` The run logged one surplus piece removed here; a CANCELLED row would have preserved it.`
        + ` ${cancelled === 0 ? "There is no cancelled row, so the DELETE did happen and the piece is unrecoverable from this table." : "A cancelled row is present."}`);
    }
    log("    PROPOSAL (nothing written): re-create each deleted piece as a CANCELLED line at 0 price so");
    log("    the document's history shows the piece existed and was withdrawn, and change the script's");
    log("    surplus branch from DELETE to a cancel. OWNER DECISION — see docs/sofa-document-chain-map.md.");
  }

  // ══ F. LEG 2 (PO -> GRN) ADJUDICATED ════════════════════════════════════
  log("");
  log("=== F. PO -> GRN: EVERY DIFFERENCE CLASSIFIED (a) history / (b) bad snapshot / (c) conflict");
  log("    A GRN is a snapshot of the PO at RECEIPT. If the PO changed afterwards the GRN is");
  log("    RIGHT to disagree, and rewriting it would destroy the receipt record. So the first");
  log("    question is never 'do they differ' but 'which one is older'.");
  /* to_jsonb(row) instead of a named column list: the timestamp columns on these
     tables are not the same set, and a guessed name is a 42703 that kills the
     whole diagnostic. Ask for everything and pick what is actually there. */
  const grPairs = (await sql`
    SELECT to_jsonb(gi) AS gi, to_jsonb(g) AS g, to_jsonb(i) AS i,
           g.grn_number AS grn_doc, p.po_number AS po_doc
      FROM scm.grn_items gi
      JOIN scm.grns g ON g.id = gi.grn_id
      JOIN scm.purchase_order_items i ON i.id = gi.purchase_order_item_id
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE g.company_id = ${CO} AND i.item_group IN ('bedframe', 'sofa')
     ORDER BY p.po_number, g.grn_number`).map((r) => ({ ...r }));

  const ts = (o, ...names) => {
    for (const n of names) { const v = o?.[n]; if (v) { const d = new Date(v); if (!Number.isNaN(+d)) return d; } }
    return null;
  };
  /* The compartment corrections ran as GitHub workflow 31393696809 and its
     siblings between 13:35Z and 17:05Z on 2026-08-10. A PO line whose own
     timestamp lands in that window was written BY a correction, which is the
     single most common reason a GRN older than it disagrees. */
  const CORR_FROM = new Date("2026-08-10T13:30:00Z"), CORR_TO = new Date("2026-08-10T18:00:00Z");
  const inCorrWindow = (d) => d && d >= CORR_FROM && d <= CORR_TO;

  const bkt = { a: [], bLost: [], bRicher: [], c: [] };
  let same = 0, noTime = 0;
  for (const r of grPairs) {
    const P = r.i, G = r.gi, H = r.g;
    const diffs = [];
    for (const k of AXES) {
      const a = vget(P.variants, k), b = vget(G.variants, k);
      if (a === b) continue;
      if (a !== null && b !== null && norm(a) === norm(b)) continue;
      diffs.push({ k, po: a, grn: b });
    }
    const codeDiff = norm(P.item_code) !== norm(G.item_code);
    if (!diffs.length && !codeDiff) { same++; continue; }

    const poT = ts(P, "updated_at", "created_at");
    const grT = ts(G, "created_at") ?? ts(H, "created_at", "posted_at", "received_at");
    const head = `      ${r.po_doc} -> ${r.grn_doc}  ${P.item_group} ${modelOf(P.item_code)} ${compOf(P.item_code) || norm(P.item_code)}\n` +
                 `         ${diffs.map((d) => `${d.k}: PO ${d.po ?? "-"} vs GRN ${d.grn ?? "-"}`).join("\n         ")}` +
                 (codeDiff ? `\n         code: PO ${P.item_code} vs GRN ${G.item_code}` : "");
    if (!poT || !grT) noTime++;
    if (poT && grT && poT > grT) {
      bkt.a.push(head + `\n         (a) PO line last written ${poT.toISOString()} — AFTER the GRN (${grT.toISOString()}).` +
                        `${inCorrWindow(poT) ? " That is inside the 2026-08-10 compartment-correction window." : ""}` +
                        " The receipt is a faithful record of what the PO said at the time. DO NOT TOUCH.");
      continue;
    }
    /* NO TABLE IN THIS CHAIN HAS AN updated_at — section H proves it. So the
       timestamp test can only catch a line that was INSERTED after the receipt,
       never one that was UPDATED after it, and an UPDATE is exactly what a
       backfill does. Where a script's own SCOPE settles it, that is the
       evidence instead: backfill-sofa-leg-default.mjs (2026-08-10) writes
       scm.mfg_sales_order_items (:148) and scm.purchase_order_items (:152) and
       NEVER scm.grn_items, so a "Default" leg on the PO against an empty leg on
       the GRN is that backfill reaching the parent after the child was taken.
       It is history, not a lost snapshot. */
    const legDefaultOnly = diffs.length > 0 && !codeDiff &&
      diffs.every((d) => d.k === "legHeight" && d.grn === null && norm(d.po) === "DEFAULT");
    if (legDefaultOnly) {
      bkt.a.push(head + "\n         (a) legHeight 'Default' written onto the PO by backfill-sofa-leg-default.mjs AFTER this receipt;" +
                        " that script writes the SO and PO arms only and never grn_items. The GRN correctly records a line that had no leg pick at receipt. DO NOT TOUCH.");
      continue;
    }
    const conflicting = diffs.filter((d) => d.po !== null && d.grn !== null);
    if (conflicting.length) { bkt.c.push(head + "\n         (c) both documents state a value and they disagree, and the PO is not the newer document."); continue; }
    const grnEmpty = diffs.filter((d) => d.po !== null && d.grn === null).length;
    const poEmpty = diffs.filter((d) => d.po === null && d.grn !== null).length;
    if (grnEmpty && !poEmpty) bkt.bLost.push(head + "\n         (b) the GRN is the THIN one: the snapshot did not copy what the PO line held. Fixable — fill the GRN from its PO line.");
    else if (poEmpty && !grnEmpty) bkt.bRicher.push(head + "\n         (b) the GRN is the RICH one: the receipt records something the PO line never held. Do NOT overwrite the receipt; the PO is the candidate to fill.");
    else bkt.c.push(head + "\n         (c) each side is empty on a different axis — no single direction fits.");
  }
  log(`    linked PO -> GRN pairs examined                       ${grPairs.length}`);
  log(`      identical                                           ${same}`);
  log(`      (a) PO changed AFTER the GRN — legitimate history   ${bkt.a.length}`);
  log(`      (b) snapshot thin: GRN lacks what the PO holds      ${bkt.bLost.length}`);
  log(`      (b) snapshot rich: GRN holds what the PO lacks      ${bkt.bRicher.length}`);
  log(`      (c) genuine conflict                                ${bkt.c.length}`);
  log(`      pairs where no usable timestamp exists on either side: ${noTime}`);
  show(bkt.a, "(a) legitimate history — NOT a defect, no fix proposed");
  show(bkt.bLost, "(b) GRN thinner than its PO line — PROPOSED FIX: copy the PO line's variants onto the GRN line");
  show(bkt.bRicher, "(b) GRN richer than its PO line — PROPOSED FIX: none on the GRN; the PO is what is thin");
  show(bkt.c, "(c) genuine conflict — needs a human");

  /* The build-level (piece-set) differences get the same time test: a piece the
     correction ADDED to the PO after receipt cannot be on the GRN, and that is
     not a receipt defect. */
  log("");
  log("    PIECE-SET differences on this leg, same test:");
  const byPoLine = new Map(grPairs.map((r) => [r.i.id, r]));
  const poByHdr = new Map();
  for (const p of poRows) { if (!poByHdr.has(p.po_hdr_id)) poByHdr.set(p.po_hdr_id, []); poByHdr.get(p.po_hdr_id).push(p); }
  let psA = 0, psB = 0;
  const psLines = [];
  for (const [, lines] of poByHdr) {
    const received = lines.filter((p) => byPoLine.has(p.id));
    if (!received.length || received.length === lines.length) continue;
    const missing = lines.filter((p) => !byPoLine.has(p.id));
    const grT = ts(byPoLine.get(received[0].id).gi, "created_at") ?? ts(byPoLine.get(received[0].id).g, "created_at", "posted_at", "received_at");
    const newer = [], older = [];
    for (const m of missing) {
      const [row] = await sql`SELECT to_jsonb(i) AS i FROM scm.purchase_order_items i WHERE i.id = ${m.id}::uuid`;
      const t = ts(row?.i, "created_at", "updated_at");
      (t && grT && t > grT ? newer : older).push(`${compOf(m.code) || norm(m.code)}${t ? ` (line written ${t.toISOString()})` : " (no timestamp)"}`);
    }
    if (newer.length && !older.length) { psA++; psLines.push(`      ${lines[0].doc}: GRN lacks ${newer.join(", ")}\n         (a) that PO line was created AFTER the receipt. The GRN could not have received a piece that did not exist yet.`); }
    else { psB++; psLines.push(`      ${lines[0].doc}: GRN lacks ${[...newer, ...older].join(", ")}\n         (b/c) at least one missing piece is OLDER than the receipt — either a partial receipt still outstanding, or a snapshot that dropped it.`); }
  }
  log(`      PO documents partially received                     ${psA + psB}`);
  log(`        (a) the missing piece POSTDATES the receipt       ${psA}`);
  log(`        (b/c) the missing piece PREDATES the receipt      ${psB}`);
  show(psLines, "piece-set differences, adjudicated");

  // ══ G. THE SO/PO CONFLICTS, WITH AUTOCOUNT'S TEXT AS THE TIE-BREAK ══════
  log("");
  log("=== G. THE SO/PO VARIANT CONFLICTS — the owner's decision table");
  log("    No winner is chosen here. For each conflict: which side AutoCount's own Desc2 text");
  log("    agrees with, and whether the build is already DOWNSTREAM (a GRN received it or a DO");
  log("    shipped it), because a conflict on a line already built is a different problem.");
  const soByIdG = new Map(soAll.map((r) => [r.id, r]));
  const grnByPoLine = new Map();
  for (const r of grPairs) { if (!grnByPoLine.has(r.i.id)) grnByPoLine.set(r.i.id, []); grnByPoLine.get(r.i.id).push(r.grn_doc); }
  const doBySoLine = new Map();
  for (const d of await sql`SELECT di.so_item_id::text AS so_item_id, dh.do_number AS doc
                              FROM scm.delivery_order_items di
                              JOIN scm.delivery_orders dh ON dh.id = di.delivery_order_id
                             WHERE dh.company_id = ${CO} AND di.so_item_id IS NOT NULL`) {
    if (!doBySoLine.has(d.so_item_id)) doBySoLine.set(d.so_item_id, []);
    doBySoLine.get(d.so_item_id).push(d.doc);
  }
  /* Does the AutoCount text on a document actually contain the value that
     document's structured field claims? A fabric code appears verbatim in
     Desc2 ("COL:PC151-12"); a gap appears as a number near "gap"/inch marks, so
     the digits are tested rather than the formatted string. */
  const squash = (s) => norm(s).replace(/[^A-Z0-9]/g, "");
  const textSays = (d2, val) => {
    if (!d2 || val === null) return null;
    const t = norm(d2), v = norm(val);
    if (t.includes(v)) return true;
    /* AutoCount writes the same fabric a dozen ways — "PC-151-02", "PC151-02",
       "pc151 02". Comparing the letters and digits alone is the only test that
       survives that, and it is why the first pass called HC-SO-011886
       "ambiguous" when its text plainly names the PO's colour. */
    if (squash(t).includes(squash(v))) return true;
    const digits = v.replace(/[^0-9.]/g, "");
    if (digits && new RegExp(`(^|[^0-9])${digits.replace(".", "\\.")}([^0-9]|$)`).test(t)) return true;
    return false;
  };
  const rows14 = [];
  for (const p of poRows) {
    if (!p.so_item_id) continue;
    const s = soByIdG.get(p.so_item_id);
    if (!s) continue;
    for (const k of AXES) {
      const a = vget(s.variants, k), b = vget(p.variants, k);
      if (a === null || b === null || norm(a) === norm(b)) continue;
      const grns = grnByPoLine.get(p.id) ?? [];
      const dos = doBySoLine.get(s.id) ?? [];
      const soText = textSays(s.d2, a), soTextPo = textSays(s.d2, b);
      const poText = textSays(p.d2, b), poTextSo = textSays(p.d2, a);
      /* "The text agrees with X" only means something when it names X and does
         NOT also name the other side. Anything else is reported as silent. */
      const verdict = (says, saysOther, side) => (says && !saysOther ? side : (!says && saysOther ? (side === "SO" ? "PO" : "SO") : "silent/ambiguous"));
      rows14.push({
        so: s.doc, po: p.doc, model: `${modelOf(s.code)} ${compOf(s.code) || norm(s.code)}`.trim(), grp: s.grp,
        axis: k, soVal: a, poVal: b,
        downstream: grns.length || dos.length ? `YES — ${[...grns.map((x) => `GRN ${x}`), ...dos.map((x) => `DO ${x}`)].join(", ")}` : "no",
        soD2: String(s.d2 ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
        poD2: String(p.d2 ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
        soD2Says: verdict(soText, soTextPo, "SO"), poD2Says: verdict(poText, poTextSo, "PO"),
      });
    }
  }
  log(`    conflicting (SO value, PO value) axis pairs: ${rows14.length}`);
  log("");
  log("    SO doc | PO doc | group model piece | axis | SO says | PO says | already downstream | SO's own Desc2 backs | PO's own Desc2 backs");
  for (const r of rows14) {
    log(`      ${r.so} | ${r.po} | ${r.grp} ${r.model} | ${r.axis} | ${r.soVal} | ${r.poVal} | ${r.downstream} | ${r.soD2Says} | ${r.poD2Says}`);
    log(`         SO Desc2: ${r.soD2 || "(empty)"}`);
    log(`         PO Desc2: ${r.poD2 || "(empty)"}`);
  }
  if (!rows14.length) log("      0 rows — no linked pair states two different values on one axis.");

  // ══ H. THE CANCELLATION SURFACE ═════════════════════════════════════════
  log("");
  log("=== H. WHAT CAN ACTUALLY BE CANCELLED — asked of information_schema, not assumed");
  log('    "不可以删只可以 cancel" needs a column to cancel INTO, and the four line tables are');
  log("    NOT symmetrical. A repair script that assumes they are dies at 42703 mid-run.");
  const TABLES = ["mfg_sales_order_items", "purchase_order_items", "grn_items", "delivery_order_items"];
  const cols = await sql`
    SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ANY(${TABLES})
     ORDER BY table_name, ordinal_position`;
  const WANT = ["cancelled", "cancelled_at", "cancel_reason", "created_at", "updated_at", "remark", "notes", "line_no", "description2", "item_group", "variants"];
  for (const t of TABLES) {
    const mine = cols.filter((c) => c.table_name === t);
    if (!mine.length) { log(`    scm.${t}: TABLE NOT FOUND`); continue; }
    const have = WANT.filter((w) => mine.some((c) => c.column_name === w));
    const missing = WANT.filter((w) => !have.includes(w));
    const canc = mine.find((c) => c.column_name === "cancelled");
    log(`    scm.${t}  (${mine.length} columns)`);
    log(`      has: ${have.join(", ") || "(none of the columns this repair needs)"}`);
    log(`      LACKS: ${missing.join(", ") || "(nothing)"}`);
    log(`      cancellable in place: ${canc ? `YES — cancelled ${canc.data_type}, nullable=${canc.is_nullable}, default ${canc.column_default ?? "(none)"}` : "NO — there is no cancelled column on this table"}`);
  }

  log("");
  log("READ-ONLY: nothing above was written. Every proposal is a proposal.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
