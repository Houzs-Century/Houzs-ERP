/* ac-transfer-chain-report — what the transfer-chain lane PRINTS.
 *
 * Split from lib/ac-transfer-chain-run.mjs for the same reason
 * lib/ac-field-identity-report.mjs is split from its runner: reading two
 * corpora and formatting a table are different jobs, and
 * check-ac-erp-reconcile.mjs sits under a 2,000-line ceiling that may only
 * FALL.
 *
 * PURE except for the two writers the caller hands in. It measures nothing,
 * classifies nothing and decides nothing — every number below was already
 * settled by the runner, which itself only records what
 * lib/transfer-chain-verdict.mjs says.
 *
 * ── WHY THE SILENCES ARE PRINTED AS LOUDLY AS THE FINDINGS ─────────────────
 * Three things about this axis are true and unwelcome, and a report that leaves
 * any of them out reads as more coverage than exists:
 *
 *   - AutoCount records no source LINE on four of the five edges, so document
 *     agreement is the finest answer available there and it is never dressed up
 *     as a line match;
 *   - SO->DO and DO->IV store no counter in the ERP at all, so there is nothing
 *     on those edges that can drift and nothing that was checked;
 *   - a line the run could not attach to a compared document was NOT compared,
 *     and is counted rather than dropped.
 *
 * That is the 0668 lesson applied in the permissive direction: a declaration
 * nobody can enumerate is a suppression, and an empty column that reads as
 * agreement is the same hazard with the sign flipped.
 *
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */
import { AXIS_FROM, AXIS_TO, AXIS_UNVERIFIABLE, recordTransferChain } from "./ac-transfer-chain-run.mjs";
import { FROM_VERDICTS, IS_DIFFERENCE, IS_UNANSWERABLE, TO_VERDICTS } from "./transfer-chain-verdict.mjs";

/**
 * MEASURE, then PRINT — the one entry point check-ac-erp-reconcile.mjs calls.
 *
 * It exists so that file gains two lines rather than six: it stands at a
 * 2,000-line ceiling that may only FALL, and that ceiling is the reason this
 * lane is three modules instead of a block. The two halves stay separately
 * exported and separately testable; this only composes them.
 */
export async function transferChainAxis(args, io) {
  printTransferChain(await recordTransferChain(args), io);
}

/** How each FROM verdict reads to somebody who is not an engineer. */
const FROM_LABEL = Object.freeze({
  book_states_no_source: "the book raised it from nothing (head of a chain)",
  agree_line: "SAME source document AND the same source line",
  agree_doc_line_unstated: "SAME source document (the book states no source line on this edge)",
  line_not_stamped: "same document; our row carries no line key to answer with",
  doc_differs: "WRONG source document — we point somewhere the book does not",
  line_differs: "right document, WRONG source line",
  erp_link_missing: "the book raised it from a document and we hold NO link at all",
  erp_parent_unstamped: "our parent carries no AutoCount number — nothing to compare",
});

const TO_LABEL = Object.freeze({
  agree: "agree",
  erp_low: "the book transferred MORE than we record",
  erp_high: "we record more transferred than the book",
  erp_asserts_untransferred: "we assert a transfer the book does not have at all",
  book_qty_zero: "book quantity is zero — no fraction to compare",
  erp_qty_zero: "ERP quantity is zero — no fraction to compare",
});

const pad = (s, w) => String(s).padEnd(w);
const rp = (n, w) => String(n).padStart(w);

/**
 * The migration decision, and the rows it does NOT cover.
 *
 * The impostors are printed LOUDER than the differences they sit among, and on
 * purpose: a real defect wearing a decision's label is one nobody goes and
 * looks at, which is what docs/bugs/0668 cost 30 documents on go-live eve. This
 * lane's version of that hazard is a goods receipt whose purchase invoice we DO
 * hold reading as "the history was never migrated".
 */
export function printOnwardSplit(r, { plain, log, show = 20 }) {
  const o = r.onward;
  if (!o) return;
  if (!o.applied) {
    if (!o.decision) return; /* no decision declared for this type — nothing to say */
    log(
      `${r.t} ONWARD-TRANSFER DECISION NOT APPLIED — ${o.unreadable ?? o.why}. All ${o.differ} transfer-to ` +
        "difference(s) stay counted as differences. An unproven decision is not a decision.",
    );
    return;
  }
  plain(
    `      of those, ${o.notMigrated} are 「${o.decision.label}」 and NOT a difference; ${o.differ} remain`,
  );
  plain(`        ${o.decision.ruling}`);
  plain(`        ${o.decision.consequence}`);
  plain(
    `        PROVED per document, never assumed: the book names at least one ${o.decision.onwardType} raised off ` +
      "the document AND the ERP holds none of them. The grain is the DOCUMENT because AutoCount records no " +
      "source LINE on this edge, and that is stated rather than dressed up as a line-level accounting.",
  );
  if (o.impostorCount) {
    log(
      `${r.t} — ${o.impostorCount} transfer-to difference(s) LOOK like 「${o.decision.label}」 and are NOT: they ` +
        "stay counted, and they are the ones to go and look at first.",
    );
    for (const im of o.impostors.slice(0, show)) plain(`        IMPOSTOR: ${im.why}`);
    if (o.impostorCount > show) plain(`        ... ${o.impostorCount - show} more (raise SHOW)`);
  }
}

/**
 * @param {object} res            recordTransferChain()'s return
 * @param {object} io
 * @param {(s: string) => void} io.plain
 * @param {(s: string) => void} io.log
 * @param {number} io.show
 */
export function printTransferChain(res, { plain, log, show = 20 }) {
  plain("");
  plain("═══════════ TRANSFER FROM / TRANSFER TO — 单据转换链 ═══════════");

  if (!res || !res.applied) {
    /* NOT a refusal of the whole run, and it must not read as agreement. */
    log(
      "TRANSFER CHAIN NOT MEASURED — " + (res?.why ?? "the lane did not run") +
        ". No document is opened or shut on this axis by this run: the axis is ABSENT, not zero. " +
        "「我们没看过」 and 「看过了，对的」 are different answers and this is the first one.",
    );
    return;
  }

  plain(`chain snapshot exported_at=${res.exportedAt} (${res.ageDays.toFixed(2)} days old), source=${res.source}`);
  plain("");
  plain("WHAT THE ACCOUNT BOOK ITSELF RECORDS — measured on THIS cut, not assumed:");
  plain("  type   lines  names a source  states a source LINE  carries FromDocType  FromDocDtlKey");
  for (const [t, s] of Object.entries(res.shape || {})) {
    plain(
      `  ${pad(t, 5)}${rp(s.lines, 7)}${rp(s.withSource, 16)}${rp(s.withSourceLine, 22)}${rp(s.withDocType, 21)}${rp(s.withDocDtlKey, 15)}`,
    );
  }
  plain("");
  plain("  READ THAT TABLE BEFORE READING ANY VERDICT BELOW. `FromDocDtlKey` is the column that would say WHICH");
  plain("  LINE a delivery, invoice or receipt was raised from, and AutoCount leaves it empty on every row of every");
  plain("  detail table. So the source LINE is answerable on ONE edge only — SO->PO, which AutoCount records");
  plain("  differently as FromSODtlKey — and on the other four the book states a source DOCUMENT and nothing finer.");
  plain("  This checker says so instead of comparing at document grain and letting the reader believe it checked");
  plain("  lines. It is re-measured every run: the day the write-back starts filling that column, this table moves.");
  plain("");
  plain("  `carries FromDocType` being 0 for PO is not a fault either. AutoCount stamps no type on the SO->PO edge,");
  plain("  even on a document its own SDK created minutes earlier, while every other edge carries one. A checker");
  plain("  that tested the TYPE would report every purchase order in the book as sourceless.");

  const totals = { differ: 0, unverifiable: 0, notCompared: 0 };

  for (const r of res.rows || []) {
    plain("");
    if (r.skipped) {
      log(`${r.t} TRANSFER CHAIN NOT MEASURED — ${r.skipped}. The axis is ABSENT for this type, not zero.`);
      continue;
    }
    const fromDiffer = FROM_VERDICTS.filter((v) => IS_DIFFERENCE.has(v)).reduce((a, v) => a + r.from[v], 0);
    const fromUnver = FROM_VERDICTS
      .filter((v) => IS_UNANSWERABLE.has(v) && v !== "agree_doc_line_unstated")
      .reduce((a, v) => a + r.from[v], 0);
    const toDiffer = ["erp_low", "erp_high", "erp_asserts_untransferred"].reduce((a, v) => a + r.to[v], 0);
    totals.differ += fromDiffer + toDiffer;
    totals.unverifiable += fromUnver;
    totals.notCompared += r.notCompared;

    plain(`--- ${r.t}`);
    plain(
      `    ${r.erpLines} ERP line(s) read; ${r.unkeyed} carry no AutoCount line key and cannot be asked; ` +
        `${r.keyNotInBook} name a key the book does not have; ${r.cancelledSkipped} sit on a cancelled book document; ` +
        `${r.notCompared} belong to a document THIS RUN DID NOT COMPARE and are left alone`,
    );
    if (r.notCompared) {
      plain(
        `      not compared, so not judged: ${r.notComparedDocs.slice(0, 5).join(", ")}` +
          (r.notComparedDocs.length > 5 ? ` ... ${r.notComparedDocs.length - 5} more document(s)` : ""),
      );
    }
    plain("    TRANSFER FROM — which document the line was raised from");
    for (const v of FROM_VERDICTS) {
      if (!r.from[v]) continue;
      const mark = IS_DIFFERENCE.has(v) ? "  <-- WORK" : "";
      plain(`      ${pad(v, 26)}${rp(r.from[v], 7)}  ${FROM_LABEL[v]}${mark}`);
    }
    plain("    TRANSFER TO — how much of the line has gone on");
    if (r.noCounterNote && !r.counterGroups) {
      plain(`      NOT MEASURED: ${r.noCounterNote}.`);
      plain("      Nothing here was checked and nothing here can drift. Do not read the blank as agreement.");
    } else {
      plain(`      ${r.erpCounter}  vs  ${r.bookCounterField} — ${r.counterLabel}`);
      plain(`      ${r.counterGroups} book line(s) compared as a FRACTION (a sofa is one book line and six ERP rows)`);
      for (const v of TO_VERDICTS) {
        if (!r.to[v]) continue;
        const mark = ["erp_low", "erp_high", "erp_asserts_untransferred"].includes(v) ? "  <-- WORK" : "";
        plain(`      ${pad(v, 26)}${rp(r.to[v], 7)}  ${TO_LABEL[v]}${mark}`);
      }
      if (r.noCounterNote) plain(`      ALSO NOT MEASURED: ${r.noCounterNote}.`);
      printOnwardSplit(r, { plain, log, show });
    }
    for (const ex of r.examples.from.slice(0, show)) {
      plain(`      [${ex.v}] ${ex.ac} (ERP ${ex.erpNo})${ex.proceeded ? " PROCEEDED" : ""} — ${ex.detail}`);
    }
    for (const ex of r.examples.to.slice(0, show)) {
      plain(`      [${ex.v}] ${ex.ac} (ERP ${ex.erpNo})${ex.proceeded ? " PROCEEDED" : ""} — ${ex.detail}`);
    }
  }

  plain("");
  log(
    totals.differ === 0
      ? `TRANSFER CHAIN — 0 line(s) disagree with the account book on where they came from or on how much has ` +
        `gone on. ${totals.unverifiable} could not be compared at all (axis \`${AXIS_UNVERIFIABLE}\`), and ` +
        `${totals.notCompared} sit on documents this run did not compare.`
      : `TRANSFER CHAIN — ${totals.differ} line(s) disagree with the account book (axes \`${AXIS_FROM}\` and ` +
        `\`${AXIS_TO}\`); ${totals.unverifiable} more could not be compared at all (\`${AXIS_UNVERIFIABLE}\`); ` +
        `${totals.notCompared} sit on documents this run did not compare.`,
  );
  plain(
    "NOTHING IS REPAIRED HERE and nothing should be repaired from this table without a plan: a transfer-quantity " +
      "correction moves an on-hand figure, and stock is DEFERRED by the owner (「库存先不看」). A `transfer to` " +
      "difference is a report, not a work order.",
  );
}
