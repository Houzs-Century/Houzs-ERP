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
 * The ancestors this document needs in the account book, OUTERMOST FIRST — so
 * the caller can send them in the order AutoCount needs them.
 *
 * Stops at the first ancestor that is already in the book: everything above it
 * must be too, because that is how it got there.
 *
 * Returns [] when the document has no parent, when a parent cannot be resolved,
 * or when the immediate parent is already in the book. All three mean the same
 * thing to the caller — nothing to send first — and none of them is an error.
 *
 * `maxDepth` is a guard, not a policy: the real chains are two rungs
 * (SO -> DO -> IV, PO -> GR -> PI) and a cycle in the data must not hang a
 * request.
 */
export async function ancestorsMissingFromBook(
  sb: Sb,
  docType: string,
  docId: string | null,
  maxDepth = 4,
): Promise<CascadeDoc[]> {
  if (!docId) return [];
  const chain: CascadeDoc[] = [];
  let type = docType;
  let id: string | null = docId;
  const seen = new Set<string>([`${docType}:${docId}`]);

  for (let i = 0; i < maxDepth && id; i += 1) {
    const parent: CascadeDoc | null = await parentOf(sb, type, id);
    if (!parent) break;
    const key = `${parent.docType}:${parent.docId}`;
    if (seen.has(key)) break;
    seen.add(key);
    if (parent.linkedAcDocNo) break;   // in the book — and so is everything above it
    chain.push(parent);
    type = parent.docType;
    id = parent.docId;
  }
  /* Collected child-upwards; the caller sends parent-downwards. */
  return chain.reverse();
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
