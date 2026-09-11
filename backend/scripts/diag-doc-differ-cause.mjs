#!/usr/bin/env node
/* diag-doc-differ-cause — WHY does each of these documents differ, split by
 * cause, with the account book's own lines printed beside the finding.
 *
 * READ-ONLY. It opens no database connection of its own and it compares
 * nothing. It RUNS check-ac-erp-reconcile.mjs — SELECTs only, one connection,
 * no DDL, no transaction — exactly the way scripts/check-po-gr-tally.mjs does,
 * reads the machine-readable verdict that run writes, and prints it. There is
 * no MODE=apply and no write path of any kind.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 * The delivery orders' 13 DIFFER had never been split by cause. The tally
 * report names each document and its AXIS — `HC-DO-001604 [PROCEEDED] —
 * transfer from` — and stops there, so the next step was always the same guess:
 * assume the axis name is the cause and sweep the set. A cause-mixed sweep is
 * how a row that was already right gets overwritten, which is why the split has
 * to come BEFORE any repair and why this prints rather than fixes.
 *
 * The reconcile already knows. `buildVerdictRows` writes a `detail` string per
 * document holding every finding it recorded, and NOTHING printed it. So this
 * is not a new measurement — it is the measurement that was being thrown away.
 *
 * ── IT MEASURES NOTHING, AND MUST NEVER LEARN HOW ───────────────────────────
 * check-ac-erp-reconcile.mjs is the only thing in this repo that compares a
 * book value to an ERP value. A second opinion about "different" is the failure
 * documented in docs/bugs/0708 — two copies of the sofa pairing rule answering
 * oppositely about HC-PO-010040 twenty minutes apart. This script reads a
 * verdict and a committed snapshot. It has no ERP query and no comparison.
 *
 * ── THE BOOK'S LINES ARE PRINTED BESIDE THE FINDING, ON PURPOSE ─────────────
 * 2026-09-09, the owner, about documents reported as having no source at all:
 * 「所以基本上model和sofa compartment基本上都有了啊？那为什么你说没有呢？」 A
 * finding that names an axis and no values is a blank he has to fill from
 * memory. The book side comes from the COMMITTED snapshot
 * data/ac-reconcile-truth.json.gz — the same file the reconcile compared
 * against — so the two cannot be reading different books.
 *
 * RE-RUN: identical output for the same snapshot and the same ERP state. It
 * writes nothing, so a second run changes nothing.
 *
 * Usage:
 *   TYPE=DO node scripts/diag-doc-differ-cause.mjs
 *   TYPE=PO DOCS=PO-009828 node scripts/diag-doc-differ-cause.mjs
 *
 *   TYPE     the document type to explain (SO PO GR DO IV PI). Required.
 *   DOCS     optional comma-separated AutoCount or ERP document numbers. When
 *            omitted, every document in the WORK and CANNOT-COMPARE buckets.
 *   BUCKETS  optional: `work`, `unanswerable`, or both (default both).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { decodeSnapshot } from "./lib/ac-scope.mjs";
import { bucketOf, docTypeSpec, tallyVerdict } from "./lib/so-tally-verdict.mjs";
import { CAUSE_LABEL, CAUSE_OWNER } from "./lib/unanswerable-causes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TYPE = String(process.env.TYPE || "").trim().toUpperCase();
const CO = String(process.env.COMPANY_ID || "1");
const WANT = new Set(
  String(process.env.DOCS || "").split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
);
const BUCKETS = new Set(
  String(process.env.BUCKETS || "work,unanswerable").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
);

const p = (m) => console.log(m);
const refuse = (why) => { console.error(`REFUSED: ${why}`); process.exit(2); };

if (!process.env.DATABASE_URL) refuse("DATABASE_URL not set.");
if (!TYPE) refuse("TYPE not set. One of SO PO GR DO IV PI.");
/* A typo must not produce a confident report about nothing. */
const spec = docTypeSpec(TYPE);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-cause-"));
p(`Running check-ac-erp-reconcile.mjs ONCE for ${TYPE} — the comparison. This report measures nothing itself.`);
const run = spawnSync(process.execPath, [path.join(here, "check-ac-erp-reconcile.mjs")], {
  cwd: path.join(here, ".."),
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  env: {
    ...process.env,
    VERDICT_DIR: dir,
    VERDICT_TYPES: TYPE,
    COMPANY_ID: CO,
    /* one notice per line of a 1,300-line log buries the thing this job prints */
    GITHUB_ACTIONS: "",
  },
});
if (run.error) refuse(`could not run the reconcile: ${run.error.message}`);
if (run.status !== 0) {
  console.error(`${run.stdout || ""}${run.stderr || ""}`.split(/\r?\n/).slice(-40).join("\n"));
  refuse(`the reconcile exited ${run.status}. It refuses rather than answering when it cannot compare.`);
}

const file = path.join(dir, `${TYPE}-verdict.json`);
if (!fs.existsSync(file)) refuse(`the reconcile exited 0 and wrote no ${TYPE} verdict. It compared no documents of this type.`);
const payload = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(payload.rows) || !payload.rows.length) refuse(`the ${TYPE} verdict carries zero rows. That is a broken reconcile, not a clean corpus.`);

const v = tallyVerdict(payload);

/* The BOOK, from the same committed snapshot the reconcile compared against. */
const snapPath = path.join(here, "data", "ac-reconcile-truth.json.gz");
const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)));
const book = decodeSnapshot(raw);
const desc2 = new Map();
{
  const [kf, vf] = raw.desc2_fields;
  const idx = Object.fromEntries(raw.desc2_fields.map((n, i) => [n, i]));
  for (const r of raw.types[TYPE]?.desc2 ?? []) desc2.set(String(r[idx[kf]]), r[idx[vf]]);
}

p("");
p(`═════════════ ${spec.headline} — WHY, BY DOCUMENT AND BY CAUSE ═════════════`);
p(`company ${CO} · book snapshot ${payload.snapshot_exported_at ?? "?"} · ${payload.rows.length} document(s) compared`);
p(
  `   IDENTICAL ${v.buckets.identical} · DIFFER ${v.buckets.work} · CANNOT COMPARE ${v.buckets.unanswerable} · ` +
    `book-gap ${v.buckets["book-gap"]}`,
);

/* ── THE CANNOT-COMPARE COLUMN'S CAUSE SPLIT, FIRST ─────────────────────────
   Printed before the per-document walk because it is the answer to "whose is
   this", and a reader who stops after one screen should have that. */
if (v.unanswerableCauses.length) {
  p("");
  p(`─── the ${v.buckets.unanswerable} CANNOT-COMPARE document(s), BY CAUSE — and whose ───`);
  for (const c of v.unanswerableCauses) {
    p(`   ${String(c.docs).padStart(4)} doc(s), ${c.findings} line(s)  [${CAUSE_OWNER[c.cause] ?? "UNNAMED"}]  ${CAUSE_LABEL[c.cause] ?? c.cause}`);
  }
  p(`   documents in that column carrying NO named cause: ${v.uncausedUnanswerable}`);
}

const rows = payload.rows
  .filter((r) => BUCKETS.has(bucketOf(r)))
  .filter((r) => !WANT.size || WANT.has(String(r.doc_no).toUpperCase()) || WANT.has(String(r.ac_doc_no ?? "").toUpperCase()))
  .sort((a, b) => (a.ac_doc_no < b.ac_doc_no ? -1 : 1));

p("");
p(`─── ${rows.length} document(s), each with the reconcile's OWN findings and the book's own lines ───`);
for (const r of rows) {
  const b = bucketOf(r);
  const proceeded = (r.axes_proceeded || []).length > 0;
  p("");
  p(`════════ ${r.doc_no}  (account book ${r.ac_doc_no ?? "—"})  ${b.toUpperCase()}${proceeded ? "  [PROCEEDED]" : ""} ════════`);
  p(`   axes: ${(r.axes || []).join(", ") || "(none)"}`);

  /* THE FINDING, VERBATIM. This is the string the reconcile already built and
     nothing printed; it carries both sides where the comparison had both. */
  if (r.detail) {
    for (const line of String(r.detail).split(/\r?\n/)) if (line.trim()) p(`      ${line.trim()}`);
  } else {
    p("      (the reconcile recorded no detail for this document)");
  }

  /* WHOSE, when it is in the column. */
  const causes = Object.keys(r.notes?.["unanswerable-cause"] ?? {});
  if (b === "unanswerable") {
    if (causes.length) for (const c of causes) p(`   WHOSE: [${CAUSE_OWNER[c] ?? "UNNAMED"}] ${CAUSE_LABEL[c] ?? c}`);
    else p("   WHOSE: no cause recorded upstream — see the cause table above for how it was named");
  }

  /* THE BOOK'S OWN LINES. Not a comparison: one side, labelled as one side. */
  const bl = book[TYPE]?.lines?.get(r.ac_doc_no) ?? [];
  p(`   the account book states ${bl.length} line(s) on this document:`);
  for (const l of bl) {
    const d2 = desc2.get(String(l.dtlKey));
    p(
      `      DtlKey ${l.dtlKey}  ${l.itemKey || "(no item code)"}  qty ${l.qty ?? "—"}  ` +
        `from ${l.fromDocType || "(no type)"} ${l.fromDocNo || "(nothing)"}` +
        (d2 ? `\n         Desc2: ${String(d2).replace(/\r?\n/g, " / ")}` : ""),
    );
  }
}

p("");
p("Read-only: no connection was opened here, the reconcile holds no transaction open, and nothing was written.");
process.exit(0);
