/**
 * THE OWNER'S OWN SOFA BUILDS, for a READER rather than for the writer.
 *
 * 「一律跟账本。除了sofa compartment而已啊」 — the account book decides every axis
 * EXCEPT the sofa build, which is the owner's. He reads the slip's drawing and
 * rules, so on this ONE axis the ERP is SUPPOSED to differ from the book's
 * words. The reconcile had no input for that and could only report a build he
 * had personally decided as DIFFER, handing it back to him as an open question
 * every run (docs/bugs/0714). On 2026-09-08 he was shown one such report and
 * said 「这个很多我刚刚都给过你答案了啊」.
 *
 * The rulings are read from the SAME files apply-sofa-compartment-corrections.
 * mjs writes from, through the SAME loader, so the reporter and the writer can
 * never disagree about what he ruled.
 *
 * TWO PROPERTIES CARRY THE SAFETY, and both are refusals rather than fallbacks:
 *
 *   1. `_held` BUILDS ARE EXCLUDED. loadCorrections returns them in their own
 *      list. A held build is a ruling we have NOT written, so it is still work
 *      and must keep reading DIFFER. HC-SO-011099 is exactly that today
 *      (docs/bugs/0719).
 *   2. THE ENTRY IS CHOSEN BY ITS OWN desc2Match, never by document number
 *      alone. A document can hold more than one sofa build; putting one build's
 *      answer on another build's line would bless the wrong furniture, which is
 *      the failure this whole lane exists to prevent.
 *
 * Zero dependencies beyond the two sibling libs, so `node --test scripts/lib/`
 * runs its test on a bare checkout.
 */
import { loadCorrections } from "./sofa-corrections-source.mjs";
import { desc2Contains } from "./sofa-desc2-match.mjs";

/** The last element satisfying `pred`, or undefined. Written out rather than
 *  using Array.prototype.findLast so this module keeps running on the Node the
 *  oldest runner in this repo pins. */
function findLast(list, pred) {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return list[i];
  return undefined;
}

/**
 * Build the lookup the reconcile hands to `compareLine` as `deps.sofaRuling`.
 *
 * @param {string} dataDir the `scripts/data` directory
 * @param {(m: string) => void} [onError] told if the files cannot be read — the
 *   caller must SAY so, because with no rulings loaded every ruled build reports
 *   as DIFFER again, which is the bug this exists to fix.
 * @returns {(erpNo: string, erpLines: any[]) => ({ pieces: string[], source: string } | null)}
 *   null means he has not ruled on this build. Never a nearest match.
 */
export function makeSofaRulingLookup(dataDir, onError = () => {}) {
  const byDoc = new Map();
  try {
    for (const b of loadCorrections(dataDir).builds) {
      if (!Array.isArray(b.pieces) || !b.pieces.length) continue;
      for (const d of b.docs || []) {
        if (!byDoc.has(d)) byDoc.set(d, []);
        byDoc.get(d).push(b);
      }
    }
  } catch (e) {
    onError(e && e.message ? e.message : String(e));
  }

  return (erpNo, erpLines) => {
    const cands = byDoc.get(erpNo);
    if (!cands || !cands.length) return null;
    const text = (erpLines || []).map((l) => l.description2 || "").find(Boolean) || "";
    /* THE NEWEST RULING IS THE RULING. Two entries can match one build — he
       re-reads a slip and corrects himself, and the later file carries the
       correction. `byDoc` holds them in load order, which loadCorrections fixes
       as 2026-08, 2026-09, book-aligned, drawings: oldest first, and the drawing
       last because 「一律跟账本。除了sofa compartment而已啊」 makes his drawing
       the final word on the build. So the LAST match wins, not the first.
       This said `.find()` until 2026-09-08, and HC-SO-012929 is what it cost:
       he ruled it on 2026-09-04 and again on 2026-09-05, removing a surplus 1S,
       the ERP was moved to his answer, and the reader kept asserting August's
       three-piece build. The two never matched, so a document he had personally
       answered twice reported as "CANNOT BE COMPARED — your drawing decides
       these" on every single run. 「这个很多我刚刚都给过你答案了啊」.
       Measured on the 2026-09-08 data: exactly ONE document is ruled in more
       than one file, so this changes that document and nothing else. */
    const hit = findLast(cands, (c) => c.desc2Match && desc2Contains(text, c.desc2Match));
    /* A single ruling with no needle can only be this document's one build. */
    const only = cands.length === 1 && !cands[0].desc2Match ? cands[0] : null;
    const pick = hit || only;
    return pick ? { pieces: pick.pieces, source: pick.source } : null;
  };
}
