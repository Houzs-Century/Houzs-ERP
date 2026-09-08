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
  AGREE, AXES, BOOK_BLANK, DIFFER, ERP_BLANK, NO_LINE_KEY, PENDING, RECORDED, RULED, RULING_LOST,
  UNREADABLE, VARIANT_GROUPS, VERDICTS, applyCompartmentRuling, compareLine, compartmentOf,
  decodeBook, foldGuessedPairing,
} from "./variant-reconcile.mjs";
import { comparisonKey } from "./keyless-multiset.mjs";
import { classifyUnread, makeUnreadTally } from "./sofa-unread-split.mjs";

const SHOW_BOOK_BLANK = 5; // the direction that is NOT work; enough to see it exists

/* axis key -> the label the table prints, so the sentence a salesperson reads
   and the column the owner reads are the SAME WORD. Built from AXES rather than
   typed, so a new axis cannot arrive with no name here. */
const AXIS_LABEL = Object.fromEntries(AXES.map((a) => [a.key, a.label]));

/* The LOCKING axis a build that no longer matches the owner's ruling is recorded
   under. Its own name, not `sofa compartments`: a document shut because somebody
   overwrote his decision needs a different person and a different conversation
   from one that never matched the book, and a shared axis name would put them in
   one number. Declared in lib/so-verdict-derive.mjs, which is what makes it lock;
   spelled here because this is the only place it is recorded. */
const RULING_LOST_AXIS = "sofa build differs from the owner ruling";

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
 *
 * `rulingFor` answers "has the owner ruled THIS build's compartments" — see
 * lib/sofa-ruling-index.mjs. It is REQUIRED, not optional: a missing resolver
 * would silently restore the behaviour where every ruled document is reported as
 * a difference and LOCKED, which is the bug this argument exists to fix, and it
 * would do so with no error anywhere (BUG CLASS optional-param-noop). Pass
 * `() => ({ ruling: null, ambiguous: null })` to compare against the book alone.
 */
export function reportVariants({ t, label, rows, desc2, deps: V, VERDICT, SHOW, log, plain, rulingFor }) {
  if (typeof rulingFor !== "function") {
    throw new Error("reportVariants: `rulingFor` is required — see lib/sofa-ruling-index.mjs");
  }
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
  /* The owner's rulings, NAMED. A suppression the reader cannot see is a
     suppression nobody re-checks (docs/bugs/0668), and this is the one class
     whose whole purpose is to stop a document being reported — so it is printed
     with his value and the file his ruling lives in, never merely subtracted. */
  const ruledRows = [];
  const ruleLostRows = [];
  const ruleUncheckable = [];
  const ruleAmbiguous = [];
  /* A ruling that changed nothing: the book's text already said what he ruled.
     Counted, not listed — there is no difference to excuse and no line to act on,
     but a reader comparing this run's RULED count against the ruling FILE needs
     to see where the rest of the file went. */
  let ruleAgreed = 0;
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
    const { axes } = compareLine(V, { book, erpLines: r.erpLines, proceeded });
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
    /* Carried onto the row rather than recomputed in pass 3, so the CAUSE the
       per-document verdict records and the cause the cross-tab prints are the
       SAME measurement. Two statements of one classification is the failure
       this file's own header names. */
    const unreadCause = classifyUnread({ keyless, bookUnreadable });
    if (axes.compartments && keyless) {
      axes.compartments.verdict = UNREADABLE;
      axes.compartments.book = axes.compartments.book || "(not regroupable)";
      axes.compartments.detail =
        "the ERP lines of this document carry no AutoCount line key, so the pieces of one build cannot be regrouped";
      unkeyedSofa++;
    }
    /* ── THE OWNER'S RULING, APPLIED AFTER THE PAIRING IS SETTLED ───────────
       It has to come after the keyless override above, because a ruling may only
       be asserted against a build that can be REGROUPED — see
       applyCompartmentRuling's header. It excuses ONE axis on ONE build: every
       other axis of this line was decided above and is not touched here. */
    if (axes.compartments) {
      const where = `${r.ac} DtlKey ${r.acLine.dtlKey} (ERP ${r.erpNo} ${lead.item_code ?? "?"})`;
      const { ruling, ambiguous } = rulingFor({ ac: r.ac, erpNo: r.erpNo, erpLines: r.erpLines });
      if (ambiguous) {
        /* REFUSED, never chosen between. The line keeps whatever the book
           comparison said, which is the stricter answer. */
        ruleAmbiguous.push(
          `${where}: ${ambiguous.length} owner rulings reach this build ` +
            `(${ambiguous.map((x) => `${x.pieces.join("+")} via ${JSON.stringify(String(x.desc2Match).slice(0, 40))}`).join("  vs  ")})` +
            " — REFUSED, and compared against the book instead",
        );
      }
      const did = applyCompartmentRuling(axes.compartments, {
        ruling,
        erpPieces: r.erpLines.map((l) => compartmentOf(l.item_code)).filter(Boolean),
        regroupable: !keyless,
      });
      const said = ruling ? `${where}: the owner ruled ${ruling.pieces.join("+")} (${ruling.source})` : "";
      if (did === "not-regroupable") ruleUncheckable.push(`${said} — but this build cannot be regrouped, so it was NOT checked`);
      else if (did === "ruled") ruledRows.push(`${said}; ERP holds ${axes.compartments.erp || "(blank)"}${proceeded ? "  [PROCEEDED]" : ""}`);
      else if (did === "lost") ruleLostRows.push(`${said}; ERP holds ${axes.compartments.erp || "(blank)"} — ${axes.compartments.detail}${proceeded ? "  [PROCEEDED]" : ""}`);
      else if (did === "agreed-anyway") ruleAgreed++;
    }
    if (axes.compartments && axes.compartments.verdict === UNREADABLE) {
      unread.record(
        unreadCause,
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
      r, lead, proceeded, axes, unreadCause,
      bucket: `${r.ac}|${comparisonKey({ code: lead.item_code, side: "erp", suffixed: Boolean(lead.line_suffix) }).key}|${Number(Number(lead.qty ?? 0).toFixed(4))}`,
      keyed: !keyless,
    });
  }

  /* PASS 2 — the fold. Stated in lib/variant-reconcile.mjs, with the three
     clauses that keep it from swallowing a real difference. */
  const guessFold = foldGuessedPairing(computed);

  for (const { r, lead, proceeded, axes, unreadCause } of computed) {
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
        VERDICT.record(t, r.ac, r.erpNo, AXIS_LABEL[key] ?? key, `${where}: ${both}`, proceeded);
      } else if (cell.verdict === UNREADABLE) {
        /* WE COULD NOT ANSWER THIS AXIS. A sofa whose ERP lines carry no
           AutoCount line key cannot have its compartments regrouped, so the
           reconcile says so rather than agreeing — and "could not tell" is not
           "it matches". It locks on its own named axis so the person reading
           the refusal is not sent looking for a difference that was never
           measured. */
        VERDICT.record(t, r.ac, r.erpNo, "sofa build not verifiable", `${where}: ${cell.detail || "not comparable"}`, proceeded);
        /* WHOSE it is, recorded next to the refusal. A key that is merely
           unstamped is OURS to stamp; a build text that does not decode is the
           owner's drawing and nothing else. One number covering both has been
           quoted as one backlog once already (lib/sofa-unread-split.mjs). */
        VERDICT.note(t, r.ac, r.erpNo, "unanswerable-cause", unreadCause, where, proceeded);
      } else if (cell.verdict === BOOK_BLANK) {
        bookBlanks[key].push(`${where}: ${both}`);
        VERDICT.note(t, r.ac, r.erpNo, "book-blank", AXIS_LABEL[key] ?? key, `${where}: ${both}`, proceeded);
      } else if (cell.verdict === PENDING) {
        VERDICT.note(t, r.ac, r.erpNo, "pending", AXIS_LABEL[key] ?? key, `${where}: ${both}`, proceeded);
      } else if (cell.verdict === RECORDED) {
        VERDICT.note(t, r.ac, r.erpNo, "recorded", AXIS_LABEL[key] ?? key, `${where}: ${both}`, proceeded);
      } else if (cell.verdict === ERP_BLANK) {
        /* Reached only when the order is NOT proceeded — the branch above took
           the proceeded arm. 还没proceed还没确认的就可以直接放空的. */
        VERDICT.note(t, r.ac, r.erpNo, "erp-blank-not-proceeded", AXIS_LABEL[key] ?? key, `${where}: ${both}`, false);
      } else if (cell.verdict === RULED) {
        /* THE OWNER HAS ALREADY SETTLED THIS BUILD, and the ERP holds exactly
           what he settled. It is NOT a difference and it must NOT lock — the
           mechanism that locked it was punishing the documents he had personally
           answered, and every ruling he gave made it worse
           (「SO13475 我不是给你答案了吗？为什么你还在纠结？」). It goes down the
           NOTE channel, which never touches `clean`, and it is NAMED with his
           value and the file his ruling lives in, so the exclusion is visible
           rather than suppressed. */
        VERDICT.note(t, r.ac, r.erpNo, "ruled", AXIS_LABEL[key] ?? key, `${where}: ${both}`, proceeded);
      } else if (cell.verdict === RULING_LOST) {
        /* A ruling exists and the ERP does not hold it. LOUDER than an ordinary
           difference and on its OWN locking axis: this is his decision having
           been overwritten, or never applied, and he needs to know which of his
           answers stopped being true. */
        VERDICT.record(t, r.ac, r.erpNo, RULING_LOST_AXIS, `${where}: ${both}`, proceeded);
      } else if (cell.verdict === NO_LINE_KEY) {
        /* NAMED, never a count on its own. A class the reader cannot enumerate
           is a suppression, not a declaration — the rule docs/bugs/0668 was
           written for, applied to the column that was added to answer it. */
        noKeyRows[key].push(`${where}: ${both}`);
        VERDICT.note(t, r.ac, r.erpNo, "no-line-key", AXIS_LABEL[key] ?? key, `${where}: ${both}`, proceeded);
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

  plain("axis                 |                          PROCEEDED (the backlog)                            |             not proceeded (blank is OK)");
  plain("                     |  agree  ERPblank  bookblank  differ  pend  unread  recorded  no-key  ruled  ruleLost |  agree  ERPblank  bookblank  differ  pend  unread  recorded  no-key  ruled  ruleLost");
  for (const a of AXES) {
    const y = tally[a.key].yes;
    const n = tally[a.key].no;
    const seen = VERDICTS.reduce((s2, v) => s2 + y[v] + n[v], 0);
    if (!seen) continue;
    const cells = (h) => [h[AGREE], h[ERP_BLANK], h[BOOK_BLANK], h[DIFFER], h[PENDING], h[UNREADABLE], h[RECORDED], h[NO_LINE_KEY], h[RULED], h[RULING_LOST]]
      .map((x, i) => String(x).padStart([6, 9, 10, 7, 5, 7, 10, 7, 6, 9][i]));
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
  plain(
    "ruled = the OWNER settled this sofa's build from his DRAWING and the ERP holds exactly what he settled, so the " +
      "book's TEXT disagreeing is his ruling working, not a gap. It never locks the document. ruleLost = a ruling " +
      "exists and the ERP does NOT hold it — his decision was overwritten or never applied, and that DOES lock, on " +
      "its own axis, because it needs him and not a data fix.",
  );
  if (ruledRows.length || ruleLostRows.length || ruleUncheckable.length || ruleAmbiguous.length || ruleAgreed) {
    log(
      `${t} — OWNER RULINGS on sofa compartments: ${ruledRows.length} build(s) match his ruling and are NOT counted as ` +
        `a difference; ${ruleLostRows.length} no longer match it; ${ruleUncheckable.length} could not be checked ` +
        `(no line key); ${ruleAmbiguous.length} refused as ambiguous; ${ruleAgreed} where the book already agreed.`,
    );
    for (const [head, list] of [
      ["RULED BY THE OWNER — not a difference, and NOT locked", ruledRows],
      ["HIS RULING NO LONGER HOLDS — locked, and he needs to know", ruleLostRows],
      ["A RULING EXISTS BUT COULD NOT BE CHECKED — the build cannot be regrouped", ruleUncheckable],
      ["TWO RULINGS REACH ONE BUILD — refused, compared against the book instead", ruleAmbiguous],
    ]) {
      if (!list.length) continue;
      plain(`   ${head}: ${list.length}`);
      for (const row of list.slice(0, SHOW)) plain(`      ${row}`);
      if (list.length > SHOW) plain(`      ... ${list.length - SHOW} more`);
    }
  }
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
    log(
      `${t} VARIANT ${a.label} — ${difYes} DIFFER on a PROCEEDED order` +
        (dif.length - difYes ? ` (+${dif.length - difYes} on orders not yet proceeded)` : "") +
        `, ${list.filter((x) => !x.differ).length} ERP blank on a proceeded order`,
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
  return {
    t, pop, tally, comparable: true,
    /* Carried out so the checker's own summary can state the owner-ruling split
       without re-deriving it from the printed text. */
    rulings: {
      ruled: ruledRows.length,
      lost: ruleLostRows.length,
      uncheckable: ruleUncheckable.length,
      ambiguous: ruleAmbiguous.length,
      agreedAnyway: ruleAgreed,
    },
  };
}
