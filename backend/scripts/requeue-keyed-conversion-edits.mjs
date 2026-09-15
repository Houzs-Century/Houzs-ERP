#!/usr/bin/env node
/* requeue-keyed-conversion-edits — send again the delivery order and goods
 * receipt edits AutoCount's write-back refused for a keyless line, once every
 * line of the document carries its key.
 *
 * 白话. 之前 DO / GR 因为「行没对上号」被拦住的修改，现在行号补回去了（stamp-conversion-line-keys），
 * 但被拦的那一次修改不会自己再送。这个脚本找出「每一行都已经有账本行号、而且之后没有再送过」的单，
 * 用系统自己的送单程序重新排队一次。还有行没对上号的，只列出来，不送。
 *
 * ── WHY IT IS NEEDED ───────────────────────────────────────────────────────
 * A refused edit is a `skipped` outbox row with an empty body; nothing re-sends
 * it. The documented remedy is "fix the cause, save the document again"
 * (autocount-requeue.ts), and the relink sweep queues the keyed edit only on the
 * run that itself closed the last gap — a document keyed by the backlog stamp
 * (docs/bugs/0897) is already complete when the sweep sees it, so it queues
 * nothing. This is that one save, done for the documents that need it.
 *
 * ── WHAT IT CALLS ──────────────────────────────────────────────────────────
 * The Worker's own `enqueueEdit`, imported under `tsx` over `pgrest-shim`, the
 * pattern requeue-autocount-skipped.mjs established: it composes the document
 * AS IT IS NOW and applies every guard the route would. A document the composer
 * still refuses (a sofa, an item code) gets a fresh `skipped` row with that
 * reason, and this run reports it.
 *
 * A LINE THE BOOK NEVER HAD. A goods receipt can carry a row added on the
 * receipt itself — a free pillow, a stool — with no purchase line behind it, so
 * no transfer ever put it in the book and no key will ever exist for it. Such a
 * row is sent as `IsNewLine` (the host appends it, the relink sweep's
 * `declaresNew`, docs/bugs/0817) ONLY when every keyless row of the document has
 * no source pointer AND the book snapshot of that document
 * (data/ac-conversion-line-keys.json.gz, at most two days old) shows every book
 * line already claimed by a keyed row — so nothing in the book could be the
 * same line. Without a fresh snapshot for the document it is held, not guessed.
 *
 * WHAT IT CANNOT CARRY, said plainly. A refused edit's payload is empty, so a
 * line the operator HARD-DELETED in that save is not in the `retire` list of the
 * edit sent now, and stays live in the book. That is the same limit the relink
 * sweep's queued edit has; the plan lists each document so a person can look.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 * MODE defaults to plan and queues nothing. Apply needs CONFIRM. A document is
 * planned only when: its newest keyless-line refusal is not followed by any
 * pending or sent edit, it is not archived, and no line of it is keyless except
 * a line the book never had (above). The
 * result is re-read on a FRESH connection: each document queued must now hold a
 * pending edit whose body names every line by a numeric DtlKey.
 *
 * NAMED DOCUMENTS (DOC_NOS). A receipt can hold a row added on the receipt that
 * never reached the book at all, with no refusal ever recorded: HC-GRN-2609-060
 * to -068 carry free pillows received beside the purchase lines, and their
 * po_to_gr transfer moved only the purchase lines. DOC_NOS plans the named
 * DO / GR documents by the same rules — fully keyed, or keyless only in rows
 * with no source line while every book line is claimed — whether or not a
 * refusal exists.
 *
 * RE-RUN: a second run finds each document's refusal followed by the pending
 * (or sent) edit this run queued, plans nothing and writes nothing. With DOC_NOS,
 * a second run queues one more edit per named document; the rows it declared new
 * carry their keys once the first edit has drained, so the second is a keyed
 * edit that changes nothing.
 *
 * Env: DATABASE_URL (required)   MODE=plan|apply (default plan)
 *      CONFIRM (apply only)      COMPANY_ID (default 1)
 *      DOC_NOS (optional, comma separated: plan exactly these DO / GR documents)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { enqueueEdit } from "../src/scm/lib/autocount-outbox.ts";
import { classifyAcSkip } from "../src/scm/lib/autocount-outbox-status.ts";
import { DOWNSTREAM } from "../src/scm/lib/autocount-convert-lines.ts";
import { pgrestShim } from "./lib/pgrest-shim.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "send the refused delivery order and receipt edits again";
const CONFIRM = (process.env.CONFIRM || "").trim();
const CO = Number(process.env.COMPANY_ID || 1);
const DOC_NOS = [...new Set((process.env.DOC_NOS || "").split(",").map((v) => v.trim()).filter(Boolean))];
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM='${CONFIRM_PHRASE}' — refusing`);
  process.exit(2);
}

const TYPES = ["DO", "GR"];

/* The book's lines per document, from the committed snapshot, when it is fresh
   enough to say "nothing in the book is unclaimed". */
const here = path.dirname(fileURLToPath(import.meta.url));
const snapPath = path.join(here, "data", "ac-conversion-line-keys.json.gz");
const bookLinesOf = (() => {
  if (!fs.existsSync(snapPath)) return () => null;
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapPath)).toString("utf8"));
  if (!((Date.now() - new Date(snap.exported_at).getTime()) / 86400000 <= 2)) return () => null;
  const F = Object.fromEntries(snap.fields.map((f, i) => [f, i]));
  const by = new Map();
  for (const r of snap.rows) {
    const k = `${r[F.docType]}|${r[F.docNo]}`;
    (by.get(k) ?? by.set(k, []).get(k)).push(Number(r[F.toDtlKey]));
  }
  return (type, docNo) => by.get(`${type}|${docNo}`) ?? null;
})();
const startedAt = new Date().toISOString();
const pg = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const refusals = await pg`
  SELECT DISTINCT ON (doc_type, doc_id) doc_type, doc_id, doc_no, last_error, created_at
    FROM scm.autocount_outbox
   WHERE company_id = ${CO} AND op = 'edit' AND status = 'skipped'
     AND doc_type IN ${pg(TYPES)} AND doc_id IS NOT NULL AND archived_at IS NULL
   ORDER BY doc_type, doc_id, created_at DESC`;

const named = DOC_NOS.length ? await pg`
  SELECT 'DO' AS doc_type, id::text AS doc_id, do_number AS doc_no FROM scm.delivery_orders
   WHERE company_id = ${CO} AND do_number IN ${pg(DOC_NOS)} AND status::text <> 'CANCELLED' AND linked_ac_docno IS NOT NULL
  UNION ALL
  SELECT 'GR', id::text, grn_number FROM scm.grns
   WHERE company_id = ${CO} AND grn_number IN ${pg(DOC_NOS)} AND status::text <> 'CANCELLED' AND linked_ac_docno IS NOT NULL` : [];
const unnamed = DOC_NOS.filter((d) => !named.some((n) => n.doc_no === d));

const targets = [];
if (DOC_NOS.length) {
  targets.push(...named);
} else {
  for (const r of refusals) {
    if (classifyAcSkip(r.last_error).kind !== "keyless-line") continue;
    const [{ n: later }] = await pg`
      SELECT count(*)::int AS n FROM scm.autocount_outbox
       WHERE company_id = ${CO} AND doc_type = ${r.doc_type} AND doc_id = ${r.doc_id}
         AND op = 'edit' AND status IN ('pending', 'sent') AND created_at > ${r.created_at}`;
    if (later === 0) targets.push(r);
  }
}

const planned = [];
const held = unnamed.map((d) => `${d}: no such delivery order or goods receipt in AutoCount for this company (or cancelled)`);
for (const r of targets) {
  const spec = DOWNSTREAM[r.doc_type];
  const items = await pg`
    SELECT id::text AS id, linked_ac_dtlkey, ${pg(spec.sourceFk)}::text AS source_row
      FROM ${pg("scm." + spec.itemTable)}
     WHERE ${pg(spec.itemFk)} = ${r.doc_id} AND company_id = ${CO}`;
  const [header] = await pg`
    SELECT ${pg(r.doc_type === "DO" ? "do_number" : "grn_number")} AS doc_no
      FROM ${pg("scm." + spec.table)} WHERE id = ${r.doc_id} AND company_id = ${CO}`;
  const docNo = String(header?.doc_no ?? r.doc_no);
  const label = `${r.doc_type} ${docNo}`;
  const lines = items.length;
  const keylessRows = items.filter((i) => i.linked_ac_dtlkey == null);
  if (lines === 0) { held.push(`${label}: the document has no lines here`); continue; }
  if (keylessRows.length === 0) { planned.push({ docType: r.doc_type, docId: String(r.doc_id), label, lines, newLineIds: [] }); continue; }
  const book = bookLinesOf(r.doc_type, docNo);
  const claimed = new Set(items.filter((i) => i.linked_ac_dtlkey != null).map((i) => Number(i.linked_ac_dtlkey)));
  const neverInBook = keylessRows.every((i) => i.source_row == null) && book != null && book.every((k) => claimed.has(k));
  if (neverInBook) {
    planned.push({ docType: r.doc_type, docId: String(r.doc_id), label, lines, newLineIds: keylessRows.map((i) => i.id) });
    continue;
  }
  held.push(`${label}: ${keylessRows.length} of ${lines} line(s) still carry no AutoCount key`
    + (book == null ? " (no fresh book snapshot for this document)" : ""));
}

notice(DOC_NOS.length
  ? `named documents: ${DOC_NOS.length}`
  : `keyless-line refusals not yet followed by a sent or pending edit: ${planned.length + held.length} document(s)`);
for (const p of planned) {
  console.log(`  ${APPLY ? "queueing" : "would queue"}: ${p.label} (${p.lines} line(s)`
    + (p.newLineIds.length ? `, ${p.newLineIds.length} added as a line the book never had — every book line is already claimed and the row has no source line)` : ", every one keyed)"));
}
for (const h of held) console.log(`  held: ${h}`);
notice(`${APPLY ? "APPLY" : "PLAN"}: ${planned.length} to send again, ${held.length} held back`);

if (!APPLY) {
  notice(`PLAN: nothing queued. Apply with MODE=apply CONFIRM='${CONFIRM_PHRASE}'`);
  await pg.end();
  process.exit(0);
}

const sb = pgrestShim(pg, "scm", { writeback: "enqueue" });
const queued = [];
for (const p of planned) {
  const ok = await enqueueEdit(sb, {
    companyId: CO, docType: p.docType, docId: p.docId, createdBy: null,
    ...(p.newLineIds.length ? { newLineIds: p.newLineIds } : {}),
  });
  if (ok) queued.push(p);
  else console.log(`  not queued: ${p.label} — the composer declined (see its newest skipped row)`);
}
await pg.end();

/* Re-read on a FRESH connection and look at the VALUE: a pending edit created by
   this run whose body names each line by a numeric DtlKey. A count of rows
   would pass for an edit composed with keyless lines. */
const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const rows = queued.length ? await verify`
  SELECT doc_id, payload FROM scm.autocount_outbox
   WHERE company_id = ${CO} AND op = 'edit' AND status IN ('pending', 'sent')
     AND doc_id IN ${verify(queued.map((q) => q.docId))} AND created_at >= ${startedAt}` : [];
await verify.end();
const shapeOk = (payload) => {
  const lines = payload?.body?.Lines;
  return Array.isArray(lines) && lines.length > 0 && lines.every((l) => typeof l.DtlKey === "number" || Boolean(l.IsNewLine));
};
const good = new Set(rows.filter((r) => shapeOk(r.payload)).map((r) => String(r.doc_id)));
const missing = queued.filter((q) => !good.has(q.docId));
if (missing.length) {
  console.error(`verify FAILED: ${missing.length} document(s) have no keyed pending edit from this run: ${missing.map((m) => m.label).join(", ")}`);
  process.exit(1);
}
notice(`APPLIED: ${queued.length} edit(s) queued with every line keyed, verified on a fresh connection; ${planned.length - queued.length} declined by the composer.`);
