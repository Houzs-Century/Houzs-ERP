/* ac-model-override-apply — the READS and the PRINTING behind the owner's
 * declared model override. It decides nothing.
 *
 * Split from lib/ac-model-override.mjs the way lib/ac-transfer-chain-report.mjs
 * is split from its runner, and for the same two reasons: loading a file and
 * formatting a paragraph are not the job of a classifier, and
 * check-ac-erp-reconcile.mjs sits under a 2,000-line ceiling that may only FALL
 * (scripts/file-size-ceilings.json). Every verdict below comes out of
 * `splitOwnerModelOverride`, which is pure and self-tested.
 *
 * ── THE DECLARATION IS READ FROM THE OWNER-APPROVED FILE, NOT FROM A LIST ──
 * `loadCorrections` is the SAME loader apply-sofa-compartment-corrections.mjs
 * writes from and lib/sofa-rulings.mjs reads for the compartment axis, so the
 * writer, the compartment reporter and this can never disagree about what he
 * decided. `_held` builds come back in their own list and are NOT passed in: a
 * held build is a ruling we have not written, so its line is still work.
 *
 * ── IT FAILS SOFT, AND SAYS SO ─────────────────────────────────────────────
 * If the files cannot be read, NOTHING is moved and the run says out loud that
 * it could not read them. A silent failure here would put a declared decision
 * back into the defect count with no explanation — annoying — but a silent
 * SUCCESS on a bad read would be worse, so the direction is deliberate: with no
 * declaration loaded every finding stays a difference.
 *
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */
import { loadCorrections } from "./sofa-corrections-source.mjs";
import { makeModelOverrideIndex, splitOwnerModelOverride, runSelfTest, NOTE_MODEL_OVERRIDE, AXIS_ITEM_CODE } from "./ac-model-override.mjs";

/* One read per data directory per process. Six document types walk this and the
   files do not change under a run. */
const CACHE = new Map();

/** The declarations, or an empty index and the reason it is empty. */
export function loadModelOverrideIndex(dataDir) {
  if (CACHE.has(dataDir)) return CACHE.get(dataDir);
  let got;
  try {
    const { builds, files } = loadCorrections(dataDir);
    got = { index: makeModelOverrideIndex(builds), why: `read from ${files.join(", ") || "(no corrections file)"}` };
  } catch (e) {
    got = { index: new Map(), why: `the corrections files could not be read: ${e.message}` };
  }
  CACHE.set(dataDir, got);
  return got;
}

/**
 * Move the item-code findings the owner has DECLARED out of the difference set,
 * record them under their own note class, and print what was moved and why.
 *
 * @param {object} a
 * @param {Array<object>} a.rows    the item-code findings for this type
 * @param {string} a.dataDir        the `scripts/data` directory
 * @param {object} a.recorder       the verdict recorder
 * @param {string} a.t              the document type
 * @param {object} io
 * @returns {{moved: Array<object>, differ: Array<object>, applied: boolean, why: string}}
 */
export function applyOwnerModelOverride({ rows, dataDir, recorder, t }, { log, plain, show = 20 }) {
  /* A splitter that cannot split must not go on moving findings out of a defect
     count. Same refusal shape as every other classifier in this lane. */
  const st = runSelfTest();
  if (st.length) {
    log(`${t} MODEL OVERRIDE NOT APPLIED — the splitter failed its own self-test: ${st.join("; ")}. ` +
      "Every item-code finding stays a difference, which is the safe direction.");
    return { moved: [], differ: rows, applied: false, why: "self-test failed" };
  }

  const { index, why: source } = loadModelOverrideIndex(dataDir);
  const r = splitOwnerModelOverride({ rows, index });

  if (!r.applied && rows.length) {
    log(`${t} MODEL OVERRIDE NOT APPLIED — ${r.why} (${source}). Nothing is moved.`);
    return r;
  }
  if (!r.moved.length) return r;

  log(
    `${t} — ${r.moved.length} item-code difference(s) are the OWNER'S OWN DECISION, not drift: the ERP names a ` +
      "product the account book does not because he said to. DECIDED, not backlog — and never folded into " +
      "agree: the line really does differ from the book, which is the only signal that would catch a decision " +
      "applied to the wrong document.",
  );
  plain(
    "      The declaration EXPIRES BY ITSELF: it names the book model it overrides, and the moment the book " +
      "stops saying that, the line goes back to DIFFER with nobody editing anything. That is what tells his " +
      `decision from the hand-typed model of docs/bugs/0693. Source: ${source}.`,
  );
  for (const row of r.moved.slice(0, show)) {
    plain(`      ${row.line}`);
    plain(`         RULED by ${row.decl.by}${row.decl.on ? ` on ${row.decl.on}` : ""} — the book says model ` +
      `${row.decl.book}, the ERP holds ${row.decl.model}${row.decl.why ? `: ${row.decl.why}` : ""}`);
  }
  if (r.moved.length > show) plain(`      ... and ${r.moved.length - show} more`);

  for (const row of r.moved) {
    recorder.reclassify(t, row.key, AXIS_ITEM_CODE, NOTE_MODEL_OVERRIDE, row.line);
  }
  return r;
}
