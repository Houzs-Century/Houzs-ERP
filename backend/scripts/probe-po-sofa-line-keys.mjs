#!/usr/bin/env node
/* probe-po-sofa-line-keys — READ-ONLY. What our PURCHASE ORDER rows actually
 * hold, beside the AutoCount line the book raised them from.
 *
 * ── WHY IT EXISTS, AND WHY NOT ONE OF THE FIVE PROBES THAT ALREADY DO THIS ──
 * `apply-sofa-compartment-corrections.mjs` refuses five received purchase orders
 * with one sentence each, measured on prod 2026-09-09 (run 34315871343):
 *
 *   HC-PO-009467: no line matches line key(s) 861768 (the document does not
 *   carry 861768 - the build is not on this document, and matching by text
 *   instead would write it onto the wrong line) - skipped
 *
 * The book DOES carry that key: `PO-009467 / DtlKey 861768 / HOK-5530 SOFA`,
 * read off the live book the same day. So the question is what OUR row holds
 * instead, and four other tools were asked first and each answered a different
 * question:
 *
 *   probe-sofa-collapsed-1s-cause  - class N on the PO side is ZERO, so these
 *                                    are not undecomposed placeholders
 *   backfill-ac-sofa-line-keys     - SALES ORDERS only; its own header says
 *                                    "purchase orders are this lane's control"
 *   repair-sofa-added-compartment-line-key - 0 rows to stamp
 *   probe-book-line-gaps           - printed nothing for all five
 *
 * Four negatives are not an answer. This prints the rows.
 *
 * ── IT COMPARES NOTHING AND DECIDES NOTHING ─────────────────────────────────
 * `check-ac-erp-reconcile.mjs` is the only thing here that may call two values
 * different; a second opinion about "different" is docs/bugs/0708. This prints
 * two sides and draws no conclusion.
 *
 * Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
 * legitimate answer including "no such document" - a red job reads as "the
 * probe broke". Only an unreachable database exits non-zero.
 *
 * RE-RUN: safe, and it is a snapshot.
 *
 *   DOCS=HC-PO-009467,HC-PO-009554 node scripts/probe-po-sofa-line-keys.mjs
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const DOCS = (process.env.DOCS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!DOCS.length) { console.error("REFUSED: set DOCS. This probe reads NAMED documents; it never sweeps."); process.exit(2); }

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

/* The book side is the committed cut, the same file the reconcile compares
   against — not a second read of AutoCount, which a CI runner has no route to
   anyway. Its own timestamp is printed so an answer can never be quoted without
   the vintage it came from. */
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

async function main() {
  const truth = gz("ac-reconcile-truth.json.gz");
  log(`book snapshot ${truth.exported_at ?? truth.exportedAt ?? "(no stamp)"} · company ${CO} · ${DOCS.length} purchase order(s)`);

  const bookLines = new Map(); // docNo -> [lines]
  for (const l of (truth.PO?.lines ?? [])) {
    const d = String(l.docNo ?? l.DocNo ?? "").trim();
    if (!bookLines.has(d)) bookLines.set(d, []);
    bookLines.get(d).push(l);
  }

  for (const doc of DOCS) {
    log("");
    log(`════════ ${doc} ════════`);
    const [hdr] = await sql`SELECT id, po_number, linked_ac_docno, status
                              FROM scm.purchase_orders
                             WHERE company_id = ${CO} AND (po_number = ${doc} OR linked_ac_docno = ${doc.replace(/^HC-/, "")})
                             LIMIT 1`;
    if (!hdr) { log("  the ERP holds no purchase order under this number"); continue; }
    log(`  ERP header: ${hdr.po_number} · status ${hdr.status} · linked_ac_docno ${hdr.linked_ac_docno ?? "(none)"}`);

    const rows = await sql`SELECT id, item_code, item_group, qty, linked_ac_dtlkey, description2
                             FROM scm.purchase_order_items
                            WHERE purchase_order_id = ${hdr.id}
                            ORDER BY id`;
    log(`  ERP lines: ${rows.length} (${rows.filter((r) => r.item_group === "sofa").length} tagged item_group='sofa')`);
    for (const r of rows) {
      log(`    ${String(r.item_code).padEnd(26)} group=${String(r.item_group ?? "(null)").padEnd(10)} qty=${String(r.qty).padEnd(6)} key=${r.linked_ac_dtlkey ?? "(NONE)"}`);
    }

    const bk = bookLines.get(String(hdr.linked_ac_docno ?? doc.replace(/^HC-/, "")).trim()) ?? [];
    log(`  book lines: ${bk.length}`);
    for (const l of bk) {
      log(`    ${String(l.itemCode ?? l.ItemCode ?? "(none)").padEnd(26)} dtlKey=${String(l.dtlKey ?? l.DtlKey ?? "?").padEnd(10)} qty=${l.qty ?? l.Qty ?? "?"}`);
    }

    const erpKeys = new Set(rows.map((r) => (r.linked_ac_dtlkey == null ? null : String(r.linked_ac_dtlkey).trim())).filter(Boolean));
    const bkKeys = new Set(bk.map((l) => String(l.dtlKey ?? l.DtlKey ?? "").trim()).filter(Boolean));
    const onlyBook = [...bkKeys].filter((k) => !erpKeys.has(k));
    const onlyErp = [...erpKeys].filter((k) => !bkKeys.has(k));
    log(`  keys the BOOK has and we do not: ${onlyBook.length ? onlyBook.join(", ") : "none"}`);
    log(`  keys WE have and the book does not: ${onlyErp.length ? onlyErp.join(", ") : "none"}`);
  }

  log("");
  log("Read-only: every statement was a SELECT, no transaction was opened and nothing was written.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(2); });
