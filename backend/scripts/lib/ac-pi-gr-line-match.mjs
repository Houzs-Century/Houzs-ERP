/* ac-pi-gr-line-match — which GOODS-RECEIPT LINE did this purchase-invoice line
 * bill?
 *
 * ── THE QUESTION, AND WHY THE BOOK CANNOT ANSWER IT DIRECTLY ───────────────
 * `scm.purchase_invoice_items.grn_item_id` is NULL on the invoice lines the
 * chain axis calls `erp_link_missing` — the book says the line was raised from
 * a goods receipt and we point at nothing (lib/transfer-chain-verdict.mjs).
 *
 * The obvious fix would be to copy the book's own source-line key across. There
 * is none. `FromDocDtlKey` is NULL on all ~220,000 rows of all six AutoCount
 * detail tables — re-measured every run by lib/ac-transfer-chain-run.mjs, and
 * asserted again by the repair script that calls this module. AutoCount records
 * which DOCUMENT a line came from and never which LINE. So the line has to be
 * read out of the two documents themselves.
 *
 * ── WHAT IT READS, AND WHAT IT REFUSES TO READ ────────────────────────────
 * Two rules, in order, both inside the ONE goods receipt the book names:
 *
 *   1. the receipt has exactly one line of that item code  -> that line
 *   2. it has several, and exactly one of them carries the SAME BUILD TEXT
 *      (`<DTL>.Desc2`) as the invoice line                 -> that line
 *
 * Anything else is REFUSED and named. A link honestly left blank stays visible
 * as the missing link it is; a wrong one is indistinguishable from a fact
 * afterwards.
 *
 * ── WHY NOT POSITION, EVER ────────────────────────────────────────────────
 * The sibling matcher lib/ac-gr-po-line-match.mjs was written after a position
 * pairing transposed two identical bed frames on PO-009081 — the FIRST receipt
 * line belonged to the SECOND order line (docs/bugs/0730, and the named class
 * docs/bugs/0690). Its test was run RED against a position implementation:
 * 6 failed of 8. The same trap is live here, for the same reason — one receipt
 * routinely carries several lines of one item code differing only in build text
 * — so this module is written to the same two rules and pairs by position
 * never.
 *
 * ── THE INVOICE-SHAPED REFUSAL, WHICH IS SCOPE AND NOT DOUBT ──────────────
 * `PIDTL.FromDocNo` names a GOODS RECEIPT on most lines and a PURCHASE ORDER on
 * the rest. `grn_item_id` can only point at a receipt line, so a line the book
 * raised straight off an order is refused and SAID, not guessed into the
 * receipt that happens to sit under that order. And the migration deliberately
 * carried only the outstanding population, so a receipt the book names may
 * simply not be one we hold — also refused, also named. Neither is a defect in
 * this matcher; both are the cutover's own shape, and a count of them is worth
 * more than a link.
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
 * spacing and different capitalisation. Runs of whitespace collapse to one and
 * the whole string folds to upper case; nothing else is normalised, because
 * every remaining character (the inch marks, the slashes, the colour code) is
 * load-bearing.
 *
 * Deliberately identical to lib/ac-gr-po-line-match.mjs's `buildText`. The two
 * are separate exports rather than one shared helper because they answer for
 * different edges and may have to diverge; if they ever do, that must be a
 * decision somebody makes, not a shared function quietly changing both.
 */
export const buildText = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toUpperCase();

/** The source documents one `FromDocNo` field names. AutoCount packs several
 *  into the field; lib/transfer-chain-verdict.mjs splits it the same way. */
const sourceTokens = (s) => doc(s).split(/[,;\s]+/).filter(Boolean);

/**
 * Pair migrated purchase-invoice lines to the goods-receipt lines they billed.
 *
 * @param piLines      [{ docNo, dtlKey, itemKey, fromDocNo }] — the BOOK's
 *                     invoice lines that carry no ERP link.
 * @param grLinesByDoc Map<grDocNo, [{ dtlKey, itemKey }]> — the BOOK's
 *                     goods-receipt lines, keyed by receipt number. A receipt
 *                     absent from this map is one we do not hold.
 * @param desc2        Map<dtlKey, string> — the book's build text, both sides.
 * @returns {{ pairs: Array<{piDtlKey, piDocNo, grDocNo, grDtlKey, how}>,
 *             refused: Array<{piDtlKey, piDocNo, grDocNo, itemKey, why}> }}
 */
export function matchPiLinesToGrLines({ piLines, grLinesByDoc, desc2 }) {
  const d2 = desc2 ?? new Map();
  const pairs = [];
  const refused = [];

  const refuse = (p, grDocNo, why) =>
    refused.push({ piDtlKey: String(p.dtlKey), piDocNo: p.docNo ?? null, grDocNo, itemKey: code(p.itemKey), why });

  for (const p of piLines) {
    const tokens = sourceTokens(p.fromDocNo);
    /* The book names several source documents on one invoice line. Which of
       them this line came from is exactly the question, and the field does not
       answer it. */
    if (tokens.length !== 1) {
      refuse(p, tokens.join(" ") || null,
        tokens.length === 0
          ? "the book states no source document for this invoice line"
          : `the book names ${tokens.length} source documents on one line (${tokens.join(", ")}), so which one this line came from is not stated`);
      continue;
    }
    const grDocNo = tokens[0];
    const receipt = grLinesByDoc.get(grDocNo);
    if (!receipt) {
      /* Two different worlds land here and the caller is told which by the
         document number itself: a receipt the migration never carried, and a
         PURCHASE ORDER, which `grn_item_id` structurally cannot point at. */
      refuse(p, grDocNo,
        `the book raised this line from ${grDocNo}, which is not a goods receipt in the snapshot — ` +
        "either it is a purchase order (grn_item_id cannot point at one) or it is a receipt the migration never carried");
      continue;
    }

    const wanted = code(p.itemKey);
    const cands = receipt.filter((x) => code(x.itemKey) === wanted);
    if (cands.length === 0) { refuse(p, grDocNo, `no line of this item code on ${grDocNo}`); continue; }
    if (cands.length === 1) {
      pairs.push({ piDtlKey: String(p.dtlKey), piDocNo: p.docNo ?? null, grDocNo,
        grDtlKey: String(cands[0].dtlKey), how: `the only line of its item code on ${grDocNo}` });
      continue;
    }

    /* Several lines of the same code. The build text is the only column left
       that can tell them apart, and it must single out exactly ONE. */
    const want = buildText(d2.get(String(p.dtlKey)));
    const hits = want ? cands.filter((x) => buildText(d2.get(String(x.dtlKey))) === want) : [];
    if (hits.length === 1) {
      pairs.push({ piDtlKey: String(p.dtlKey), piDocNo: p.docNo ?? null, grDocNo,
        grDtlKey: String(hits[0].dtlKey), how: `the one line of ${cands.length} on ${grDocNo} whose build text is the same` });
      continue;
    }
    refuse(p, grDocNo,
      `${cands.length} receipt lines carry this item code on ${grDocNo} and ` +
      (want
        ? (hits.length === 0
            ? "the invoice line's build text matches none of them"
            : `${hits.length} of them carry the same build text, so it singles out no one line`)
        : "the invoice line carries no build text to tell them apart"));
  }

  /* ── ONE RECEIPT LINE MAY NOT ANSWER TWO INVOICE LINES ─────────────────────
     A receipt billed across two invoices would be a legitimate reason for this,
     and so would a mis-read of two identical builds. This matcher cannot tell
     those apart, so it refuses BOTH rather than write a link that might bill
     the same receipt line twice — and billing something twice is the expensive
     direction. */
  const byGr = new Map();
  for (const p of pairs) {
    const k = `${p.grDocNo}|${p.grDtlKey}`;
    byGr.set(k, (byGr.get(k) ?? 0) + 1);
  }
  const clash = new Set([...byGr].filter(([, n]) => n > 1).map(([k]) => k));
  if (clash.size === 0) return { pairs, refused };

  const kept = [];
  for (const p of pairs) {
    const k = `${p.grDocNo}|${p.grDtlKey}`;
    if (!clash.has(k)) { kept.push(p); continue; }
    refused.push({
      piDtlKey: p.piDtlKey, piDocNo: p.piDocNo, grDocNo: p.grDocNo, itemKey: null,
      why: `this and another invoice line both read as the same receipt line ${p.grDtlKey} on ${p.grDocNo}`,
    });
  }
  return { pairs: kept, refused };
}
