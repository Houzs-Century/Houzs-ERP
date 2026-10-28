// ---------------------------------------------------------------------------
// sofa-unread-split — the reconcile's sofa-compartment `unread` column, BY CAUSE.
//
// WHY THE COLUMN HAD TO BE SPLIT. It is one number carrying at least two
// populations that need DIFFERENT PEOPLE, and on 2026-09-08 it read 195 on
// sales orders and was quoted as one backlog.
//
//   · A sofa whose ERP rows carry no AutoCount line key is a MECHANICAL gap.
//     Nothing about the build is in doubt; we simply have not recorded which
//     book line the rows belong to. Stamping the key is a RECORDING job and
//     needs no ruling from anyone — the owner's standing rule
//     「一律跟账本。除了sofa compartment而已啊」 reserves his judgement for what
//     the compartments ARE, not for which line they sit on.
//   · A sofa whose Desc2 the decoder cannot turn into pieces is the OWNER's.
//     The book's text does not say what the build is, so only his drawing can
//     answer it, and no amount of keying will change that.
//
// THE TWO QUESTIONS ARE INDEPENDENT, so this is a CROSS-TAB and not a list: a
// line can be missing its key AND be undecodable, and folding that case into
// either arm alone would overstate what stamping keys can buy. Measured the day
// it was written: 85 mechanical, 5 both, 105 owner-only.
//
// `other` is not padding. It is the bucket that makes a THIRD cause visible
// instead of silently joining one of the two, and it is reported WHOLE rather
// than sampled — a sampled unknown is not a visible one. It was empty on the
// first run, which is what makes "these two causes are exhaustive" a
// measurement rather than an assumption.
//
// PURE: verdicts in, tallies and printable lines out. No filesystem, no
// database, no printing. The caller owns the I/O.
//
// NO SHEBANG: tests/sofaUnreadSplit.test.mjs imports this module (see
// lib/ac-mapping-csv.mjs for the Windows vitest reason).
// ---------------------------------------------------------------------------

/** Bucket key -> the sentence the report prints for it. Order is the order the
 *  table prints in: mechanical first, because it is the arm somebody can act on
 *  today. */
export const UNREAD_LABEL = {
  keylessBookReadable:
    "no AutoCount line key, and the book's build text DOES decode — MECHANICAL, a key is all that is missing",
  keylessBookUnreadable:
    "no AutoCount line key AND the book's build text does not decode — needs the key first, then the owner's drawing",
  keyedBookUnreadable:
    "keyed, but the book's build text cannot be decoded into pieces — the OWNER's drawing is the only source",
  other: "UNREADABLE for some other reason — named below, never folded into either arm",
};

/** The one bucket a key alone can close. */
export const MECHANICAL = "keylessBookReadable";

/**
 * Which bucket this unanswerable compartment cell falls in.
 * @param {{keyless: boolean, bookUnreadable: boolean}} a
 * @returns {keyof typeof UNREAD_LABEL}
 */
export function classifyUnread({ keyless, bookUnreadable }) {
  if (keyless) return bookUnreadable ? "keylessBookUnreadable" : "keylessBookReadable";
  return bookUnreadable ? "keyedBookUnreadable" : "other";
}

/**
 * A tally that can print itself.
 *
 * @returns {{record: (bucket: string, proceeded: boolean, where: string) => void,
 *            total: () => number,
 *            lines: (show: number) => string[]}}
 *
 * `lines(show)` returns the report block, or an empty array when nothing is
 * unanswerable — a heading over an empty table reads as a finding.
 */
export function makeUnreadTally() {
  const counts = {};
  const where = {};
  for (const k of Object.keys(UNREAD_LABEL)) {
    counts[k] = { yes: 0, no: 0 };
    where[k] = [];
  }

  const total = () => Object.values(counts).reduce((s, h) => s + h.yes + h.no, 0);

  return {
    record(bucket, proceeded, at) {
      if (!counts[bucket]) return;
      counts[bucket][proceeded ? "yes" : "no"] += 1;
      where[bucket].push(at);
    },
    total,
    lines(show) {
      const n = total();
      if (!n) return [];
      const out = [
        `   the ${n} UNREAD compartment answer(s) on this document type, BY CAUSE ` +
          "(the two causes are independent, so this is a cross-tab, not a list):",
      ];
      for (const [k, h] of Object.entries(counts)) {
        if (!h.yes && !h.no) continue;
        out.push(`      ${String(h.yes + h.no).padStart(4)}  (${h.yes} proceeded, ${h.no} not)  ${UNREAD_LABEL[k]}`);
      }
      const fixable = counts[MECHANICAL].yes + counts[MECHANICAL].no;
      out.push(
        `      => ${fixable} can be made comparable WITHOUT the owner (stamp the key); ` +
          `${n - fixable} cannot — the book's own text does not say what the build is.`,
      );
      for (const [k, list] of Object.entries(where)) {
        if (!list.length) continue;
        /* `other` is listed WHOLE. It exists to make a third cause visible, and
           a sampled unknown is not a visible one. */
        const cap = k === "other" ? list.length : show;
        out.push(`      -- ${UNREAD_LABEL[k]}`);
        for (const line of list.slice(0, cap)) out.push(`         ${line}`);
        if (list.length > cap) out.push(`         ... ${list.length - cap} more`);
      }
      return out;
    },
  };
}
