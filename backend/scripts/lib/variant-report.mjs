/* variant-report — the variant reconcile for ONE document type, rendered.
 *
 * MOVED OUT OF check-ac-erp-reconcile.mjs, 2026-09-08, because that file had
 * reached its 2,000-line ceiling and the repo's rule is that a file over the
 * cap may not grow: the fix is a new module, never a bigger number
 * (docs/repo-hygiene.md). Nothing about the behaviour changed in the move --
 * the three passes, the tallies, the offender lists and every sentence printed
 * are the ones that were there, and the I/O the checker owns is passed IN.
 *
 * WHY IT IS A GOOD SEAM. Everything here is about ONE document type's variant
 * axes: decode the book text, compare it to the ERP line, fold the verdicts a
 * GUESSED pairing produced, tally, print. It reads no database and no file; its
 * only dependencies are the decoders (`deps`), the per-document verdict
 * recorder, and two print functions -- so it can be driven by a test without a
 * connection, which the 226 lines inside check-ac-erp-reconcile.mjs could not.
 *
 * The meaning of "different" still lives in lib/variant-reconcile.mjs and is
 * NOT restated here. This module renders; that one decides.
 */
import {
  AGREE, AXES, BOOK_BLANK, DIFFER, ERP_BLANK, NO_LINE_KEY, PENDING, RECORDED, RULED, UNREADABLE,
  VARIANT_GROUPS, VERDICTS, compareLine, decodeBook, foldGuessedPairing,
} from "./variant-reconcile.mjs";
import { comparisonKey } from "./keyless-multiset.mjs";
import { classifyUnread, makeUnreadTally } from "./sofa-unread-split.mjs";

const SHOW_BOOK_BLANK = 5; // the direction that is NOT work; enough to see it exists

/* axis key -> the label the table prints, so the sentence a salesperson reads
   and the column the owner reads are the SAME WORD. Built from AXES rather than
   typed, so a new axis cannot arrive with no name here. */
const AXIS_LABEL = Object.fromEntries(AXES.map((a) => [a.key, a.label]));

/**
 * The variant reconcile for one document type.
 *
 * `rows` is one entry per AutoCount line that reached the ERP, carrying the ERP
 * lines it became — the sofa split means that is often more than one.  `desc2`
 * is the book's own build text by DtlKey; a line absent from it is a line the
 * book said nothing about, which is BOOK-BLANK on every axis and NOT unknown.
 *
 * Every count is split PROCEEDED / not proceeded, because the owner's rule is
 * that an unconfirmed order may legitimately be blank and quoting the combined
 * figure as the backlog has already cost him time twice.
 */
export function reportVariants({ t, label, rows, desc2, deps: V, VERDICT, SHOW, log, plain }) {
  const tally = {};
  for (const a of AXES) tally[a.key] = { yes: {}, no: {} };
  for (const a of AXES) for (const half of ["yes", "no"]) for (const v of VERDICTS) tally[a.key][half][v] = 0;
  const offenders = {};
  const bookBlanks = {};
  const noKeyRows = {};
  for (const a of AXES) {
    offenders[a.key] = [];
    bookBlanks[a.key] = [];
    noKeyRows[a.key] = [];
  }
  const pop = { total: rows.length, modelled: 0, bedframe: 0, sofa: 0, other: 0, withDesc2: 0, proceeded: 0 };
  let unkeyedSofa = 0;
  /* The `unread` column, by CAUSE. lib/sofa-unread-split.mjs holds the argument
     for why one number there was two populations needing different people. */
  const unread = makeUnreadTally();
  /* PASS 1 computes every line's verdicts; PASS 2 folds the ones only a GUESSED
     pairing could have produced; PASS 3 tallies and lists. The fold has to sit
     between them because it is a statement about a GROUP of lines — which of
     our rows answers which of the book's — and a per-line loop cannot make it.
     Nothing else moved: pass 3 is the body pass 1 used to have. */
  const computed = [];

  for (const r of rows) {
    const lead = r.erpLines[0] || {};
    const group = String(lead.item_group ?? "").toLowerCase();
    if (!VARIANT_GROUPS.has(group)) {
      pop.other++;
      continue;
    }
    pop.modelled++;
    pop[group]++;
    const text = desc2.get(r.acLine.dtlKey) || "";
    if (text) pop.withDesc2++;
    /* `proceeded` is a per-line fact carried from the ERP query, not inferred
       here: an order with a Processing Date is what the factory is building. */
    const proceeded = lead.proceeded === true;
    if (proceeded) pop.proceeded++;
    const book = decodeBook(V, { desc2: text, itemGroup: group, itemCode: lead.item_code });
    const { axes } = compareLine(V, { book, erpLines: r.erpLines, proceeded, erpNo: r.erpNo });
    /* THE COMPARTMENT AXIS NEEDS THE WHOLE BUILD, AND ONLY THE LINE KEY CAN
       REGROUP IT. One AutoCount sofa line becomes one ERP line per piece; the
       pieces are recognisable as one build because they share
       linked_ac_dtlkey. Where the ERP lines carry no key the pairing above
       falls back to value and then to document order, which returns ONE ERP
       line per AutoCount line — so a five-piece build would be compared against
       one piece and reported as four missing compartments that are not missing
       at all. Say the axis is unanswerable instead of answering it wrongly. */
    /* Measured BEFORE the override below, because the override replaces the
       cell's verdict and would erase the evidence that the book text was the
       other, independent reason this line cannot be answered. */
    const bookUnreadable = book.compartments === null;
    const keyless = !r.erpLines.every((l) => l.ac_dtlkey != null);
    if (axes.compartments && keyless) {
      axes.compartments.verdict = UNREADABLE;
      axes.compartments.book = axes.compartments.book || "(not regroupable)";
      axes.compartments.detail =
        "the ERP lines of this document carry no AutoCount line key, so the pieces of one build cannot be regrouped";
      unkeyedSofa++;
    }
    if (axes.compartments && axes.compartments.verdict === UNREADABLE) {
      unread.record(
        classifyUnread({ keyless, bookUnreadable }),
        proceeded,
        `${r.ac} DtlKey ${r.acLine.dtlKey} (ERP ${r.erpNo} ${lead.item_code ?? "?"})` +
          (proceeded ? "" : "  [NOT PROCEEDED]"),
      );
    }
    /* THE BUCKET a guessed pairing could have permuted this row within: the
       document, plus the comparison key and quantity of OUR row. It is the
       ERP side's key on purpose — the question is whether the checker could
       tell OUR rows apart — and it is `comparisonKey`, the same canonicaliser
       lib/ac-forced-line-pairing.mjs bucketed on when it decided whether the
       line key could be stamped at all, so the two cannot disagree about which
       rows are candidates for each other. */
    computed.push({
      r, lead, proceeded, axes,
      bucket: `${r.ac}|${comparisonKey({ code: lead.item_code, side: "erp", suffixed: Boolean(lead.line_suffix) }).key}|${Number(Number(lead.qty ?? 0).toFixed(4))}`,
      keyed: !keyless,
    });
  }

  /* PASS 2 — the fold. Stated in lib/variant-reconcile.mjs, with the three
     clauses that keep it from swallowing a real difference. */
  const guessFold = foldGuessedPairing(computed);

  for (const { r, lead, proceeded, axes } of computed) {
    const half = proceeded ? "yes" : "no";
    for (const [key, cell] of Object.entries(axes)) {
      tally[key][half][cell.verdict]++;
      const where = `${r.ac} DtlKey ${r.acLine.dtlKey} (ERP ${r.erpNo} ${lead.item_code ?? "?"})`;
      const both = `AutoCount "${cell.book || "(blank)"}" vs ERP "${cell.erp || "(blank)"}"` +
        (cell.detail ? ` — ${cell.detail}` : "");
      if (cell.verdict === DIFFER || (cell.verdict === ERP_BLANK && proceeded)) {
        offenders[key].push({
          differ: cell.verdict === DIFFER,
          proceeded,
          line: `${where}: ${both}${proceeded ? "" : "  [NOT PROCEEDED]"}`,
        });
        /* THE VERDICT LOCKS ON BOTH ARMS, and on an order that is not yet
           proceeded too. DIFFER is two sides stating different things, which
           the owner's 「还没proceed还没确认的就可以直接放空的」 does NOT excuse —
           that ruling is about a BLANK. ERP_BLANK is only counted when the
           order IS proceeded, which is the same line the table calls "the only
           column that is WORK". BOOK_BLANK, PENDING and RECORDED fall to the
           branches below and never lock. */
        VERDICT.record(t, r.ac, r.erpNo, AXIS_LABEL[key] ?? key, `${where}: ${both}`);
      } else if (cell.verdict === UNREADABLE) {
        /* WE COULD NOT ANSWER THIS AXIS. A sofa whose ERP lines carry no
           AutoCount line key cannot have its compartments regrouped, so the
           reconcile says so rather than agreeing — and "could not tell" is not
           "it matches". It locks on its own named axis so the person reading
           the refusal is not sent looking for a difference that was never
           measured. */
        VERDICT.record(t, r.ac, r.erpNo, "sofa build not verifiable", `${where}: ${cell.detail || "not comparable"}`);
      } else if (cell.verdict === BOOK_BLANK) {
        bookBlanks[key].push(`${where}: ${both}`);
      } else if (cell.verdict === NO_LINE_KEY) {
        /* NAMED, never a count on its own. A class the reader cannot enumerate
           is a suppression, not a declaration — the rule docs/bugs/0668 was
           written for, applied to the column that was added to answer it. */
        noKeyRows[key].push(`${where}: ${both}`);
      }
    }
  }

  plain("");
  plain(`─────────── ${t} — ${label}: THE VARIANTS INSIDE THE LINE ───────────`);
  if (!pop.total) {
    log(`${t} VARIANTS — no AutoCount line of this type paired to an ERP line, so nothing was compared. NOT a clean run.`);
    return { t, pop, tally, comparable: false };
  }
  plain(
    `${pop.total} AutoCount lines paired to an ERP line; ${pop.modelled} carry a variant-bearing item group ` +
      `(${pop.bedframe} bedframe, ${pop.sofa} sofa) and ${pop.other} do not (accessory, mattress, service — no axes to compare). ` +
      `${pop.withDesc2} of the ${pop.modelled} have a build text in the book; ${pop.proceeded} are on a PROCEEDED order.`,
  );
  if (!pop.modelled) {
    log(`${t} VARIANTS — no bedframe or sofa line on this document type. Nothing to compare; NOT a clean run.`);
    return { t, pop, tally, comparable: false };
  }

  plain("axis                 |                      PROCEEDED (the backlog)                       |             not proceeded (blank is OK)");
  plain("                     |  agree  ERPblank  bookblank  differ  pend  unread  recorded  ruled  no-key |  agree  ERPblank  bookblank  differ  pend  unread  recorded  ruled  no-key");
  for (const a of AXES) {
    const y = tally[a.key].yes;
    const n = tally[a.key].no;
    const seen = VERDICTS.reduce((s2, v) => s2 + y[v] + n[v], 0);
    if (!seen) continue;
    const cells = (h) => [h[AGREE], h[ERP_BLANK], h[BOOK_BLANK], h[DIFFER], h[PENDING], h[UNREADABLE], h[RECORDED], h[RULED], h[NO_LINE_KEY]]
      .map((x, i) => String(x).padStart([6, 9, 10, 7, 5, 7, 10, 6, 7][i]));
    plain(`${a.label.padEnd(20)} | ${cells(y).join(" ")} | ${cells(n).join(" ")}`);
  }
  plain(
    "ERPblank on a PROCEEDED order is the only column that is WORK. bookblank is the ERP holding a value the " +
      "book never stated — an operator filled it in, which is allowed. pend = the book says TBC/KIV.",
  );
  plain(
    "recorded = the book asks for a PRICED special the line does not tick, and variants.specialsRecorded already " +
      "carries it: the owner's 2026-09-03 ruling 甲 applied — the factory sees the option and the document's money " +
      "did not move. DECIDED work, not backlog, and it is broken out so it can never be summed into the DIFFER column again.",
  );
  plain(
    "ruled = the owner read the slip HIMSELF and set the sofa build against the book's own words, and the ERP holds " +
      "exactly what he ruled — 「一律跟账本。除了sofa compartment而已啊」, the book decides everything EXCEPT the sofa " +
      "build. DECIDED, not backlog, and never folded into agree: the line really does differ from the text, which is the " +
      "only signal that would catch a ruling applied to the wrong document. A ruling NOT yet written stays in differ and " +
      "now names the answer it is failing to match. Source: backend/scripts/data/sofa-compartment-corrections-*.json.",
  );
  if (unkeyedSofa) {
    plain(
      `   of the ${pop.sofa} sofa lines, ${unkeyedSofa} sit on a document whose ERP lines carry no AutoCount ` +
        "line key, so their COMPARTMENTS are unanswerable rather than agreeing. Their colour, seat size and " +
        "specials are still compared - those are per-line values and do not need the build regrouped.",
    );
  }
  plain(
    "no-key = two or more of OUR rows of one item at one quantity on one document carry NO AutoCount line number, so " +
      "which of ours answers which of the book's was the checker's own GUESS - and both sides state the SAME set of " +
      "values, which no ordering can fake. The document ships what the book ordered; only the row labelling is unknown. " +
      "A bucket whose two sets DIFFER keeps every one of its differences.",
  );
  if (guessFold.folded) {
    log(
      `${t} — ${guessFold.folded} axis value(s) across ${guessFold.buckets} bucket(s) moved out of DIFFER into no-key: ` +
        "the pairing was the checker's guess and both sides state the same set. See docs/bugs/0709 and 0712.",
    );
  }

  /* Printed whenever anything is unanswerable, because a single number there
     has twice been read as one backlog. */
  for (const line of unread.lines(SHOW)) plain(line);

  for (const a of AXES) {
    const list = offenders[a.key];
    if (!list.length) continue;
    /* Differences first: both sides state something and they disagree, which is
       the only shape that needs a human to adjudicate rather than a fill. */
    list.sort((x, y) => Number(y.differ) - Number(x.differ));
    /* SPLIT THE DIFFER COUNT BY PROCEEDED, in the ANNOTATION and not only in the
       table above. This headline is the line that gets quoted into briefs and
       status notes, and it was summing the two halves the table had just been at
       pains to separate: sofa compartments read "32 DIFFER" on 2026-09-07 when
       ONE of the 32 sat on a proceeded order and 31 did not. The owner's rule
       「还没proceed还没确认的就可以直接放空的」 has already been broken twice by a
       lumped number, and both times the lump came from a line like this one. */
    const dif = list.filter((x) => x.differ);
    const difYes = dif.filter((x) => x.proceeded).length;
    /* The owner's own rulings are named on the SAME line as the difference
       count, because this is the line that gets quoted into briefs. A build
       he has already decided must never be re-presented to him as an open
       question - docs/bugs/0714, and 「这个很多我刚刚都给过你答案了啊」. */
    const ruled = tally[a.key].yes[RULED] + tally[a.key].no[RULED];
    log(
      `${t} VARIANT ${a.label} — ${difYes} DIFFER on a PROCEEDED order` +
        (dif.length - difYes ? ` (+${dif.length - difYes} on orders not yet proceeded)` : "") +
        `, ${list.filter((x) => !x.differ).length} ERP blank on a proceeded order` +
        (ruled ? `, ${ruled} RULED by the owner and already written (decided, NOT work)` : ""),
    );
    for (const row of list.slice(0, SHOW)) plain(`      ${row.line}`);
    if (list.length > SHOW) plain(`      ... ${list.length - SHOW} more`);
    const bb = bookBlanks[a.key];
    if (bb.length) {
      plain(`   ${a.label} — AutoCount blank, ERP carries one: ${bb.length} (first ${Math.min(SHOW_BOOK_BLANK, bb.length)}, NOT work)`);
      for (const row of bb.slice(0, SHOW_BOOK_BLANK)) plain(`      ${row}`);
    }
  }
  /* Printed for EVERY axis, including the ones with no offender at all — a
     no-key row is not an offender, so it would otherwise vanish with the
     `continue` above. */
  for (const a of AXES) {
    const nk = noKeyRows[a.key];
    if (!nk.length) continue;
    plain(`   ${a.label} — no AutoCount line number on our rows, both sides state the same set: ${nk.length} (NOT work)`);
    for (const row of nk.slice(0, SHOW)) plain(`      ${row}`);
    if (nk.length > SHOW) plain(`      ... ${nk.length - SHOW} more`);
  }
  return { t, pop, tally, comparable: true };
}
