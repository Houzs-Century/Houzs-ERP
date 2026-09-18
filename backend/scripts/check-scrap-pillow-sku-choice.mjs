#!/usr/bin/env node
// ---------------------------------------------------------------------------
// READ-ONLY. Is the scrap pillow on the RIGHT SKU?
//
// THE OWNER'S RULE, 2026-09-10, verbatim:
//
//   "并且你要确保我的 scrap pillow 是选对的:
//      1. 有颜色的是选 custom scrap pillow
//      2. 没有颜色是选 random
//    另外,你之前查回去一下我的 AutoCount 记录,之前 SKU 我不确定你有没有选对,可能
//    你选错了。如果 proceed 了这个单呢,custom SKU below 一定会写有颜色的;还没有
//    proceed 的呢,那可能就没有"
//
// Three claims, and they are NOT the same claim:
//   1. a pillow line that HAS a colour must sit on the CUSTOM SKU;
//   2. a pillow line with NO colour must sit on the RANDOM SKU;
//   3. the colour is only REQUIRED once the order is PROCEEDED. An order with
//      no Processing Date may legitimately carry no colour — the owner's
//      standing rule of 2026-09-04 (「还没proceed还没确认的就可以直接放空的」).
//      So a CUSTOM line with no colour is a DEFECT only on a proceeded order,
//      and this script counts the two populations APART. Reporting the wider
//      number as the backlog is the mistake that rule exists to stop.
//
// ── WHY IT MUST BE MEASURED AGAINST THE BOOK, NOT AGAINST OURSELVES ────────
// "可能你选错了" is a suspicion about the MIGRATION. A mismatch measured only
// inside the ERP cannot tell a migration error from a salesperson leaving a
// field blank last week — the two need opposite remedies. So every mismatch is
// printed BESIDE AutoCount's own words for that line, out of the committed
// cutover snapshots, and the verdict says which side is wrong.
//
// ── THE FACT THAT SHAPES THE WHOLE READING, established BEFORE any query ───
// AutoCount does not HAVE a CUSTOM/RANDOM SKU split. Measured on the committed
// snapshots rather than assumed:
//
//   · scripts/data/align-skus-houzs-century.json (AutoCount item export,
//     2026-08-05, 1,242 rows): ZERO item CODES contain "(CUSTOM)" or
//     "(RANDOM)". Three item NAMES contain "(CUSTOM)" —
//     AMN-SQUARE PILLOW -> `AMN-SQUARE PILLOW (16"x16") (CUSTOM)`,
//     DSL-SQUARE PILLOW, HOK-SQUARE PILLOW. NO name contains "RANDOM".
//   · scripts/data/ac-live-item-master.json.gz (AutoCount live, 2026-09-09,
//     1,591 items): 32 codes mention PILLOW; none says CUSTOM or RANDOM.
//   · scripts/data/ac-fidelity-so-lines.json.gz (60,939 book SO lines,
//     2026-08-11): the book states "custom vs random" in the LINE TEXT —
//     `[ COL: HUGYP 3383-6 ]`, `Col: J9883-10-MOGANO` on one side and
//     `COLOUR: RANDOM`, `random colour`, `col: random` on the other.
//
// So the book carries ONE code per supplier and puts the distinction in Desc2.
// Whatever CUSTOM/RANDOM split the ERP has was minted on THIS side, and the
// choice was therefore made per line by reading that text — which is exactly
// where "可能你选错了" would bite. Section 1 is what establishes whether the
// split exists in scm.mfg_products at all: if there is no RANDOM family, rule 2
// has nothing to point at and that is the finding, not a count of violations.
//
// ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
// SELECTs only. No DDL, no writes, no transaction, and deliberately no APPLY.
// It does not propose or perform a re-code: changing a live line's item code
// moves stock and can move money, so that is the owner's decision and a
// separate, gated script.
//
// Exits 0 for every legitimate answer INCLUDING "no rows" — the ANSWER is the
// output, and a red job reads as "the check broke". Non-zero is reserved for an
// unreachable database or a missing snapshot.
//
// RE-RUN: read-only and stateless. A second run reports whatever is true then.
//
//   DATABASE_URL   required
//   COMPANY        default 1 (Houzs Century). A 2990-* document is out of
//                  scope by the owner's ruling of 2026-09-09 and is excluded
//                  by the company predicate, not by a doc_no filter.
//   SCRAP_RE       which products are the SCRAP pillows. Default matches
//                  SQUARE / LONG / SOFA / SCRAP pillow — the fabric ones. A
//                  latex or hotel pillow has no fabric colour to choose.
//   CAP            how many example rows per cell (default 20)
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { buildFabricColourIndex, isPendingColour, stripPendingMarker } from "./lib/fabric-colour-match.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

/* The pure classifiers above main() are EXPORTED and main() only runs when this
   file is executed directly, so a harness can probe them against the 60,939 real
   book strings in the committed snapshot without opening a connection. Measuring
   a classifier on invented inputs is how a reader comes to disagree with the
   shape the data actually has. */
const RUN = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CO = Number(process.env.COMPANY ?? 1);
const CAP = Number(process.env.CAP ?? 20);
/* A pillow you can choose a FABRIC for. A latex / hotel / memory-foam pillow is
   a bought-in product with no colour axis, so including it would report a
   "missing colour" on a line that can never have one. */
const SCRAP_RE = new RegExp(process.env.SCRAP_RE ?? "(SQUARE|LONG|SOFA|SCRAP)\\s*PILLOW", "i");
const PILLOW_RE = /PILLOW/i;

const log = (m = "") => console.log(m);
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
const up = (s) => txt(s).toUpperCase();

/* ── FAMILY ────────────────────────────────────────────────────────────────
   Read off the product's CODE **and** NAME, because AutoCount puts the marker
   in the NAME ("AMN-SQUARE PILLOW (16\"x16\") (CUSTOM)") and a code-only reader
   would classify every one of them as NEITHER and report a fault that is only
   its own blindness. A row claiming BOTH words is its own finding. */
export const familyOf = (code, name) => {
  const t = `${up(code)} ${up(name)}`;
  const custom = /\bCUSTOM(?:IS|IZ)?E?D?\b/.test(t);
  const random = /\bRANDOM\b/.test(t);
  if (custom && random) return "BOTH";
  if (custom) return "CUSTOM";
  if (random) return "RANDOM";
  return "NEITHER";
};

/* ── COLOUR STATEMENT IN FREE TEXT ─────────────────────────────────────────
   The book, and our own migrated copy of it, state the colour in prose. Four
   outcomes, and they are four different facts:

     COLOUR   a fabric colour is named (the library confirms it, or a "Col:"
              marker names something that is neither random nor pending)
     RANDOM   the text SAYS random — "COLOUR: RANDOM", "col: random",
              "randome colour", "{random col}", "（RANDOM COLOUR）"
     PENDING  TBC / KIV — chosen later, which is not the same as never
     NONE     the text says nothing about colour at all

   RANDOM is tested BEFORE the library lookup for a reason: colourForms pulls a
   code out of prose, so a line reading "random colour (FREE GIVE)" must not be
   allowed to resolve some fragment into a real fabric. A text that says random
   AND names a resolvable code is reported as CONFLICT rather than picked
   between — deciding it is the owner's, not a matcher's. */
/* Spellings MEASURED on the 727 scrap-pillow lines in the committed book
   snapshot, not imagined: `randome colour`, `rondom`, `Col:random`,
   `（RANDOM COLOUR）`, `{random col}`. The typos are in the list because they
   are in the data. */
const RANDOM_RE = /\bR[AO]ND[AO]ME?\b|\bRAMDOM\b|\bRDM\b|\bRANDOMLY\b/i;
/* The separator after "Col" is whatever the salesperson typed. The same
   snapshot holds `Col: J9883-10-MOGANO`, `Col -02 Beige#`,
   `col - JF236-4 dark linen`, `Col AM275-2`, `Col：GD8371-02#Beige` (a
   FULL-WIDTH colon) and `16x16/col: TBC`. Accepting only ":" reads five of
   those as "no colour stated", which lands them in the owner's defect column. */
const COL_MARKER = /\bCOL(?:OU?R)?[\s:.=\u2013\u2014\uff1a-]+(\S.*)$/im;

export function classifyText(raw, explainColour) {
  const t = txt(raw);
  if (!t) return { kind: "NONE", detail: "" };
  const saysRandom = RANDOM_RE.test(t);
  const marker = COL_MARKER.exec(t);
  const after = marker ? txt(marker[1]).replace(/[\]}）)]+\s*$/, "").trim() : "";

  /* Ask the library about the marker's payload first (the most faithful
     spelling available) and only then about the whole string. assumedSeries is
     REFUSED here: a bare number that the matcher decided is a PC colour is the
     matcher's guess, not a colour this document named. */
  const resolve = (s) => {
    const e = s ? explainColour(s) : null;
    return e && !e.assumedSeries ? e : null;
  };
  const hit = resolve(after && !RANDOM_RE.test(after) ? after : "") || (saysRandom ? null : resolve(t));

  if (saysRandom && hit) {
    return { kind: "CONFLICT", detail: `text says random AND resolves ${hit.row.colour_id}` };
  }
  if (saysRandom) return { kind: "RANDOM", detail: t.slice(0, 120) };
  if (hit) return { kind: "COLOUR", detail: `${hit.row.colour_id}${hit.via === "exact" ? "" : ` (via ${hit.via})`}` };
  if (isPendingColour(t) && !stripPendingMarker(after || t)) return { kind: "PENDING", detail: t.slice(0, 120) };
  if (after) {
    if (isPendingColour(after)) return { kind: "PENDING", detail: after.slice(0, 120) };
    /* A "Col:" marker naming something the library cannot look up is still the
       document naming a colour. It is a colour we cannot BIND, not an absent
       one, and calling it absent would put it in the owner's defect column. */
    return { kind: "COLOUR", detail: `${after.slice(0, 90)} [unresolved]` };
  }
  if (isPendingColour(t)) return { kind: "PENDING", detail: t.slice(0, 120) };
  return { kind: "NONE", detail: "" };
}

/* ── COLOUR ON THE ERP LINE ────────────────────────────────────────────────
   Two readings, kept apart on purpose. STRUCTURED is what a program can act on
   (the picker's own keys); TEXT is what a human wrote and what the migration
   copied out of the book. They disagree on real rows, and folding them into one
   boolean would hide exactly the disagreement this audit is looking for. */
const COLOUR_KEYS = ["fabricCode", "colorCode", "colourCode", "colourLabel", "fabricColor", "colourId"];

/* Same promotion for the BOOK\'s own text: "TAKEN" in a Desc2 is not the book
   saying "no colour", it is the book talking about something else. */
export function bookKind(raw, explainColour) {
  const c = classifyText(raw, explainColour);
  if (c.kind === "NONE" && txt(raw)) return { kind: "UNCLEAR", detail: txt(raw).slice(0, 120) };
  return c;
}

export function structuredColour(variants) {
  const v = variants && typeof variants === "object" ? variants : {};
  for (const k of COLOUR_KEYS) {
    const val = txt(v[k]);
    if (!val) continue;
    if (isPendingColour(val) && !stripPendingMarker(val)) return { kind: "PENDING", via: `variants.${k}`, detail: val };
    return { kind: "COLOUR", via: `variants.${k}`, detail: val };
  }
  /* A SERIES with no colour is the KIV state (variant-summary.isColourKiv):
     committed to a fabric, colour to come. Not a colour, and not nothing. */
  const series = txt(v.fabricId) || txt(v.fabricLabel);
  if (series) return { kind: "PENDING", via: "variants.fabricId (COLOUR KIV)", detail: series };
  return { kind: "NONE", via: "", detail: "" };
}

/* THREE carriers, in order of trustworthiness: extraAddonNote is the field the
   owner asked for TODAY and is typed on purpose; description2 is the book's own
   copy on a migrated line; remark carries the 账本原文 label the 2026-09-02
   preservation wrote.

   `description` is DELIBERATELY NOT HERE. On these lines it is the item NAME —
   "SQUARE PILLOW", "SOFA PILLOW (FREE GIFT)" — so it is non-empty on virtually
   every row while saying nothing about colour. Including it would make the
   "somebody wrote something, but it is not a colour" bucket below fire on every
   line and mean nothing. */
const TEXT_CARRIERS = [
  ["variants.extraAddonNote", (r) => txt((r.variants || {}).extraAddonNote)],
  ["description2", (r) => txt(r.description2)],
  ["remark", (r) => txt(r.remark)],
];

function loadSnapshot(file, pick) {
  try {
    const raw = gunzipSync(readFileSync(path.join(HERE, "data", file))).toString("utf8");
    return pick(JSON.parse(raw));
  } catch (e) {
    console.error(`FATAL: cannot read backend/scripts/data/${file} — ${e.message}`);
    console.error("The book half of this audit cannot run without it. Refusing to report a one-sided answer.");
    process.exit(2);
  }
}

async function main() {
  const DSN = process.env.DATABASE_URL;
  if (!DSN) { console.error("DATABASE_URL is not set. Aborting."); process.exit(1); }
  sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  note(`READ-ONLY scrap-pillow SKU audit — company ${CO}`);
  log(`population regex: ${SCRAP_RE}   (override with SCRAP_RE)`);
  log("");

  /* The book, keyed by DtlKey. ac-fidelity-so-lines carries the book's own
     ItemCode AND Desc2 per line; ac-line-desc2 is the same export's Desc2 and
     recovers a key the fidelity pull missed. Both are 2026-08-11. */
  const bookLines = loadSnapshot("ac-fidelity-so-lines.json.gz", (j) => j);
  const bookByKey = new Map(bookLines.map((r) => [Number(r.DtlKey), r]));
  const d2 = loadSnapshot("ac-line-desc2.json.gz", (j) => j);
  const d2ByKey = new Map((d2.so ?? []).map((r) => [Number(r.k), txt(r.d2)]));
  log(`book snapshots: ${bookByKey.size} SO lines (ac-fidelity-so-lines) + ${d2ByKey.size} Desc2 keys (ac-line-desc2, ${d2.exportedAt})`);
  log("");

  const fcRows = await sql`SELECT fabric_id, colour_id, label, active FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { explainColour } = buildFabricColourIndex(fcRows);
  log(`fabric library: ${fcRows.length} colours for company ${CO}`);
  log("");

  // ── 1. WHAT THE SKUs ACTUALLY ARE ────────────────────────────────────────
  note("=== 1. THE PILLOW SKU CENSUS (scm.mfg_products) ===");
  const prods = await sql`
    SELECT code, name, category, status
      FROM scm.mfg_products
     WHERE company_id = ${CO}
       AND (code ILIKE '%PILLOW%' OR name ILIKE '%PILLOW%'
            OR code ILIKE '%SCRAP%' OR name ILIKE '%SCRAP%')
     ORDER BY code`;
  log(`products whose code or name mentions PILLOW / SCRAP: ${prods.length}`);
  const scrap = prods.filter((p) => SCRAP_RE.test(`${p.code} ${p.name ?? ""}`));
  const famOf = new Map();
  for (const p of prods) famOf.set(up(p.code), familyOf(p.code, p.name));
  const famCount = { CUSTOM: 0, RANDOM: 0, BOTH: 0, NEITHER: 0 };
  for (const p of scrap) famCount[familyOf(p.code, p.name)] += 1;

  log("");
  log(`  of those, in the SCRAP (fabric) population: ${scrap.length}`);
  log(`    CUSTOM family  : ${famCount.CUSTOM}`);
  log(`    RANDOM family  : ${famCount.RANDOM}`);
  log(`    says BOTH words: ${famCount.BOTH}`);
  log(`    NEITHER word   : ${famCount.NEITHER}`);
  log("");
  log("  every scrap-pillow product, with the family its NAME puts it in:");
  for (const p of scrap) {
    log(`    [${familyOf(p.code, p.name).padEnd(7)}] ${String(p.code).padEnd(28)} ${p.name ?? ""}   (${p.category ?? "no category"} / ${p.status ?? "no status"})`);
  }
  if (prods.length > scrap.length) {
    log("");
    log(`  the other ${prods.length - scrap.length} pillow products are OUT of the audited population`);
    log("  (bought-in latex / hotel / memory-foam pillows have no fabric colour to choose):");
    for (const p of prods.filter((x) => !SCRAP_RE.test(`${x.code} ${x.name ?? ""}`)).slice(0, CAP)) {
      log(`    ${String(p.code).padEnd(32)} ${p.name ?? ""}`);
    }
  }
  log("");
  if (famCount.RANDOM === 0) {
    note("FINDING: there is NO RANDOM scrap-pillow SKU in this company at all.");
    note("Rule 2 (\"没有颜色是选 random\") has nothing to point at — a line cannot be");
    note("moved onto a family that does not exist. Everything below therefore reports");
    note("rule 1 (colour -> CUSTOM) as a rule, and rule 2 as a MISSING SKU, not as a");
    note("count of violations.");
    log("");
  }

  // ── 2. WHERE THE COLOUR ACTUALLY LIVES ───────────────────────────────────
  const PDATE = soProcessingDateFragment(sql);
  const rows = await sql`
    SELECT i.id, i.doc_no, i.line_no, i.item_code, i.item_group, i.description,
           i.description2, i.remark, i.variants, i.qty, i.cancelled,
           i.linked_ac_dtlkey,
           h.status AS so_status, h.linked_ac_docno,
           (h.${PDATE} IS NOT NULL) AS proceeded, h.${PDATE} AS processing_date
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO}
       AND (i.item_code ILIKE '%PILLOW%' OR i.description ILIKE '%PILLOW%')
     ORDER BY i.doc_no, i.line_no`;
  const lines = rows.filter((r) => SCRAP_RE.test(`${r.item_code ?? ""} ${r.description ?? ""}`));

  note("=== 2. WHERE THE COLOUR LIVES ON A SCRAP-PILLOW LINE ===");
  log(`sales-order lines mentioning PILLOW in company ${CO}: ${rows.length}`);
  log(`  of those, SCRAP pillows (the audited population): ${lines.length}`);
  log(`  across ${new Set(lines.map((r) => r.doc_no)).size} sales orders`);
  log(`  cancelled lines inside that: ${lines.filter((r) => r.cancelled).length}`);
  log(`  on a PROCEEDED order (Processing Date set): ${lines.filter((r) => r.proceeded).length}`);
  log(`  migrated from AutoCount (header carries linked_ac_docno): ${lines.filter((r) => r.linked_ac_docno).length}`);
  log("");

  if (lines.length === 0) {
    note("No scrap-pillow sales-order line exists in this company. That is the answer,");
    note("not a failure — nothing below can be measured and nothing is wrong.");
    await sql.end({ timeout: 5 });
    return;
  }

  const keyCount = new Map();
  for (const r of lines) {
    const v = r.variants && typeof r.variants === "object" ? r.variants : {};
    for (const [k, val] of Object.entries(v)) {
      if (txt(val) === "" && !(val && typeof val === "object")) continue;
      keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
    }
  }
  log("  every key actually present in `variants` on these lines, with counts:");
  if (keyCount.size === 0) log("    (none — every one of these lines has an empty variants bag)");
  for (const [k, n] of [...keyCount].sort((a, b) => b[1] - a[1])) {
    log(`    ${String(n).padStart(5)}  variants.${k}${COLOUR_KEYS.includes(k) ? "   <- a colour key" : ""}`);
  }
  log("");
  log("  each candidate carrier, and what it says when it is not empty:");
  const carrierRows = [["variants (structured colour keys)", null], ...TEXT_CARRIERS];
  for (const [label, get] of carrierRows) {
    let filled = 0; const kinds = new Map();
    for (const r of lines) {
      const c = get ? classifyText(get(r), explainColour) : structuredColour(r.variants);
      if (get && !txt(get(r))) continue;
      if (!get && c.kind === "NONE") continue;
      filled += 1;
      kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
    }
    const breakdown = [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" ");
    log(`    ${String(filled).padStart(5)} / ${lines.length}  ${label.padEnd(34)} ${breakdown || "-"}`);
  }
  log("");

  /* THE RESIDUE, printed in full rather than counted. These are lines where a
     person wrote something and the classifier cannot read a colour out of it.
     Whether each one really means "no colour" is a READING, and the reader needs
     the strings to make it — a bare count here would be an assertion dressed as
     a measurement. */
  const residue = new Map();
  for (const r of lines) {
    for (const [, get] of TEXT_CARRIERS) {
      const raw = txt(get(r));
      if (!raw) continue;
      if (classifyText(raw, explainColour).kind === "NONE") residue.set(raw, (residue.get(raw) ?? 0) + 1);
      break;
    }
  }
  log(`  text present but saying nothing this can read as a colour: ${[...residue.values()].reduce((a, b) => a + b, 0)} line(s), ${residue.size} distinct`);
  for (const [k, n] of [...residue].sort((a, b) => b[1] - a[1]).slice(0, CAP * 2)) {
    log(`    ${String(n).padStart(4)}  ${JSON.stringify(k).slice(0, 160)}`);
  }
  log("");

  // ── 3. THE CROSS-TAB ─────────────────────────────────────────────────────
  const judged = lines.map((r) => {
    const fam = famOf.get(up(r.item_code)) ?? familyOf(r.item_code, r.description);
    const struct = structuredColour(r.variants);
    /* UNCLEAR is its own answer and must not be folded into "no colour":
       somebody wrote "TAKEN" or "compensate" on the line, which is text that
       says nothing about colour. Calling that BLANK overstates what we know,
       and it is the owner\'s defect column that would carry the overstatement.
       Both are reported, and reported apart. */
    let text = { kind: "NONE", detail: "", via: "" };
    let sawText = false;
    for (const [via, get] of TEXT_CARRIERS) {
      const raw = get(r);
      if (!txt(raw)) continue;
      sawText = true;
      const c = classifyText(raw, explainColour);
      if (c.kind !== "NONE") { text = { ...c, via }; break; }
    }
    if (text.kind === "NONE" && sawText) {
      const first = TEXT_CARRIERS.map(([, g]) => txt(g(r))).find(Boolean) ?? "";
      text = { kind: "UNCLEAR", detail: first.slice(0, 120), via: "text present, no colour statement" };
    }
    /* The structured pick WINS when it names a colour: it is the field the
       factory and the purchase order read. Where it is silent the text is the
       only statement there is. Both are carried so the disagreement is
       countable rather than swallowed. */
    const erp = struct.kind === "COLOUR" ? struct : (text.kind !== "NONE" ? text : struct);
    const bk = bookByKey.get(Number(r.linked_ac_dtlkey));
    const bookText = txt(bk?.Desc2) || d2ByKey.get(Number(r.linked_ac_dtlkey)) || "";
    const book = r.linked_ac_dtlkey == null
      ? { kind: "NO-KEY", detail: "" }
      : (bk || bookText ? bookKind(bookText, explainColour) : { kind: "NOT-IN-SNAPSHOT", detail: "" });
    return { r, fam, struct, text, erp, book, bookRow: bk, bookText };
  });

  note("=== 3. THE CROSS-TAB: family x colour x proceeded ===");
  log("colour verdict = the structured pick where there is one, else the line's own text");
  log("");
  const cell = new Map();
  for (const j of judged) {
    const k = `${j.fam}|${j.erp.kind}|${j.r.proceeded ? "PROCEEDED" : "not proceeded"}`;
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(j);
  }
  log(`  ${"family".padEnd(9)} ${"colour".padEnd(10)} ${"proceeded".padEnd(15)} lines`);
  for (const [k, v] of [...cell].sort()) {
    const [f, c, p] = k.split("|");
    log(`  ${f.padEnd(9)} ${c.padEnd(10)} ${p.padEnd(15)} ${String(v.length).padStart(5)}`);
  }
  log("");

  const at = (f, kinds, proceeded) => judged.filter((j) =>
    j.fam === f && kinds.includes(j.erp.kind) && (proceeded === null || j.r.proceeded === proceeded));

  const BLANK = ["NONE", "UNCLEAR"];
  const customNoColourProceeded = at("CUSTOM", BLANK, true);
  const customNoColourOpen = at("CUSTOM", BLANK, false);
  const randomWithColour = at("RANDOM", ["COLOUR", "CONFLICT"], null);
  const neither = judged.filter((j) => j.fam === "NEITHER" || j.fam === "BOTH");
  const customPending = at("CUSTOM", ["PENDING"], true);
  const customSaysRandom = at("CUSTOM", ["RANDOM"], null);

  note("--- the four numbers that decide what to do ---");
  const splitBlank = (set) => `${set.filter((j) => j.erp.kind === "NONE").length} with nothing written at all + ${set.filter((j) => j.erp.kind === "UNCLEAR").length} where something is written but it is not a colour`;
  note(`  A. CUSTOM SKU, NO colour, order PROCEEDED   : ${customNoColourProceeded.length}   <- the owner's hard defect`);
  note(`       of which: ${splitBlank(customNoColourProceeded)}`);
  note(`  B. RANDOM SKU but a colour IS stated        : ${randomWithColour.length}   <- wrong SKU the other way`);
  note(`  C. CUSTOM SKU, NO colour, NOT proceeded     : ${customNoColourOpen.length}   <- LEGITIMATE (owner rule 2026-09-04), not work`);
  note(`       of which: ${splitBlank(customNoColourOpen)}`);
  note(`  D. on NEITHER family (nor BOTH)             : ${neither.length}   <- outside the two SKUs entirely`);
  log("");
  log(`  also worth naming, because they are not any of the four:`);
  log(`  E. CUSTOM SKU, colour TBC/KIV, proceeded    : ${customPending.length}   (chosen later, gated by the Processing Date rule)`);
  log(`  F. CUSTOM SKU whose own text SAYS "random"  : ${customSaysRandom.length}   (the text and the SKU disagree)`);
  log("");

  // ── 4. AGAINST AUTOCOUNT ─────────────────────────────────────────────────
  note("=== 4. AGAINST AUTOCOUNT'S OWN LINE TEXT ===");
  log("Which side is wrong. Read the book's verdict, then ours.");
  log("");
  /* The book's OWN population first, as a denominator. Computed off the
     committed snapshot with no query, so it is the same number every run and it
     says how many scrap pillows AutoCount ever had an opinion about. */
  const bookScrap = bookLines.filter((b) => SCRAP_RE.test(`${b.ItemCode ?? ""} ${b.Description ?? ""}`));
  const bookOwn = new Map();
  for (const b of bookScrap) {
    const k = bookKind(b.Desc2, explainColour).kind;
    bookOwn.set(k, (bookOwn.get(k) ?? 0) + 1);
  }
  log(`  AutoCount's own scrap-pillow SO lines in the 2026-08-11 snapshot: ${bookScrap.length}`);
  for (const [k, n] of [...bookOwn].sort((a, b) => b[1] - a[1])) log(`    ${String(n).padStart(5)}  the book says ${k}`);
  log("");
  const bookTally = new Map();
  for (const j of judged) {
    const k = `${j.book.kind} -> ERP ${j.erp.kind} on ${j.fam}`;
    bookTally.set(k, (bookTally.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...bookTally].sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(5)}  book says ${k}`);
  log("");

  /* THE MIGRATION VERDICT. Only a line the book actually speaks about can
     convict the migration; everything else is named as unknowable rather than
     folded into a total that would look like evidence. */
  const bookNamedWeRandom = judged.filter((j) => j.book.kind === "COLOUR" && j.fam === "RANDOM");
  const bookRandomWeCustom = judged.filter((j) => j.book.kind === "RANDOM" && j.fam === "CUSTOM");
  const bookNamedWeBlank = judged.filter((j) => j.book.kind === "COLOUR" && BLANK.includes(j.erp.kind));
  const bookRandomWeColour = judged.filter((j) => j.book.kind === "RANDOM" && j.erp.kind === "COLOUR");
  const bookSilent = judged.filter((j) => j.book.kind === "NONE");
  const noBook = judged.filter((j) => j.book.kind === "NO-KEY" || j.book.kind === "NOT-IN-SNAPSHOT");

  note("--- what the book convicts ---");
  note(`  book NAMES a colour, we sit on the RANDOM SKU : ${bookNamedWeRandom.length}`);
  note(`  book says RANDOM, we sit on the CUSTOM SKU    : ${bookRandomWeCustom.length}`);
  note(`  book NAMES a colour, our line carries NONE    : ${bookNamedWeBlank.length}   <- the migration dropped a colour it had`);
  note(`  book says RANDOM, our line carries a COLOUR   : ${bookRandomWeColour.length}   <- we added one the book never gave`);
  log("");
  log(`  book is SILENT about colour on this line      : ${bookSilent.length}   <- the book cannot settle these`);
  log(`  no book line at all (ERP-native or unlinked)  : ${noBook.length}   <- not a migration question`);
  log("");

  // ── 5. REAL ROWS ─────────────────────────────────────────────────────────
  note("=== 5. REAL EXAMPLE ROWS ===");
  const show = (title, set) => {
    log("");
    log(`--- ${title} — ${set.length} line(s), showing up to ${CAP} ---`);
    if (set.length === 0) { log("    (none)"); return; }
    for (const j of set.slice(0, CAP)) {
      const r = j.r;
      log(`  ${r.doc_no} line ${r.line_no}  [${j.fam}]  ${r.item_code}`);
      log(`      ERP  : ${j.erp.kind}${j.erp.detail ? ` "${j.erp.detail}"` : ""}${j.erp.via ? `  (from ${j.erp.via})` : ""}`);
      log(`      state: ${r.proceeded ? `PROCEEDED ${txt(r.processing_date)}` : "not proceeded"} / SO ${r.so_status}${r.cancelled ? " / LINE CANCELLED" : ""}`);
      log(`      book : ${j.book.kind}${j.book.detail ? ` "${j.book.detail}"` : ""}`
        + `${j.bookRow ? `  [${j.bookRow.DocNo} ${j.bookRow.ItemCode}]` : (r.linked_ac_dtlkey == null ? "  [no DtlKey]" : "  [DtlKey not in the 2026-08-11 snapshot]")}`);
      if (j.bookText) log(`      book Desc2 verbatim: ${JSON.stringify(j.bookText).slice(0, 200)}`);
    }
    if (set.length > CAP) log(`    ... ${set.length - CAP} more (raise CAP to see them)`);
  };

  show("A. CUSTOM SKU, no colour, PROCEEDED (the hard defect)", customNoColourProceeded);
  show("B. RANDOM SKU but a colour is stated", randomWithColour);
  show("F. CUSTOM SKU whose own text says random", customSaysRandom);
  show("book NAMES a colour, our line carries none", bookNamedWeBlank);
  show("book says RANDOM, our line carries a colour", bookRandomWeColour);
  show("C. CUSTOM SKU, no colour, NOT proceeded (legitimate — for contrast only)", customNoColourOpen);

  // ── 6. THE SUPPLIER SIDE, AS CONTEXT ─────────────────────────────────────
  note("=== 6. THE PURCHASE-ORDER SIDE (context) ===");
  log("The supplier's document is the reason the owner asked. Same population, PO side.");
  const poRows = await sql`
    SELECT p.po_number, i.item_code, i.material_name, i.description, i.description2,
           i.variants, i.notes AS remark, p.status AS po_status
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO}
       AND (i.item_code ILIKE '%PILLOW%' OR i.description ILIKE '%PILLOW%')
     ORDER BY p.po_number`;
  const poScrap = poRows.filter((r) => SCRAP_RE.test(`${r.item_code ?? ""} ${r.material_name ?? ""} ${r.description ?? ""}`));
  log(`  purchase-order lines mentioning PILLOW: ${poRows.length}; scrap pillows: ${poScrap.length}`);
  const poCell = new Map();
  for (const r of poScrap) {
    const fam = famOf.get(up(r.item_code)) ?? familyOf(r.item_code, `${r.material_name ?? ""} ${r.description ?? ""}`);
    const s = structuredColour(r.variants);
    let t = { kind: "NONE" };
    for (const [, get] of TEXT_CARRIERS) { const c = classifyText(get(r), explainColour); if (c.kind !== "NONE") { t = c; break; } }
    const k = `${fam}|${s.kind === "COLOUR" ? s.kind : t.kind}`;
    poCell.set(k, (poCell.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...poCell].sort()) log(`    ${String(n).padStart(5)}  ${k.replace("|", " / ")}`);
  log("");
  note("Done. Nothing was written. No item code was changed — moving a line onto a");
  note("different SKU moves stock and can move money, and that is the owner's call.");

  await sql.end({ timeout: 5 });
}

let sql;
if (RUN) {
  main().catch(async (e) => {
    console.error(`::error::${e.message}`);
    try { await sql?.end({ timeout: 5 }); } catch { /* already closed */ }
    process.exit(1);
  });
}
