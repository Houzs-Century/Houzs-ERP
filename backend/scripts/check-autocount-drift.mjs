// Read-only DRIFT check: ERP-mastered documents vs the LIVE AutoCount book.
//
// WHY THIS EXISTS. Hard rule 2: the ERP is the only editing surface and the sync
// is one-way — "but staff WILL edit in AutoCount out of habit, so DRIFT
// DETECTION is still required." That is not hypothetical on this book. Measured
// read-only over ODBC on 2026-08-11: SO-013175 was created by staff directly in
// AutoCount on 2026-08-10, and the newest LastModified in five of the six
// document tables is inside the last four days.
//
// Hard rule 3 is the other half: "a cancel on one side only splits the
// outstanding set." Section 3 is that acceptance test, run as a query.
//
// WHAT IT COMPARES. Only documents the ERP MASTERS — those carrying a
// linked_ac_docno, i.e. ones the write-back actually placed in AutoCount. A
// document the ERP never sent is not drift; it is out of scope, and counting it
// would drown the real signal.
//
// The AutoCount half is a committed snapshot, refreshed by
//   python backend/scripts/export-ac-documents.py
// from a machine on the ZeroTier network. A GitHub runner cannot reach the
// AutoCount host, and the production DSN must not be handed to a human, so the
// two halves necessarily run in two places. Same split as
// check-stock-vs-autocount.mjs, for the same reason.
//
// STRICTLY READ-ONLY on both sides. SELECT only, no writes, no DDL, no
// transaction, and nothing is ever sent to the account book. Exits 0 for every
// legitimate answer — the divergence list IS the output.
//
// A WRONG VALUE IS WORSE THAN A BLANK. Every column this script binds is probed
// against information_schema first; a field it cannot resolve is REPORTED as
// unchecked, never quietly skipped and never guessed at. An unchecked document
// must not read as a clean one.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const TOP = Number(process.env.TOP || 40);
/* AC_DRIFT_DATA_DIR is a TEST SEAM, the same shape as the drain's injected
   client: the integration suite points this at a fixture snapshot so the real
   script — every SELECT, every comparison — is what gets executed. Unset in
   every real run, where the committed snapshot beside this file is the only
   source. It selects an INPUT to read; it cannot make the check write anything. */
const DATA = process.env.AC_DRIFT_DATA_DIR
  || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "data");

const out = (s = "") => console.log(s);
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const pad = (v, n) => String(v ?? "").padEnd(n);
const num = (v, n) => String(v ?? 0).padStart(n);

function readGz(name) {
  try {
    return JSON.parse(gunzipSync(readFileSync(path.join(DATA, name))).toString("utf8"));
  } catch (e) {
    console.error(
      `Cannot read ${name}: ${e?.message ?? e}\n`
      + `Refresh the AutoCount snapshot first, from a machine on the ZeroTier network:\n`
      + `  AC_CRED_FILE=<file> python backend/scripts/export-ac-documents.py\n`
      + `and commit backend/scripts/data/ac-doc-*.`,
    );
    process.exit(1);
  }
}

const acHeaders = readGz("ac-doc-headers.json.gz");
const acLines = readGz("ac-doc-lines.json.gz");
let manifest = {};
try {
  manifest = JSON.parse(readFileSync(path.join(DATA, "ac-doc-export-manifest.json"), "utf8"));
} catch { /* the manifest is provenance, not data — its absence is reported below */ }

/**
 * The six document types, ERP side.
 *
 * `dateCands` / `partyCands` / `refCands` / `totalCands` are CANDIDATE column
 * names, resolved against information_schema at run time. The six tables were
 * built at different times by different migrations and do not share a
 * vocabulary; hard-coding a name that has since drifted would fail the whole
 * query with 42703, or — far worse — bind a column that exists but means
 * something else.
 *
 * `totalCands` LISTS ONLY `*_centi` COLUMNS, and that is load-bearing rather
 * than cosmetic: the comparison in section 4 divides the ERP value by 100 to
 * reach AutoCount's currency units. Binding a column that is already in
 * currency units would make every document look 100x wrong — a wrong value,
 * which is worse than the blank this check used to print.
 *
 * `refCands` is realistically SO-only: composeCreateSo/composeEdit send `Ref`
 * from mfg_sales_orders.ref, and composePoState documents that a purchase order
 * has no such field. A type that binds nothing simply is not ref-checked, which
 * is correct — the ERP never claimed that field, so AutoCount's own value there
 * is not drift.
 */
const DOCS = [
  { docType: "SO", table: "mfg_sales_orders", noCol: "doc_no",
    dateCands: ["so_date", "doc_date"], partyCands: ["debtor_name", "customer_name"],
    refCands: ["ref"], totalCands: ["total_centi", "amount_centi"],
    itemTable: "mfg_sales_order_items", itemFk: "doc_no", itemFkIsDocNo: true },
  { docType: "PO", table: "purchase_orders", noCol: "po_number",
    dateCands: ["po_date", "doc_date"], partyCands: ["creditor_name", "supplier_name"],
    refCands: [], totalCands: ["total_centi", "amount_centi"],
    itemTable: "purchase_order_items", itemFk: "purchase_order_id", itemFkIsDocNo: false },
  { docType: "DO", table: "delivery_orders", noCol: "doc_no",
    dateCands: ["do_date", "doc_date", "delivery_date"], partyCands: ["debtor_name", "customer_name"],
    refCands: ["ref"], totalCands: ["total_centi", "amount_centi"] },
  { docType: "GR", table: "grns", noCol: "doc_no",
    dateCands: ["grn_date", "doc_date", "received_date"], partyCands: ["creditor_name", "supplier_name"],
    refCands: [], totalCands: ["total_centi", "amount_centi"] },
  { docType: "IV", table: "sales_invoices", noCol: "doc_no",
    dateCands: ["invoice_date", "doc_date"], partyCands: ["debtor_name", "customer_name"],
    refCands: ["ref"], totalCands: ["total_centi", "amount_centi"] },
  { docType: "PI", table: "purchase_invoices", noCol: "doc_no",
    dateCands: ["invoice_date", "doc_date"], partyCands: ["creditor_name", "supplier_name"],
    refCands: [], totalCands: ["total_centi", "amount_centi"] },
];

/* See check-ac-outbox-health.mjs: TLS everywhere except a local test container,
   which does not offer it. A production DSN can never silently downgrade. */
const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname);
const pg = postgres(url, { ssl: isLocal ? false : "require", prepare: false, max: 1 });

const norm = (s) => String(s ?? "").trim().toUpperCase();
const dayOf = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

let worst = "OK";
const verdict = [];
const escalate = (lvl) => {
  const rank = { OK: 0, ATTENTION: 1, ALARM: 2 };
  if (rank[lvl] > rank[worst]) worst = lvl;
};

try {
  out("=".repeat(78));
  out("AUTOCOUNT DRIFT CHECK — ERP-mastered documents vs the live account book");
  out("=".repeat(78));
  if (manifest.exported_at) {
    out(`  AutoCount snapshot : ${manifest.exported_at}  (${manifest.database} @ ${manifest.host})`);
    out(`  line cutoff        : ${manifest.line_cutoff}`);
    const ageDays = (Date.now() - new Date(manifest.exported_at).getTime()) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays > 7) {
      out(`  WARNING: the snapshot is ${ageDays.toFixed(1)} days old. Drift found here may`);
      out("  already be stale, and drift created since is invisible. Re-export first.");
      escalate("ATTENTION");
      verdict.push(`AutoCount snapshot is ${ageDays.toFixed(1)} days old — re-export before trusting a clean result.`);
    }
  } else {
    out("  WARNING: no export manifest — the snapshot's age and origin are unknown.");
    escalate("ATTENTION");
    verdict.push("AutoCount snapshot has no manifest; its age cannot be established.");
  }
  out();

  // Index the AutoCount side by document number, per type.
  const acByNo = {};
  for (const [t, rows] of Object.entries(acHeaders)) {
    acByNo[t] = new Map(rows.map((r) => [norm(r.DocNo), r]));
  }
  const acLinesByNo = {};
  for (const [t, rows] of Object.entries(acLines)) {
    const m = new Map();
    for (const r of rows) {
      const k = norm(r.DocNo);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    acLinesByNo[t] = m;
  }

  // Resolve every ERP column ONCE, and say what was bound.
  out("=".repeat(78));
  out("SECTION 0 — COLUMN BINDING (probed, not assumed)");
  out("=".repeat(78));
  const bound = [];
  for (const d of DOCS) {
    const cols = await pg`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'scm' AND table_name = ${d.table}`;
    const have = new Set(cols.map((c) => c.column_name));
    if (!have.size) {
      out(`  ${pad(d.docType, 4)} ${pad(d.table, 20)} NOT CHECKED — table not found`);
      escalate("ATTENTION");
      verdict.push(`${d.table}: table not found, drift unchecked.`);
      continue;
    }
    if (!have.has("linked_ac_docno") || !have.has(d.noCol)) {
      out(`  ${pad(d.docType, 4)} ${pad(d.table, 20)} NOT CHECKED — no linked_ac_docno or ${d.noCol}`);
      escalate("ATTENTION");
      verdict.push(`${d.table}: no linked_ac_docno, drift unchecked.`);
      continue;
    }
    const dateCol = d.dateCands.find((c) => have.has(c)) ?? null;
    const partyCol = d.partyCands.find((c) => have.has(c)) ?? null;
    const refCol = (d.refCands ?? []).find((c) => have.has(c)) ?? null;
    const totalCol = (d.totalCands ?? []).find((c) => have.has(c)) ?? null;
    const statusCol = have.has("status") ? "status" : null;
    bound.push({ ...d, dateCol, partyCol, refCol, totalCol, statusCol, have });
    out(`  ${pad(d.docType, 4)} ${pad(d.table, 20)} date=${pad(dateCol ?? "(none)", 16)}`
      + `party=${pad(partyCol ?? "(none)", 16)}status=${pad(statusCol ?? "(none)", 8)}`
      + `ref=${pad(refCol ?? "(none)", 8)}total=${totalCol ?? "(none)"}`);
    if (!statusCol) {
      escalate("ATTENTION");
      verdict.push(`${d.table}: no status column — cancel parity cannot be checked for ${d.docType}.`);
    }
    /* Money is the most consequential drift there is, so a type whose total
       cannot be bound must SAY so. Section 4 used to reference a `totalCol`
       that was never defined on any type, which meant the document-total
       comparison silently never ran while the section header advertised it —
       a check claiming coverage it did not have. Unchecked never reads as
       clean here. */
    if (!totalCol) {
      escalate("ATTENTION");
      verdict.push(`${d.table}: no *_centi total column — document-total drift UNCHECKED for ${d.docType}.`);
    }
  }
  out();

  // ── 1. scope ─────────────────────────────────────────────────────────────
  out("=".repeat(78));
  out("SECTION 1 — SCOPE (documents the ERP masters in AutoCount)");
  out("=".repeat(78));
  const linked = {};
  let scopeTotal = 0;
  for (const d of bound) {
    const rows = await pg`
      SELECT ${pg(d.noCol)}::text                                       AS erp_no,
             linked_ac_docno                                            AS ac_no,
             ${d.statusCol ? pg(d.statusCol) : pg`NULL`}                AS status,
             ${d.dateCol ? pg(d.dateCol) : pg`NULL`}                    AS doc_date,
             ${d.partyCol ? pg(d.partyCol) : pg`NULL`}                  AS party,
             ${d.refCol ? pg(d.refCol) : pg`NULL`}                      AS doc_ref,
             ${d.totalCol ? pg(d.totalCol) : pg`NULL`}                  AS doc_total
        FROM scm.${pg(d.table)}
       WHERE linked_ac_docno IS NOT NULL`;
    linked[d.docType] = rows;
    scopeTotal += rows.length;
    out(`  ${pad(d.docType, 4)} ${pad(d.table, 22)} ${num(rows.length, 7)} AutoCount-linked`);
  }
  out();
  out(`  TOTAL IN SCOPE: ${scopeTotal} document(s).`);
  if (scopeTotal === 0) {
    out();
    out("  Nothing to compare. No ERP document carries a linked_ac_docno, which means");
    out("  the write-back has never successfully placed a document in AutoCount. Drift");
    out("  is not measurable until it has. This is a REPORT, not a pass: it says the");
    out("  check found nothing to check, not that the two systems agree.");
  }
  out();

  // ── 2. broken links ──────────────────────────────────────────────────────
  out("=".repeat(78));
  out("SECTION 2 — BROKEN LINKS (ERP points at a document AutoCount does not have)");
  out("=".repeat(78));
  let broken = 0;
  for (const d of bound) {
    for (const r of linked[d.docType] ?? []) {
      if (!acByNo[d.docType]?.has(norm(r.ac_no))) {
        if (broken < TOP) {
          out(`  ${pad(d.docType, 4)} ERP ${pad(r.erp_no, 18)} -> AutoCount ${pad(r.ac_no, 18)} NOT FOUND`);
        }
        broken += 1;
      }
    }
  }
  if (broken === 0) out("  None. Every linked_ac_docno resolves to a real AutoCount document.");
  else {
    out(`  ${broken} broken link(s).`);
    escalate("ALARM");
    verdict.push(`${broken} ERP document(s) point at an AutoCount document that does not exist.`);
  }
  out();

  // ── 3. CANCEL PARITY — the owner's hard rule 3, as a test ────────────────
  //
  // "Cancel must not diverge. A cancel on one side only splits the outstanding
  // set." The owner's outstanding rule is "NOT converted to DO and NOT to IV,
  // cancelled excluded" — so a document cancelled on one side and live on the
  // other makes the two systems' outstanding sets differ by exactly that
  // document. This is the acceptance test, and it is the reason SI and PI
  // cancel being unwired on the ERP side matters.
  out("=".repeat(78));
  out("SECTION 3 — CANCEL PARITY (hard rule 3)");
  out("=".repeat(78));
  let cancelDiv = 0;
  for (const d of bound) {
    if (!d.statusCol) continue;
    for (const r of linked[d.docType] ?? []) {
      const ac = acByNo[d.docType]?.get(norm(r.ac_no));
      if (!ac) continue; // already reported in section 2
      const erpCancelled = norm(r.status) === "CANCELLED";
      if (erpCancelled !== ac.Cancelled) {
        if (cancelDiv < TOP) {
          out(`  ${pad(d.docType, 4)} ${pad(r.erp_no, 18)} / ${pad(r.ac_no, 18)}`
            + `  ERP=${erpCancelled ? "CANCELLED" : norm(r.status) || "(live)"}`
            + `  AutoCount=${ac.Cancelled ? "CANCELLED" : "live"}`);
        }
        cancelDiv += 1;
      }
    }
  }
  if (cancelDiv === 0) {
    out("  None. Every AutoCount-linked document has the same cancelled state on both sides.");
  } else {
    out(`  ${cancelDiv} document(s) cancelled on ONE side only.`);
    escalate("ALARM");
    verdict.push(
      `${cancelDiv} document(s) cancelled on one side only — the owner's outstanding rule `
      + `computes DIFFERENTLY on the two systems by exactly these.`,
    );
  }
  out();

  // ── 4. header field drift ────────────────────────────────────────────────
  out("=".repeat(78));
  out("SECTION 4 — HEADER FIELD DRIFT (date, party name, ref, document total)");
  out("=".repeat(78));
  let hdrDiv = 0;
  for (const d of bound) {
    for (const r of linked[d.docType] ?? []) {
      const ac = acByNo[d.docType]?.get(norm(r.ac_no));
      if (!ac) continue;
      const diffs = [];
      if (d.dateCol && r.doc_date && dayOf(r.doc_date) !== dayOf(ac.DocDate)) {
        diffs.push(`date ERP=${dayOf(r.doc_date)} AC=${dayOf(ac.DocDate)}`);
      }
      if (d.partyCol && r.party && norm(r.party) !== norm(ac.PartyName)) {
        diffs.push(`party ERP="${r.party}" AC="${ac.PartyName}"`);
      }
      /* Only when the ERP HAS a ref. composeCreateSo sends one; a blank ERP ref
         means the ERP never claimed that field, and AutoCount's own value is
         not drift. */
      if (d.refCol && r.doc_ref && norm(r.doc_ref) !== norm(ac.Ref)) {
        diffs.push(`ref ERP="${r.doc_ref}" AC="${ac.Ref}"`);
      }
      /* The money. A document whose total differs between the two systems is
         the most consequential drift there is, and the cheapest to detect. */
      if (d.totalCol && r.doc_total != null
          && Math.abs(Number(r.doc_total) / 100 - Number(ac.NetTotal ?? 0)) > 0.005) {
        diffs.push(`total ERP=${(Number(r.doc_total) / 100).toFixed(2)} AC=${Number(ac.NetTotal).toFixed(2)}`);
      }
      if (diffs.length) {
        if (hdrDiv < TOP) out(`  ${pad(d.docType, 4)} ${pad(r.erp_no, 18)} ${diffs.join("; ")}`);
        hdrDiv += 1;
      }
    }
  }
  if (hdrDiv === 0) out("  None.");
  else {
    out(`  ${hdrDiv} document(s) whose header fields disagree.`);
    escalate("ATTENTION");
    verdict.push(`${hdrDiv} document(s) with header field drift.`);
  }
  out();

  // ── 5. edited in AutoCount AFTER the ERP last wrote ───────────────────────
  //
  // THE HABIT SIGNAL, and the direct answer to hard rule 2. sent_at is when the
  // write-back last touched that document; a LastModified later than that is
  // somebody editing in AutoCount after the ERP had its say.
  //
  // LastModified alone proves nothing — 12,105 of 13,015 SOs in this book carry
  // one later than their CreatedTimeStamp, because that is what normal AutoCount
  // use looks like. It is only evidence when compared against OUR write.
  out("=".repeat(78));
  out("SECTION 5 — EDITED IN AUTOCOUNT AFTER THE ERP LAST WROTE");
  out("=".repeat(78));
  const sent = await pg`
    SELECT doc_type, ac_doc_no, max(sent_at) AS last_sent
      FROM scm.autocount_outbox
     WHERE status = 'sent' AND ac_doc_no IS NOT NULL AND sent_at IS NOT NULL
     GROUP BY doc_type, ac_doc_no`;
  if (sent.length === 0) {
    out("  No document has ever been successfully written to AutoCount by the ERP");
    out("  (no 'sent' outbox row carries an AutoCount document number), so there is");
    out("  no 'after we wrote' to measure against. UNCHECKED, not clean.");
  } else {
    let edited = 0;
    for (const s of sent) {
      const ac = acByNo[s.doc_type]?.get(norm(s.ac_doc_no));
      if (!ac || !ac.LastModified) continue;
      // 60s of slack: AutoCount stamps LastModified inside the same Save the SDK
      // performs, so our own write lands a beat after sent_at.
      if (new Date(ac.LastModified).getTime() > new Date(s.last_sent).getTime() + 60_000) {
        if (edited < TOP) {
          out(`  ${pad(s.doc_type, 4)} ${pad(s.ac_doc_no, 18)} ERP wrote ${new Date(s.last_sent).toISOString()}`
            + `  AutoCount modified ${ac.LastModified} by ${ac.LastModifiedUserID || "(unknown)"}`);
        }
        edited += 1;
      }
    }
    if (edited === 0) {
      out(`  None. All ${sent.length} ERP-written document(s) are untouched since the ERP wrote them.`);
    } else {
      out(`  ${edited} of ${sent.length} ERP-written document(s) were edited in AutoCount afterwards.`);
      escalate("ALARM");
      verdict.push(
        `${edited} document(s) edited in AutoCount after the ERP wrote them — the ERP is `
        + `no longer master for these.`,
      );
    }
  }
  out();

  // ── 6. line drift, where line identity exists ────────────────────────────
  //
  // Keyed on linked_ac_dtlkey, which exists only on the SO and PO line tables
  // (migration 0273). Without a key there is no line identity, and matching by
  // position would be a guess — so those documents are REPORTED as unchecked.
  out("=".repeat(78));
  out("SECTION 6 — LINE DRIFT (qty / price, keyed on linked_ac_dtlkey)");
  out("=".repeat(78));
  let lineDiv = 0;
  let lineUnchecked = 0;
  let lineChecked = 0;
  for (const d of bound.filter((x) => x.itemTable)) {
    const hasKey = await pg`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'scm' AND table_name = ${d.itemTable}
         AND column_name = 'linked_ac_dtlkey'`;
    if (!hasKey[0].n) {
      out(`  ${pad(d.docType, 4)} ${d.itemTable}: NOT CHECKED — no linked_ac_dtlkey column`);
      continue;
    }
    for (const r of linked[d.docType] ?? []) {
      const acl = acLinesByNo[d.docType]?.get(norm(r.ac_no));
      if (!acl) {
        // Outside the snapshot's line window. Reported, never assumed clean.
        lineUnchecked += 1;
        continue;
      }
      const erpLines = d.itemFkIsDocNo
        ? await pg`
            SELECT linked_ac_dtlkey AS k, qty, unit_price_centi
              FROM scm.${pg(d.itemTable)}
             WHERE ${pg(d.itemFk)}::text = ${r.erp_no} AND linked_ac_dtlkey IS NOT NULL`
        : await pg`
            SELECT i.linked_ac_dtlkey AS k, i.qty, i.unit_price_centi
              FROM scm.${pg(d.itemTable)} i
              JOIN scm.${pg(d.table)} h ON h.id = i.${pg(d.itemFk)}
             WHERE h.${pg(d.noCol)}::text = ${r.erp_no} AND i.linked_ac_dtlkey IS NOT NULL`;
      if (!erpLines.length) { lineUnchecked += 1; continue; }
      const byKey = new Map(acl.map((l) => [Number(l.DtlKey), l]));
      for (const el of erpLines) {
        lineChecked += 1;
        const al = byKey.get(Number(el.k));
        if (!al) {
          if (lineDiv < TOP) out(`  ${pad(d.docType, 4)} ${pad(r.erp_no, 18)} DtlKey ${el.k} not in AutoCount`);
          lineDiv += 1;
          continue;
        }
        const qtyDiff = Math.abs(Number(el.qty ?? 0) - Number(al.Qty ?? 0)) > 0.0001;
        // unit_price_centi is cents; AutoCount UnitPrice is currency units.
        const priceDiff = Math.abs(Number(el.unit_price_centi ?? 0) / 100 - Number(al.UnitPrice ?? 0)) > 0.005;
        if (qtyDiff || priceDiff) {
          if (lineDiv < TOP) {
            out(`  ${pad(d.docType, 4)} ${pad(r.erp_no, 18)} DtlKey ${el.k}`
              + (qtyDiff ? ` qty ERP=${el.qty} AC=${al.Qty}` : "")
              + (priceDiff ? ` price ERP=${(Number(el.unit_price_centi) / 100).toFixed(2)} AC=${al.UnitPrice}` : ""));
          }
          lineDiv += 1;
        }
      }
    }
  }
  out(`  lines compared ......... ${lineChecked}`);
  out(`  documents unchecked .... ${lineUnchecked}  (no stored line key, or outside the snapshot window)`);
  if (lineDiv === 0) out("  No line drift among the lines that could be compared.");
  else {
    out(`  ${lineDiv} line(s) disagree.`);
    escalate("ALARM");
    verdict.push(`${lineDiv} line(s) whose qty or price disagree between the two systems.`);
  }
  if (lineUnchecked > 0) {
    escalate("ATTENTION");
    verdict.push(`${lineUnchecked} document(s) had NO comparable lines — unchecked, not clean.`);
  }
  out();

  // ── VERDICT ──────────────────────────────────────────────────────────────
  out("=".repeat(78));
  if (scopeTotal === 0) {
    notice("VERDICT: NOT MEASURABLE — no ERP document is linked to AutoCount yet, so "
      + "there is nothing to compare. This is not a pass.");
  } else if (worst === "OK") {
    notice(`VERDICT: OK — ${scopeTotal} ERP-mastered document(s) agree with the live account book.`);
  } else {
    notice(`VERDICT: ${worst} — ${scopeTotal} document(s) in scope.`);
    for (const v of verdict) notice(`  - ${v}`);
  }
} catch (e) {
  console.error("check-autocount-drift FAILED:", e?.message ?? e);
  await pg.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}

await pg.end({ timeout: 5 });
process.exit(0);
