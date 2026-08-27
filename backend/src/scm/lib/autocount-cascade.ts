/* ----------------------------------------------------------------------------
   autocount-cascade — the documents that must reach the account book BEFORE
   this one can.

   WHY THIS FILE EXISTS. Owner, 2026-08-23:
   「按下去会把缺的上游依序补上再送自己 —— 按 SI 就 SO → DO → SI；按 GR 就
     PO → GR；按 PI 就 PO → GR → PI」

   AutoCount builds a delivery order, a goods received or an invoice ONLY by
   carrying an earlier document into it. So a conversion whose parent is not in
   the book cannot go — and today it WAITS for that parent instead of causing
   it. Measured on production 2026-08-23, the oldest waiting row:

     HC-SI-2608-002  do_to_iv  attempts 0
     reason: "waiting: parent has no AutoCount document yet"

   Waiting is correct as a background behaviour. It is the wrong answer to a
   person pressing a button, because nothing they can see will ever change: the
   parent is failed, so nothing re-sends it, so the child waits forever.

   WHAT THIS MODULE DOES, AND WHAT IT DOES NOT. It answers one question —
   "which ancestors are missing from the book, outermost first?" — and it reads
   only. Sending is the caller's job, and keeping the two apart is deliberate:
   the walk is a fact about the documents, the sending is a decision about what
   to do with it, and a module that did both could not be tested without a
   service to call.

   THE STOP CONDITION IS `linked_ac_docno`, NOT the outbox. A document is in the
   account book when it carries the book's own number for itself. An outbox row
   says what we TRIED, which is a different question and the one that was
   already being confused with this one.
   -------------------------------------------------------------------------- */

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client; `sb` is
   `any` throughout the SCM routes, no exported client type. */
type Sb = any;

import { DOWNSTREAM } from './autocount-convert-lines';

/**
 * Why an ancestor has to be sent before its child.
 *
 * `missing` — it is not in the account book at all, so the conversion cannot be
 *   built: AutoCount makes a DO / GR / invoice ONLY by carrying an earlier
 *   document into it.
 * `stale`  — it IS in the book, but the ERP is still holding an edit for it that
 *   never landed. The conversion would then be built from the version the book
 *   holds, which is not the version the operator is looking at.
 */
export type CascadeReason = 'missing' | 'stale';

/** A document in the chain, named the way the outbox names one. */
export interface CascadeDoc {
  docType: 'SO' | 'PO' | 'DO' | 'GR' | 'IV' | 'PI';
  docId: string;
  docNo: string;
  /** The account book's own number for it, or null when it is not in the book. */
  linkedAcDocNo: string | null;
}

/* ONE RUNG OF THE CHAIN, DERIVED — never a second copy of DOWNSTREAM.
   The four links this walks are the four DOWNSTREAM already describes; writing
   them out again would be a second home for the same rule, and the
   duplicated-decision gate says so by name. What DOWNSTREAM does NOT carry is
   the way back UP from a source LINE to its parent HEADER — the child's own
   spec names `sourceItemTable` and `sourceFk`, but not which column on that
   table points at the header, nor what the header's number is called. Those
   three facts per rung are what lives here, and nothing else does. */
const UP: Record<string, {
  parentType: CascadeDoc['docType'];
  /** The column on the SOURCE ITEM table that names its own header. */
  sourceParentCol: string;
  parentTable: string;
  parentNoCol: string;
}> = {
  IV: { parentType: 'DO', sourceParentCol: 'delivery_order_id', parentTable: 'delivery_orders', parentNoCol: 'do_number' },
  DO: { parentType: 'SO', sourceParentCol: 'doc_no', parentTable: 'mfg_sales_orders', parentNoCol: 'doc_no' },
  PI: { parentType: 'GR', sourceParentCol: 'grn_id', parentTable: 'grns', parentNoCol: 'grn_number' },
  GR: { parentType: 'PO', sourceParentCol: 'purchase_order_id', parentTable: 'purchase_orders', parentNoCol: 'po_number' },
};

/* A sales order is keyed by its NUMBER, not by an id — the one document in the
   chain that is, which is why AcDocRef carries a keyCol at all. Reading its
   header therefore matches on doc_no. */
const KEYED_BY_NUMBER = new Set(['SO']);

async function parentOf(sb: Sb, docType: string, docId: string): Promise<CascadeDoc | null> {
  const up = UP[docType];
  const spec = DOWNSTREAM[docType as keyof typeof DOWNSTREAM];
  if (!up || !spec) return null;

  const { data: lines, error } = await sb.from(spec.itemTable)
    .select(spec.sourceFk).eq(spec.itemFk, docId);
  if (error || !lines?.length) return null;
  const srcIds = [...new Set((lines as Array<Record<string, string | null>>)
    .map((l) => l[spec.sourceFk]).filter((v): v is string => !!v))];
  if (!srcIds.length) return null;

  const { data: srcLines, error: e2 } = await sb.from(spec.sourceItemTable)
    .select(up.sourceParentCol).in('id', srcIds);
  if (e2 || !srcLines?.length) return null;
  const parentKeys = [...new Set((srcLines as Array<Record<string, string | null>>)
    .map((r) => r[up.sourceParentCol]).filter((v): v is string => !!v))];
  /* MORE THAN ONE PARENT IS NOT A CHAIN. A merged conversion has several, and
     "send the ancestors in order" has no single answer for it — the caller is
     told nothing rather than told the first one, which would silently send one
     parent and leave the rest. */
  if (parentKeys.length !== 1) return null;

  const keyCol = KEYED_BY_NUMBER.has(up.parentType) ? up.parentNoCol : 'id';
  const { data: head, error: e3 } = await sb.from(up.parentTable)
    .select(`id, ${up.parentNoCol}, linked_ac_docno`).eq(keyCol, parentKeys[0]).maybeSingle();
  if (e3 || !head) return null;
  const h = head as Record<string, string | null>;
  return {
    docType: up.parentType,
    docId: String(h.id ?? parentKeys[0]),
    docNo: String(h[up.parentNoCol] ?? ''),
    linkedAcDocNo: h.linked_ac_docno ?? null,
  };
}

/**
 * An ancestor that must be sent first, and the row that sends it.
 *
 * The ROW comes back with the walk rather than being looked up afterwards. A
 * `missing` ancestor's row is whatever we last tried; a `stale` one's row is the
 * specific EDIT that never landed, and "the newest row" is not reliably that —
 * a re-queue of the create would be newer. Naming the row here is what makes
 * the two cases one loop for the caller instead of two.
 */
export interface CascadeStep extends CascadeDoc {
  reason: CascadeReason;
  /** The outbox row to send, or null when the document has none at all. */
  rowId: string | null;
  rowStatus: string | null;
}

/**
 * The oldest edit for this document that never reached the account book.
 *
 * PENDING OR FAILED, both. A pending edit is one the sweep has not taken yet; a
 * failed one is a sweep that gave up. From the operator's side they are the same
 * fact — the book does not have my change — and a cascade that handled only one
 * of them would fix half the cases and be impossible to explain.
 *
 * OLDEST, not newest. Two unsent edits are two changes in order, and sending the
 * newer one first would apply them backwards. The caller sends one per press;
 * the next press takes the next.
 */
export async function unsentEditFor(
  sb: Sb,
  companyId: number | null | undefined,
  docNo: string,
): Promise<{ id: string; status: string } | null> {
  if (!docNo) return null;
  let q = sb.from('autocount_outbox').select('id, status')
    .eq('doc_no', docNo).eq('op', 'edit').in('status', ['pending', 'failed'])
    .order('created_at', { ascending: true }).limit(1);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q;
  if (error || !data?.length) return null;
  const r = (data as Array<{ id: string; status?: string }>)[0];
  return { id: String(r.id), status: String(r.status ?? '') };
}

/**
 * Every ancestor that has to reach the account book before this document can be
 * built from it — OUTERMOST FIRST, so the caller sends them in AutoCount's own
 * order.
 *
 * THIS IS THE SECOND HALF OF THE OWNER'S RULE. `ancestorsMissingFromBook`
 * answered "which ancestors are not in the book"; it stopped at the first one
 * that was, because presence propagates upward — a document only gets into the
 * book by way of its parent. Owner, 2026-08-26:
 *
 *   「为了确保我送 DO 的时候，如果之前的东西是不一样的，它是不是就需要 convert
 *     多一次？」
 *
 * The answer is that converting again does nothing; what was missing is that
 * FRESHNESS does not propagate the way presence does. A sales order can be in
 * the book and still be the wrong version of itself, and the conversion then
 * carries the old lines into a live account book with nothing reporting it.
 *
 * SO THE WALK NO LONGER STOPS AT THE FIRST ANCESTOR IN THE BOOK. It goes to the
 * top of the chain, because a stale ancestor can sit ABOVE a fresh one: an
 * invoice built from a delivery order built from a sales order the operator
 * edited afterwards. The chains are two rungs, so this is one or two more reads,
 * not a new cost.
 *
 * "STALE" IS AN UNSENT EDIT, NOT A DIFF AGAINST THE BOOK. The ERP already
 * queues an edit every time a document changes, so an edit still sitting in the
 * queue IS the statement that the book is behind — read from data we already
 * keep, with no second call to the host and no second opinion about what
 * "different" means. A document whose edits have all been sent is treated as
 * current, which is exactly what the queue is for.
 */
export async function ancestorsNeedingSend(
  sb: Sb,
  companyId: number | null | undefined,
  docType: string,
  docId: string | null,
  maxDepth = 4,
): Promise<CascadeStep[]> {
  if (!docId) return [];
  const steps: CascadeStep[] = [];
  let type = docType;
  let id: string | null = docId;
  const seen = new Set<string>([`${docType}:${docId}`]);

  for (let i = 0; i < maxDepth && id; i += 1) {
    const parent: CascadeDoc | null = await parentOf(sb, type, id);
    if (!parent) break;
    const key = `${parent.docType}:${parent.docId}`;
    if (seen.has(key)) break;
    seen.add(key);

    if (!parent.linkedAcDocNo) {
      const row = await newestOutboxRowWithStatus(sb, companyId, parent.docNo);
      steps.push({
        ...parent,
        reason: 'missing',
        rowId: row?.id ?? null,
        rowStatus: row?.status ?? null,
      });
    } else {
      const edit = await unsentEditFor(sb, companyId, parent.docNo);
      if (edit) {
        steps.push({ ...parent, reason: 'stale', rowId: edit.id, rowStatus: edit.status });
      }
    }
    type = parent.docType;
    id = parent.docId;
  }
  /* Collected child-upwards; the caller sends parent-downwards. */
  return steps.reverse();
}

/**
 * The newest outbox row for a document number, or null when it has none.
 *
 * NEWEST, because a document accumulates rows — a create, then a re-queue of
 * it, then an edit — and the one worth re-sending is the last thing we tried.
 * Company-scoped: `doc_no` is unique per company, not across the two.
 */
export async function newestOutboxRowFor(
  sb: Sb,
  companyId: number | null | undefined,
  docNo: string,
): Promise<string | null> {
  return (await newestOutboxRowWithStatus(sb, companyId, docNo))?.id ?? null;
}

/**
 * The same row, WITH its status — because what to do with an ancestor depends
 * on it and the caller cannot tell from an id alone.
 *
 * A `pending` ancestor must be SENT, not re-queued. `requeueOutboxRow` refuses
 * a pending row outright (`row-pending`, and rightly: the sweep is already
 * going to take it), so a cascade that only ever re-queues silently does
 * NOTHING for the one shape it meets most — a chain where every document is
 * waiting on the one above it. Owner, 2026-08-26: 「如果顺着点完…就没问题。但如果
 * 我想走捷径，直接去点 Sales Invoice…就不行」. Pressing each row in order worked
 * because that sends each pending row directly, which is exactly what the
 * cascade was failing to do.
 */
export async function newestOutboxRowWithStatus(
  sb: Sb,
  companyId: number | null | undefined,
  docNo: string,
): Promise<{ id: string; status: string } | null> {
  if (!docNo) return null;
  let q = sb.from('autocount_outbox').select('id, status')
    .eq('doc_no', docNo).order('created_at', { ascending: false }).limit(1);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q;
  if (error || !data?.length) return null;
  const r = (data as Array<{ id: string; status?: string }>)[0];
  return { id: String(r.id), status: String(r.status ?? '') };
}

/**
 * The document an outbox row is about, read before the row is sent.
 *
 * `send-now` takes a ROW id; the chain walk needs the DOCUMENT that row is for.
 * Company-scoped like every other read here — a row id is not a capability.
 */
export async function sendNowPeek(
  sb: Sb,
  rowId: string,
  companyId: number | null | undefined,
): Promise<{ docType: string; docId: string | null } | null> {
  let q = sb.from('autocount_outbox').select('doc_type, doc_id').eq('id', rowId);
  if (companyId != null) q = q.eq('company_id', companyId);
  const { data, error } = await q.maybeSingle();
  if (error || !data) return null;
  const r = data as { doc_type?: string | null; doc_id?: string | null };
  return { docType: String(r.doc_type ?? ''), docId: r.doc_id ?? null };
}
