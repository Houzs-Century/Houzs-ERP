/* cleared-arrived-plan — which cleared documents on the AutoCount Sync page have
 * since reached AutoCount, and so belong back on the list as arrived.
 *
 * 白话. 「已清除」是给已经做完的单用的。9 月 10 日有个脚本把一批还没进 AutoCount 的单
 * 也清掉了；后来它们都进去了，但页面还把它们列在「已清除」里，老板看了以为没进。
 * 这里决定哪些单可以放回正常列表：只放「后来确实进了 AutoCount」的单，
 * 并且只动脚本清的，不动人手在页面上清的。
 *
 * docs/bugs/0917. The judgement is the page's own: a document needs attention when
 * its newest refusal is not predated by its newest arrival
 * (`acRefusalPredatesArrival`), with every row's state read by `acOutboxState`,
 * so a re-queued refusal is history. Both are imported, never restated.
 *
 * A refusal filed under the ROW ID of a delivery order or purchase order
 * (docs/bugs/0774) is resolved to that document's number first, so it is judged
 * with the rest of its document. The re-filing is part of the plan.
 *
 * PURE. The caller reads the rows and the id -> number map; this decides.
 * NO SHEBANG: a test imports this module.
 */
import { acOutboxState, acRefusalPredatesArrival, AC_SKIP_KINDS } from "../../src/scm/lib/autocount-outbox-status.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* A document CANCELLED before its create ever sent is finished, not stuck: the
 * create was skipped, nothing reached the book and nothing ever will, so it may
 * be cleared like any done document. docs/bugs/0917 held it only because the
 * generic "a refusal nothing arrived after" test cannot tell a void document
 * from an open one. Reason text is the skip catalogue's own; matched
 * truncation-proof, because the stored last_error equals the needle and the
 * caller passes a left(...) of it, so any prefix identifies it. */
const CANCELLED_BEFORE_SEND_NEEDLE =
  AC_SKIP_KINDS.find((k) => k.kind === "cancelled-before-send").needle;
const isCancelledBeforeSend = (errorHead) =>
  typeof errorHead === "string" && errorHead.length >= 12
  && CANCELLED_BEFORE_SEND_NEEDLE.startsWith(errorHead);

export const HELD = Object.freeze({
  person: "cleared by a person on the page — left as it is",
  sending: "a send is still waiting — look again after it drains",
  neverArrived: "it has never reached AutoCount",
  refusedSince: "it was refused after it last reached AutoCount",
  unresolvedId: "filed under an id no document of this type carries",
});

/**
 * @param {Array<{ id: string, doc_type: string, doc_no: string, status: string, error_head: string | null,
 *                 created_at: string, archived_at: string | null, archived_by: number | string | null }>} rows
 *   EVERY queue row of the company for the documents in question, cleared or not
 * @param {Map<string, string>} numberOfId  `${doc_type}|${uuid}` -> document number
 * @param {ReadonlySet<string>} named  document numbers the operator named. A
 *   document a PERSON cleared is restored only when named here (the owner asked
 *   for HC-SO-013361, -013393 and -013394 on 2026-09-15); it must still have
 *   arrived. Pass an empty set to restore only what a script cleared.
 */
export function planClearedArrivals(rows, numberOfId, named) {
  const numberOf = (r) => (UUID.test(String(r.doc_no)) ? numberOfId.get(`${r.doc_type}|${String(r.doc_no).toLowerCase()}`) ?? null : r.doc_no);
  const docs = new Map();
  const unresolved = [];
  for (const r of rows) {
    const n = numberOf(r);
    if (n == null) {
      if (r.archived_at) unresolved.push(r);
      continue;
    }
    const k = `${r.doc_type}|${n}`;
    docs.set(k, [...(docs.get(k) ?? []), r]);
  }

  const restore = [];
  const held = unresolved.map((r) => ({ docType: r.doc_type, docNo: r.doc_no, reason: HELD.unresolvedId }));
  for (const [k, list] of docs) {
    const [docType, docNo] = k.split("|");
    const byScript = list.filter((r) => r.archived_at && (r.archived_by == null || named.has(docNo)));
    if (!byScript.length) {
      if (list.some((r) => r.archived_at)) held.push({ docType, docNo, reason: HELD.person });
      continue;
    }
    if (list.some((r) => r.status === "pending")) { held.push({ docType, docNo, reason: HELD.sending }); continue; }
    let arrived = null;
    let refused = null;
    for (const r of list) {
      const state = acOutboxState(String(r.status), r.error_head);
      if (state === "sent" && (!arrived || r.created_at > arrived)) arrived = r.created_at;
      if ((state === "failed" || state === "skipped") && (!refused || r.created_at > refused)) refused = r.created_at;
    }
    if (!arrived) { held.push({ docType, docNo, reason: HELD.neverArrived }); continue; }
    if (refused && !acRefusalPredatesArrival(refused, arrived)) { held.push({ docType, docNo, reason: HELD.refusedSince }); continue; }
    restore.push({
      docType,
      docNo,
      rowIds: byScript.map((r) => r.id).sort(),
      refile: byScript.filter((r) => r.doc_no !== docNo).map((r) => ({ id: r.id, from: r.doc_no, to: docNo })),
    });
  }
  restore.sort((a, b) => `${a.docType}|${a.docNo}`.localeCompare(`${b.docType}|${b.docNo}`));
  return { restore, held };
}

/** May this document be cleared at all? The same judgement, for the archive script. */
export function clearVerdict(rows) {
  if (!rows.length) return "no rows";
  if (rows.some((r) => r.status === "pending")) return HELD.sending;
  /* A cancelled-before-send document is done — clear it like any finished one. */
  if (rows.some((r) => acOutboxState(String(r.status), r.error_head) === "skipped"
        && isCancelledBeforeSend(r.error_head))) return null;
  let arrived = null;
  let refused = null;
  for (const r of rows) {
    const state = acOutboxState(String(r.status), r.error_head);
    if (state === "sent" && (!arrived || r.created_at > arrived)) arrived = r.created_at;
    if ((state === "failed" || state === "skipped") && (!refused || r.created_at > refused)) refused = r.created_at;
  }
  if (refused && !(arrived && acRefusalPredatesArrival(refused, arrived))) return "it has a refusal nothing has reached AutoCount after";
  return null;
}
