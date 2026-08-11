// Compile the real AutoCount sofa Desc2 corpus into a module the test suite can
// import.
//
// WHY A GENERATED FIXTURE AND NOT A DIRECT READ. The backend suite runs in
// workerd, where `fs` throws "not yet implemented in Workers", and the corpus
// lives in gzipped exports (backend/scripts/data/ac-*.json.gz) that Vite's
// `?raw` would hand back as mojibake. So the corpus is compiled to a TS module,
// exactly like autocount-item-map.ts, with a --check guard so a refreshed export
// cannot silently leave the tests running on last month's data.
//
// WHAT IT CARRIES IS INPUT ONLY. Every record is what AutoCount actually holds:
// the document, the ItemCode, the Desc2 text, and the ERP model that the cutover
// importer would derive from it. No expected output is baked in — the test runs
// the REAL decoder and the REAL collapse over this text, so the fixture cannot
// encode a bug as an expectation.
//
//   node scripts/gen-sofa-desc2-corpus.mjs           # write
//   node scripts/gen-sofa-desc2-corpus.mjs --check   # fail if stale (CI)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const OUT = path.join(here, "..", "src", "services", "autocount-sofa-corpus.ts");

/** The three committed exports that carry AutoCount document LINES with Desc2. */
const SOURCES = [
  ["ac-outstanding-so.json.gz", "SO"],
  ["ac-outstanding-po.json.gz", "PO"],
  ["ac-so-linked-pos.json.gz", "PO"],
];

const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, f))).toString("utf8"));

// ── the cutover item map: AutoCount ItemCode -> ERP code + category ──────────
const csv = fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8").trim().split(/\r?\n/);
const head = csv[0].split(",").map((s) => s.trim());
const want = ["ac_code", "erp_code", "status", "category", "supplier"];
if (want.some((c, i) => head[i] !== c)) throw new Error(`unexpected CSV header: ${csv[0]}`);
const acToErp = new Map();
for (const line of csv.slice(1)) {
  if (!line.trim()) continue;
  const p = line.split(",");
  if (p.length !== 5) throw new Error(`row is not 5 fields, refusing to guess: ${line}`);
  const [ac, erp, , category] = p.map((s) => s.trim());
  acToErp.set(ac.toUpperCase(), { erp, category });
}

/* The importer's recliner probe asks whether the MODEL has recliner
   compartments at all — the owner's rule that "R" means recliner only on a款
   that has one.
   TRAP, measured 2026-08-11: minted-sofa-skus-2026-08.json is NOT the ERP's
   sofa SKU catalogue, it is the DELTA minted in that one batch — it contains
   ZERO 9028-* compartments, and 9028 is one of the busiest models in the book.
   Using it as the importer's codeSet collapses this corpus from 543 usable
   builds to 43 and makes the suite look green while testing almost nothing. The
   real catalogue lives in scm.products, which a test cannot reach, so the probe
   is derived from the corpus itself: a model is recliner-capable when some
   document for it actually decodes to a recliner or power compartment. */
const RECL_PIECES = /^(1S\(R\)|1S\(P\)|1A\(R\)|1A\(P\))/i;

const raw = [];
const seen = new Set();
for (const [file, side] of SOURCES) {
  for (const l of gz(file)) {
    const ac = String(l.ItemCode ?? "").trim();
    if (!ac) continue;
    const hit = acToErp.get(ac.toUpperCase());
    if (!hit || hit.category.toUpperCase() !== "SOFA") continue;

    let model = hit.erp.replace(/-1S$/i, "");
    model = SOFA_MODEL_ALIAS[model] || model;

    const desc2 = l.Desc2 == null ? "" : String(l.Desc2);
    /* One physical AutoCount line can appear in more than one export (a linked
       PO is in both the PO exports). Key on the line, not the text: two
       different lines with identical text are two real observations. */
    const key = `${side}|${l.DocNo}|${l.DtlKey ?? ""}|${ac}|${desc2}`;
    if (seen.has(key)) continue;
    seen.add(key);

    raw.push({
      side,
      docNo: String(l.DocNo ?? ""),
      dtlKey: l.DtlKey == null ? null : Number(l.DtlKey),
      acItemCode: ac,
      erpCode: hit.erp,
      model,
      qty: Number(l.Qty ?? 0) || 0,
      creditorCode: l.CreditorCode ? String(l.CreditorCode) : null,
      desc2,
    });
  }
}

/* Pass 2: which models are recliner-capable. Read with the flag ON, which is the
   only setting under which a recliner token can decode at all, and keep the
   models where one actually did. Derived, not authoritative — see the note
   above — but deterministic and identical for every consumer of the fixture,
   which is what a round-trip test needs. */
const reclModels = new Set();
for (const r of raw) {
  if (!r.desc2.trim()) continue;
  if (parseSofa(r.desc2, r.model, true).pieces.some((p) => RECL_PIECES.test(p))) {
    reclModels.add(r.model.toUpperCase());
  }
}
const rows = raw.map((r) => ({ ...r, recl: reclModels.has(r.model.toUpperCase()) }));

rows.sort((a, b) => (a.side + a.docNo + String(a.dtlKey)).localeCompare(b.side + b.docNo + String(b.dtlKey)));

const text = `// GENERATED FILE — do not edit by hand.
// Source: backend/scripts/data/{ac-outstanding-so,ac-outstanding-po,ac-so-linked-pos}.json.gz
//         joined to autocount-erp-mapping-1561.csv (category = SOFA).
// Regenerate: node scripts/gen-sofa-desc2-corpus.mjs
// CI guard:   node scripts/gen-sofa-desc2-corpus.mjs --check
//
// Every record is REAL text out of the licensed AED_HOUZS account book: the
// document, the AutoCount ItemCode, the ERP code the cutover opened it as, the
// model and recliner flag the importer derives, and the Desc2 verbatim.
//
// INPUT ONLY. No expected pieces, no expected output — the tests run the real
// decoder and the real collapse over this text. A fixture that carried expected
// output could only ever prove that the code still does what it did.
export interface AcSofaCorpusRow {
  side: 'SO' | 'PO';
  docNo: string;
  dtlKey: number | null;
  acItemCode: string;
  erpCode: string;
  /** The ERP sofa model, after SOFA_MODEL_ALIAS, as the importer derives it. */
  model: string;
  /**
   * Is this model recliner-capable? The importer answers this from scm.products,
   * which a workerd test cannot reach, so here it is DERIVED from the corpus:
   * true when some document for the model decodes to a recliner or power
   * compartment. Deterministic and shared by every consumer, which is what a
   * round-trip needs; not a claim about the ERP catalogue.
   */
  recl: boolean;
  qty: number;
  creditorCode: string | null;
  desc2: string;
}

export const AC_SOFA_CORPUS_ROWS = ${rows.length};
export const AC_SOFA_CORPUS: readonly AcSofaCorpusRow[] = ${JSON.stringify(rows, null, 2)};
`;

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  /* Content, not line endings — see the same note in gen-autocount-item-map.mjs.
     core.autocrlf=true rewrites the checkout to CRLF and this file is written
     with LF, so an exact compare is red on Windows and green in CI. */
  const lf = (s) => s.replace(/\r\n/g, "\n");
  if (lf(current) !== lf(text)) {
    console.error("autocount-sofa-corpus.ts is STALE. Run: node scripts/gen-sofa-desc2-corpus.mjs");
    process.exit(1);
  }
  console.log(`autocount-sofa-corpus.ts is current (${rows.length} rows)`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${rows.length} rows)`);
}
