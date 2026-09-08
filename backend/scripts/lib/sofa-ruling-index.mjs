/* sofa-ruling-index — the owner's compartment rulings, as something a CHECKER
 * can consult.
 *
 * ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────────────
 * Some sofa builds are the owner's, read off HIS drawing, and the account
 * book's own words say something else. His standing rule
 * (docs/staff-reported-flow-2026-09-08.md, `SO-013475`, 2026-09-08) is that
 * where the two disagree THE DRAWING WINS — so on those documents the ERP is
 * SUPPOSED to differ from the book's text.
 *
 * check-ac-erp-reconcile.mjs did not know that. It compared the ERP against the
 * book's text, found the difference the ruling deliberately created, and called
 * it `DIFFER` — which the per-document verdict turns into a LOCKED sales order
 * (`scm.migrated_so_lock = verdict:1`). The order the owner unblocked in the
 * morning was shut in the evening BECAUSE he unblocked it. His words:
 * 「SO13475 我不是给你答案了吗？为什么你还在纠结？」
 *
 * ── THE AUTHORITY IS THE DATA FILE, NOT THE PROSE ───────────────────────────
 * `docs/sofa-compartment-owner-rulings-2026-09-08.md` is where his words are
 * quoted; it is a document for humans and its table is shorthand
 * (`1AL + 2AR + 1BR`), not ERP piece codes. The MACHINE authority is
 * `backend/scripts/data/sofa-compartment-corrections-*.json` — one row per
 * ruling, carrying the documents, the model, the exact piece list and the `why`
 * — which is already what `apply-sofa-compartment-corrections.mjs` WRITES from.
 * Reading the same rows the writer writes from is the only shape in which the
 * checker and the applier cannot disagree about what he ruled.
 * `tests/sofaRulingIndex.test.mjs` asserts the prose and the data name the same
 * documents, so a ruling that reaches only the doc goes red.
 *
 * ── A RULING IS A CHECK, NOT A BLANK CHEQUE ─────────────────────────────────
 * The exemption is NOT "ignore this document". It is "this document must hold
 * THIS build". `applyCompartmentRuling` in lib/variant-reconcile.mjs asserts the
 * ERP against his stated pieces; a ruled document whose ERP no longer matches
 * his ruling is reported LOUDER than an ordinary difference, on its own axis,
 * because somebody has overwritten his decision and he needs to know.
 *
 * And it excuses one AXIS. Compartments are his; the price, the quantity, the
 * line count and every other axis on the same document are the book's and are
 * still compared exactly as before.
 *
 * PURE apart from `loadSofaRulings`, which is the one function that touches the
 * filesystem, so a test can drive the index with literal rows.
 *
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */
import path from "node:path";

import { loadCorrections } from "./sofa-corrections-source.mjs";
import { desc2Contains } from "./sofa-desc2-match.mjs";

/** The comparison form of a document number. */
const docKey = (v) => String(v ?? "").trim().toUpperCase();

/**
 * @typedef {object} SofaRuling
 * @property {string[]} docs every document the ruling names
 * @property {string[]} pieces the build, left to right, in ERP piece codes
 * @property {string|null} desc2Match which build on the document this is
 * @property {string|null} model the model, where the entry states one
 * @property {string} why how the answer was reached
 * @property {string} source the FILE the ruling lives in — its round, and the
 *   only date the data itself carries, so it is what the report names
 */

/**
 * Index the loaded correction rows by every document they name.
 *
 * A row with no `pieces` is not a ruling — it states no build — and is dropped
 * rather than indexed as an empty one, which would assert the ERP holds nothing.
 *
 * @param {any[]} builds rows from lib/sofa-corrections-source.mjs
 * @returns {Map<string, SofaRuling[]>}
 */
export function buildRulingIndex(builds) {
  const index = new Map();
  for (const b of Array.isArray(builds) ? builds : []) {
    const pieces = Array.isArray(b?.pieces) ? b.pieces.filter((p) => String(p ?? "").trim()) : [];
    if (!pieces.length) continue;
    const docs = (Array.isArray(b?.docs) ? b.docs : []).map(docKey).filter(Boolean);
    if (!docs.length) continue;
    const ruling = {
      docs,
      pieces,
      desc2Match: b.desc2Match ? String(b.desc2Match) : null,
      model: b.model ? String(b.model) : null,
      why: String(b.why ?? ""),
      source: String(b.source ?? "(unknown file)"),
    };
    for (const d of docs) {
      if (!index.has(d)) index.set(d, []);
      index.get(d).push(ruling);
    }
  }
  return index;
}

/**
 * The ruling that covers ONE build — the ERP lines that came from ONE book line.
 *
 * `desc2Match` is what tells one build on a document from another, and it is
 * matched with `desc2Contains`, the SAME matcher the applier uses, so a needle
 * that reaches a build when it is written cannot fail to reach it when it is
 * checked. (That matcher exists because the file's line breaks are the two
 * characters backslash-n and prod's are real newlines — a plain `includes`
 * silently dropped 7 owner-approved builds on 2026-09-02.)
 *
 * TWO rulings reaching one build is REFUSED, never chosen between: choosing
 * would let the checker assert a build the owner did not give for these rows.
 * The refusal is returned rather than thrown so the reconcile prints it and
 * carries on comparing against the book, which is the stricter answer.
 *
 * @param {Map<string, SofaRuling[]>} index
 * @param {{ erpNo: unknown, erpLines: any[] }} where
 * @returns {{ ruling: SofaRuling|null, ambiguous: SofaRuling[]|null }}
 */
export function resolveRuling(index, { erpNo, erpLines }) {
  const none = { ruling: null, ambiguous: null };
  const candidates = index.get(docKey(erpNo));
  if (!candidates || !candidates.length) return none;
  const texts = (Array.isArray(erpLines) ? erpLines : []).map((l) => l?.description2 ?? "");
  const hits = candidates.filter(
    (c) => !c.desc2Match || texts.some((t) => desc2Contains(t, c.desc2Match)),
  );
  if (!hits.length) return none;
  if (hits.length > 1) return { ruling: null, ambiguous: hits };
  return { ruling: hits[0], ambiguous: null };
}

/**
 * Load the rulings from the committed data files.
 *
 * The ONE function here that touches the filesystem; everything above is pure
 * so a test can drive it with literal rows.
 *
 * @param {string} scriptsDir the `backend/scripts` directory
 */
export function loadSofaRulings(scriptsDir) {
  const got = loadCorrections(path.join(scriptsDir, "data"));
  return { index: buildRulingIndex(got.builds), files: got.files, builds: got.builds.length };
}
