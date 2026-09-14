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
 * WHAT IT CANNOT CARRY, said plainly. A refused edit's payload is empty, so a
 * line the operator HARD-DELETED in that save is not in the `retire` list of the
 * edit sent now, and stays live in the book. That is the same limit the relink
 * sweep's queued edit has; the plan lists each document so a person can look.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 * MODE defaults to plan and queues nothing. Apply needs CONFIRM. A document is
 * planned only when: its newest keyless-line refusal is not followed by any
 * pending or sent edit, no line of it is keyless, and it is not archived. The
 * result is re-read on a FRESH connection: each document queued must now hold a
 * pending edit whose body names every line by a numeric DtlKey.
 *
 * RE-RUN: a second run finds each document's refusal followed by the pending
 * (or sent) edit this run queued, plans nothing and writes nothing.
 *
 * Env: DATABASE_URL (required)   MODE=plan|apply (default plan)
 *      CONFIRM (apply only)      COMPANY_ID (default 1)
 */
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
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (APPLY && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM='${CONFIRM_PHRASE}' — refusing`);
  process.exit(2);
}

const TYPES = ["DO", "GR"];
const startedAt = new Date().toISOString();
const pg = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const refusals = await pg`
  SELECT DISTINCT ON (doc_type, doc_id) doc_type, doc_id, doc_no, last_error, created_at
    FROM scm.autocount_outbox
   WHERE company_id = ${CO} AND op = 'edit' AND status = 'skipped'
     AND doc_type IN ${pg(TYPES)} AND doc_id IS NOT NULL AND archived_at IS NULL
   ORDER BY doc_type, doc_id, created_at DESC`;

const planned = [];
const held = [];
for (const r of refusals) {
  if (classifyAcSkip(r.last_error).kind !== "keyless-line") continue;
  const spec = DOWNSTREAM[r.doc_type];
  const [{ n: later }] = await pg`
    SELECT count(*)::int AS n FROM scm.autocount_outbox
     WHERE company_id = ${CO} AND doc_type = ${r.doc_type} AND doc_id = ${r.doc_id}
       AND op = 'edit' AND status IN ('pending', 'sent') AND created_at > ${r.created_at}`;
  if (later > 0) continue;
  const [{ lines, keyless }] = await pg`
    SELECT count(*)::int AS lines, count(*) FILTER (WHERE linked_ac_dtlkey IS NULL)::int AS keyless
      FROM ${pg("scm." + spec.itemTable)}
     WHERE ${pg(spec.itemFk)} = ${r.doc_id} AND company_id = ${CO}`;
  const label = `${r.doc_type} ${String(r.doc_no)}`;
  if (lines === 0) { held.push(`${label}: the document has no lines here`); continue; }
  if (keyless > 0) { held.push(`${label}: ${keyless} of ${lines} line(s) still carry no AutoCount key`); continue; }
  planned.push({ docType: r.doc_type, docId: String(r.doc_id), label, lines });
}

notice(`keyless-line refusals not yet followed by a sent or pending edit: ${planned.length + held.length} document(s)`);
for (const p of planned) console.log(`  ${APPLY ? "queueing" : "would queue"}: ${p.label} (${p.lines} line(s), every one keyed)`);
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
  const ok = await enqueueEdit(sb, { companyId: CO, docType: p.docType, docId: p.docId, createdBy: null });
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
