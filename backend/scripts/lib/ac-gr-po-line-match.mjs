/* ac-gr-po-line-match — which PURCHASE ORDER LINE did this goods-receipt line
 * receive?
 *
 * ── THE QUESTION, AND WHY THE BOOK CANNOT ANSWER IT DIRECTLY ───────────────
 * `scm.grn_items.purchase_order_item_id` is NULL on 28 migrated receipt lines
 * across 22 (receipt x order) pairs, and the chain axis calls every one of them
 * `erp_link_missing` — the book says the line was raised from a purchase order
 * and we point at nothing (lib/transfer-chain-verdict.mjs).
 *
 * The obvious fix would be to copy the book's own source-line key across. There
 * is none. `FromDocDtlKey` is NULL on all ~220,000 rows of all six AutoCount
 * detail tables — re-measured every run by lib/ac-transfer-chain-run.mjs, and
 * measured again on the committed cut while this file was written. AutoCount
 * records the source DOCUMENT and nothing finer. So the line has to be read out
 * of the two documents themselves.
 *
 * ── WHAT IT READS, AND WHAT IT REFUSES TO READ ────────────────────────────
 * Two rules, in order, both inside the ONE purchase order the book names:
 *
 *   1. the order has exactly one line of that item code  -> that line
 *   2. it has several, and exactly one of them carries the SAME BUILD TEXT
 *      (`<DTL>.Desc2`) as the receipt line                -> that line
 *
 * Anything else is REFUSED and named. A link honestly left blank stays visible
 * as the missing link it is; a wrong one is indistinguishable from a fact
 * afterwards and credits one colour's delivery against another.
 *
 * ── WHY NOT POSITION, EVER ────────────────────────────────────────────────
 * PO-009081 orders two HOK-1030 (HF)(W) (Q) bed frames, same quantity, same
 * price, and two receipts each take one:
 *
 *   POdtl 833538  Color: PC151-10 ...      GRdtl 853738 (GR-004939)  PC151-12
 *   POdtl 833540  Color: PC151-12 ...      GRdtl 860498 (GR-004989)  PC151-10
 *
 * In document order the FIRST receipt line belongs to the SECOND order line.
 * Pairing by position transposes them — docs/bugs/0690, the named class that
 * bit three times on 2026-09-08. tests/acGrPoLineMatch.test.mjs pins this exact
 * case, and it was run RED against a position implementation before this one
 * existed.
 *
 * ── STOCK IS NOT TOUCHED, AND THAT IS THE POINT ───────────────────────────
 * The owner: 「库存先不看」. This resolves a POINTER and nothing else. A receipt
 * line's inventory IN is written off the receipt's own lines whether or not the
 * pointer is set — src/scm/lib/grn-unlinked-po-lines.ts states that as the
 * reason the over-receipt guard exists at all — and no trigger recomputes a
 * quantity from this column. Quantities, money, status and movements are all
 * left exactly where they are.
 *
 * PURE. No filesystem, no database, no clock, no printing.
 *
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */

/** A document number, trimmed and case-folded — the two systems have disagreed
 *  about both and neither difference is a different document. */
const doc = (s) => String(s ?? "").trim().toUpperCase();

/** An item code, trimmed and NOTHING else. Real codes carry meaningful spaces
 *  and brackets ("HOK-1030 (HF)(W) (Q)"); folding case would merge codes the
 *  item master keeps apart. */
const code = (s) => String(s ?? "").trim();

/**
 * Build text, compared on CONTENT. AutoCount's Desc2 is typed by hand into a
 * 100-character field and the same build reaches two documents with different
 * spacing and different capitalisation — PO-009024 holds the same sofa build
 * twice, differing only by a leading space. Runs of whitespace collapse to one
 * and the whole string folds to upper case; nothing else is normalised, because
 * every remaining character (the inch marks, the slashes, the colour code) is
 * load-bearing.
 */
export const buildText = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toUpperCase();

/** The source documents one `FromDocNo` field names. AutoCount packs several
 *  into the field; lib/transfer-chain-verdict.mjs splits it the same way. */
const sourceTokens = (s) => doc(s).split(/[,;\s]+/).filter(Boolean);

/**
 * Pair migrated goods-receipt lines to the purchase-order lines they received.
 *
 * @param grLines      [{ docNo, dtlKey, itemKey, fromDocNo }] — the BOOK's
 *                     receipt lines that carry no ERP link.
 * @param poLinesByDoc Map<poDocNo, [{ dtlKey, itemKey, qty, unitPrice }]> — the
 *                     BOOK's purchase-order lines, keyed by document number.
 * @param desc2        Map<dtlKey, string> — the book's build text, both sides.
 * @returns {{ pairs: Array<{grDtlKey, grDocNo, poDocNo, poDtlKey, how}>,
 *             refused: Array<{grDtlKey, grDocNo, poDocNo, itemKey, why}> }}
 */
export function matchGrLinesToPoLines({ grLines, poLinesByDoc, desc2 }) {
  const d2 = desc2 ?? new Map();
  const pairs = [];
  const refused = [];

  const refuse = (g, poDocNo, why) =>
    refused.push({ grDtlKey: String(g.dtlKey), grDocNo: g.docNo ?? null, poDocNo, itemKey: code(g.itemKey), why });

  for (const g of grLines) {
    const tokens = sourceTokens(g.fromDocNo);
    /* The book names several source documents on one receipt line. Which of
       them this line came from is exactly the question, and the field does not
       answer it. */
    if (tokens.length !== 1) {
      refuse(g, tokens.join(" ") || null,
        tokens.length === 0
          ? "the book states no source document for this receipt line"
          : `the book names ${tokens.length} source documents on one line (${tokens.join(", ")}), so which one this line came from is not stated`);
      continue;
    }
    const poDocNo = tokens[0];
    const order = poLinesByDoc.get(poDocNo);
    if (!order) { refuse(g, poDocNo, `purchase order ${poDocNo} is not in the snapshot`); continue; }

    const wanted = code(g.itemKey);
    const cands = order.filter((x) => code(x.itemKey) === wanted);
    if (cands.length === 0) { refuse(g, poDocNo, `no line of this item code on ${poDocNo}`); continue; }
    if (cands.length === 1) {
      pairs.push({ grDtlKey: String(g.dtlKey), grDocNo: g.docNo ?? null, poDocNo,
        poDtlKey: String(cands[0].dtlKey), how: `the only line of its item code on ${poDocNo}` });
      continue;
    }

    /* Several lines of the same code. The build text is the only column left
       that can tell them apart, and it must single out exactly ONE. */
    const want = buildText(d2.get(String(g.dtlKey)));
    const hits = want ? cands.filter((x) => buildText(d2.get(String(x.dtlKey))) === want) : [];
    if (hits.length === 1) {
      pairs.push({ grDtlKey: String(g.dtlKey), grDocNo: g.docNo ?? null, poDocNo,
        poDtlKey: String(hits[0].dtlKey), how: `the one line of ${cands.length} on ${poDocNo} whose build text is the same` });
      continue;
    }
    refuse(g, poDocNo,
      `${cands.length} order lines carry this item code on ${poDocNo} and ` +
      (want
        ? (hits.length === 0
            ? "the receipt line's build text matches none of them"
            : `${hits.length} of them carry the same build text, so it singles out no one line`)
        : "the receipt line carries no build text to tell them apart"));
  }

  /* ── ONE ORDER LINE MAY NOT ANSWER TWO RECEIPT LINES ───────────────────────
     A partial receipt taken in two deliveries would be a legitimate reason for
     this, and so would a mis-read of two identical builds. This matcher cannot
     tell those apart, so it refuses BOTH rather than write a link that might
     tick the same order line off twice. Measured on the committed cut: this
     fires on nothing, so it costs no real pair. */
  const byPo = new Map();
  for (const p of pairs) {
    const k = `${p.poDocNo}${p.poDtlKey}`;
    byPo.set(k, (byPo.get(k) ?? 0) + 1);
  }
  const clash = new Set([...byPo].filter(([, n]) => n > 1).map(([k]) => k));
  if (clash.size === 0) return { pairs, refused };

  const kept = [];
  for (const p of pairs) {
    const k = `${p.poDocNo}${p.poDtlKey}`;
    if (!clash.has(k)) { kept.push(p); continue; }
    refused.push({
      grDtlKey: p.grDtlKey, grDocNo: p.grDocNo, poDocNo: p.poDocNo, itemKey: null,
      why: `this and another receipt line both read as the same order line ${p.poDtlKey} on ${p.poDocNo}`,
    });
  }
  return { pairs: kept, refused };
}
