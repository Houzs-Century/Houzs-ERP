/* ac-verdict-emit — write the per-document verdict OUT, for one type or many.
 *
 * Lifted out of check-ac-erp-reconcile.mjs on 2026-09-08, when the owner asked
 * for purchase orders and goods receipts too (「然后把PO GR也tally掉」) and the
 * file-size ratchet correctly refused to let that file grow past 2,000 lines.
 * That refusal is the reason this is a module and not a bigger block, and it
 * was the right call: emitting a verdict has nothing to do with COMPARING two
 * corpora, which is what the rest of that file does.
 *
 * ── IT DECIDES NOTHING ──────────────────────────────────────────────────────
 * Everything here is already settled by the time it is called. The recorder has
 * the findings, `summaryByType` has the run's own summary rows, and this only
 * serialises them. It never compares a book value to an ERP value and must
 * never learn how — a second implementation of "different" is the failure this
 * repo has paid for three times (docs/bugs/0689, docs/bugs/0708).
 *
 * ── ONE CONSTRUCTION OF THE PAYLOAD ─────────────────────────────────────────
 * `payloadFor` is used by BOTH writers. Two copies of that object is how the
 * sales-order file and a purchase-order file would come to describe the same
 * run differently, which is precisely what the tally lane exists to prevent.
 *
 * ── THE TWO WRITERS ARE NOT THE SAME WRITER ─────────────────────────────────
 * `verdictOut` is the SALES-ORDER path and it is load-bearing elsewhere:
 * publish-so-reconcile-verdict.mjs reads that file and the migrated-sales-order
 * lock shuts documents on it. Its payload and its printed line are unchanged
 * from before this module existed, deliberately — the PO/GR lane must not be
 * able to move the sales-order answer.
 *
 * `verdictDir` is the newer path: one file per type, all from ONE run, plus a
 * uniform machine-readable line per type that check-po-gr-tally.mjs parses back
 * out to prove its own counts. Uniform so the cross-check is one expression
 * rather than one per type.
 *
 * NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
 * Windows vitest reason).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { buildVerdictRows, summariseVerdict } from "./so-verdict-derive.mjs";

/**
 * @param {object} a
 * @param {object} a.recorder            makeVerdictRecorder() instance, already filled
 * @param {number|string} a.companyId
 * @param {string|null} a.snapshotExportedAt
 * @param {Map<string, object>} a.summaryByType   the run's OWN summary row per type
 * @param {string} a.verdictOut          path for the SALES-ORDER payload, or ""
 * @param {string} a.verdictDir          directory for the per-type payloads, or ""
 * @param {string[]} a.verdictTypes      which types `verdictDir` receives
 * @param {number} a.show                offenders to list
 * @param {(s: string) => void} a.plain
 * @param {(s: string) => void} a.log
 */
export function emitVerdicts({
  recorder, companyId, snapshotExportedAt, summaryByType,
  verdictOut, verdictDir, verdictTypes, show, plain, log,
}) {
  const source = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "local";

  const payloadFor = (type, measuredAt, runId) => {
    const rows = buildVerdictRows({ recorder, type, companyId, measuredAt, runId });
    const sum = summariseVerdict(rows);
    return {
      rows,
      sum,
      payload: {
        version: 1,
        type,
        company_id: companyId,
        measured_at: measuredAt,
        run_id: runId,
        snapshot_exported_at: snapshotExportedAt ?? null,
        source,
        summary: sum,
        /* The reconcile's OWN summary row for this type and its OWN presence
           lists, carried so the tally reports state the document / line / SKU /
           quantity / price / money axes without measuring anything themselves.
           publish-so-reconcile-verdict.mjs names the fields it inserts, so
           extra keys here reach no database column. */
        population: summaryByType.get(type) ?? null,
        presence: recorder.presenceFor(type),
        rows,
      },
    };
  };

  if (verdictOut) {
    const measuredAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    const { rows, sum, payload } = payloadFor("SO", measuredAt, runId);
    plain("");
    plain("═══════════ PER-DOCUMENT VERDICT — SALES ORDERS ═══════════");
    log(
      `SO VERDICT — ${sum.docCount} migrated sales orders compared against the book: ` +
        `${sum.cleanCount} match it exactly and would OPEN; ${sum.differCount} still differ and stay LOCKED.`,
    );
    for (const [axis, docs] of sum.perAxis) plain(`   ${axis}: ${docs} document(s)`);
    for (const r of rows.filter((x) => !x.clean).slice(0, show)) {
      plain(`   LOCKED ${r.doc_no} (${r.ac_doc_no}) — ${r.axes.join(", ")}`);
    }
    if (sum.differCount > show) plain(`   ... and ${sum.differCount - show} more`);
    fs.writeFileSync(verdictOut, JSON.stringify(payload, null, 0));
    plain(`   verdict written to ${verdictOut} (${rows.length} rows)`);
  }

  if (verdictDir) {
    fs.mkdirSync(verdictDir, { recursive: true });
    const measuredAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    plain("");
    plain("═══════════ PER-DOCUMENT VERDICT — BY DOCUMENT TYPE ═══════════");
    for (const type of verdictTypes) {
      const { rows, sum, payload } = payloadFor(type, measuredAt, runId);
      /* A type with no rows is NOT written as an empty answer. An absent file
         is read by the checker as "this run never compared that type", which is
         the truth; a zero-row file would read as "compared, and all clean". */
      if (!rows.length) {
        plain(`   ${type}: no compared documents in this run — no verdict file written.`);
        continue;
      }
      const file = path.join(verdictDir, `${type}-verdict.json`);
      fs.writeFileSync(file, JSON.stringify(payload, null, 0));
      log(
        `${type} TALLY VERDICT — ${sum.docCount} documents compared against the book: ` +
          `${sum.cleanCount} match it exactly; ${sum.differCount} still differ.`,
      );
      for (const [axis, docs] of sum.perAxis) plain(`   ${type} ${axis}: ${docs} document(s)`);
      plain(`   ${type} verdict written to ${file} (${rows.length} rows)`);
    }
  }
}
