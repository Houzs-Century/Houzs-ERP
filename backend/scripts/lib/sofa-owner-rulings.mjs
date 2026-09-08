/**
 * THE OWNER'S OWN COMPARTMENT ANSWERS, INDEXED SO THE RECONCILE CAN SEE THEM.
 *
 * Some sofa builds are not decided by AutoCount's words. The book's Desc2 says
 * a colour and a factory instruction and nothing about the shape, or it says a
 * shape that the drawing contradicts; the owner reads the slip and rules. Those
 * rulings live in `data/sofa-compartment-corrections-*.json` and
 * `apply-sofa-compartment-corrections.mjs` writes them onto the ERP lines.
 *
 * ── THE PROBLEM THIS EXISTS TO FIX ──────────────────────────────────────────
 * `check-ac-erp-reconcile.mjs` never opened those files. So a document the
 * owner had already ruled on came back as a difference — DIFFER where the ERP
 * carries his answer and the book's text says something else, UNREADABLE where
 * the book's text says nothing at all. Both LOCK the migrated order.
 * `docs/bugs/0714-the-reconcile-reports-a-sofa-the-owner-has-already-ruled-on.md`
 * measured the cost: on run `34212598908` five of the eight PROCEEDED
 * compartment DIFFERs were rulings working exactly as intended, and every
 * session that read the report re-derived the same five before it could start.
 *
 * ── WHAT A RULING MAY AND MAY NOT DO ────────────────────────────────────────
 * A ruling is only ever allowed to say "this line was DECIDED by a human". It
 * is NEVER allowed to say "this line matches the book", because it does not —
 * that is the whole point of a ruling. So the caller gets a THIRD verdict of
 * its own (`RULED`), never `AGREE`. 0714 states the rule this obeys:
 *
 *   "It must not fold a ruled line into AGREE. The ERP really does differ from
 *    the book's text there, and hiding that would remove the only signal that
 *    would catch a ruling applied to the wrong document."
 *
 * AND THE RULING MUST BE ON THE LINE BEFORE IT COUNTS. `rulingFor` returns the
 * piece list; the CALLER compares it against what the ERP actually holds and
 * only then answers RULED. A ruling that was never applied — or was applied to
 * a different document — leaves the ERP holding something else, the multiset
 * comparison fails, and the line stays locked. Marking a line decided because a
 * FILE says so, without looking at the row, would forge the evidence the lock
 * exists to check (CLAUDE.md: "Evidence is not a setting").
 *
 * ── WHY THE NEEDLE IS MATCHED AGAINST THE *BOOK'S* DESC2 ────────────────────
 * `desc2Match` is what tells one build on a document from another, and
 * `apply-sofa-compartment-corrections.mjs` matches it against the ERP line's
 * `description2`. This module matches it against the BOOK's Desc2 from the
 * committed snapshot instead, because `scm.…_items.description2` is
 * server-generated on every write and can answer with our own summary
 * (`docs/bugs/0639`). The two texts are the same text when nothing has
 * overwritten ours, and the book's copy is the one that cannot have been.
 *
 * Zero dependencies beyond the desc2 matcher, so
 * `node --test scripts/lib/sofa-owner-rulings.test.mjs` runs on a bare
 * checkout — which is what the working-agreement workflow does.
 */
import { desc2Contains, normaliseDesc2 } from "./sofa-desc2-match.mjs";

const K = (s) => String(s ?? "").trim().toUpperCase();

/**
 * Index the loaded corrections by the ERP document they name.
 *
 * `_held` builds are deliberately NOT indexed: a held build is one the operator
 * decided not to write, so the ERP does not carry it and calling it decided
 * would be a lie in the one direction that opens a document.
 *
 * @param {any[]} builds the `builds` array from lib/sofa-corrections-source.mjs
 * @returns {Map<string, any[]>} ERP doc number (upper-cased) -> rulings
 */
export function buildRulingIndex(builds) {
  const idx = new Map();
  for (const b of builds ?? []) {
    const pieces = Array.isArray(b?.pieces) ? b.pieces.filter(Boolean) : [];
    if (!pieces.length) continue;
    for (const d of b?.docs ?? []) {
      const key = K(d);
      if (!key) continue;
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key).push({
        docs: b.docs, model: b.model ?? null, pieces,
        seat: b.seat ?? null, desc2Match: b.desc2Match ?? null,
        why: b.why ?? "", source: b.source ?? "",
      });
    }
  }
  return idx;
}

/**
 * The ruling that governs ONE sofa line, or nothing.
 *
 * @param {Map<string, any[]>} index from buildRulingIndex
 * @param {object} q
 * @param {string} q.erpDocNo the ERP document the line is on
 * @param {string} [q.model] the line's model, already folded through the alias map
 * @param {string} [q.bookDesc2] the BOOK's own build text for this line
 * @returns {{ verdict: "none"|"one"|"ambiguous", ruling: any|null, how: string }}
 */
export function rulingFor(index, { erpDocNo, model, bookDesc2 } = {}) {
  const none = (how) => ({ verdict: "none", ruling: null, how });
  const all = index?.get(K(erpDocNo)) ?? [];
  if (!all.length) return none("no ruling names this document");

  /* The model is a cheap, non-negotiable discriminator: a document can carry a
     sofa of one model and a bedframe of another, and a ruling written for the
     first must never reach the second. A ruling that names no model is not
     narrowed by one. */
  const wanted = K(model);
  const byModel = all.filter((r) => !r.model || !wanted || K(r.model) === wanted);
  if (!byModel.length) return none(`${all.length} ruling(s) on this document, none for model ${model}`);

  /* One build on the document and no needle: the ruling is about that build. */
  const needled = byModel.filter((r) => r.desc2Match);
  if (!needled.length) return decide(byModel, "the ruling carries no desc2Match");

  const hits = needled.filter((r) => desc2Contains(bookDesc2, r.desc2Match));
  if (!hits.length) {
    /* A ruling exists for the document but its needle is not in THIS line's
       book text — so it is about another build on the same document. Silence
       is the right answer, and it is not the same as "no ruling exists". */
    return none(`${needled.length} ruling(s) on this document, none whose desc2Match is in this line's book text`);
  }
  return decide(hits, "matched the ruling's desc2Match against the book's own text");

  function decide(cands, how) {
    const shapes = [...new Set(cands.map((r) => bagKey(r.pieces)))];
    if (shapes.length > 1) {
      /* Two rulings reaching one line and disagreeing about the shape is
         precisely what this must never choose between — same brake
         lib/sofa-desc2-match.mjs applies. */
      return { verdict: "ambiguous", ruling: null,
        how: `${cands.length} rulings reach this line and state DIFFERENT builds (${shapes.join(" vs ")})` };
    }
    return { verdict: "one", ruling: cands[0], how };
  }
}

/** Order-insensitive identity of a piece list, for telling two rulings apart. */
export function bagKey(pieces) {
  return (pieces ?? []).map((p) => K(p)).filter(Boolean).sort().join("+");
}

/** Exposed so a caller's log can quote the needle the way this compared it. */
export { normaliseDesc2 };
