/* ----------------------------------------------------------------------------
   POST /autocount-outbox/relink-lines — match a held-back document's lines up
   against AutoCount, so it can be saved again.

   THE SCREEN ALREADY TELLS THE OPERATOR TO DO THIS. A document refused for a
   keyless line renders "TO FIX: The lines have to be matched up against
   AutoCount, and then the document saved again" — and there was no way to do it.
   This is that way.

   WHY IT IS NEEDED AT ALL. A line the ERP adds to a document AutoCount already
   holds is appended by the book, which assigns the DtlKey, and until 2026-08-31
   nothing carried that key back (`docs/bugs/0583-*`). The service change that
   fixes it going forward needs a deploy on the office host and does nothing for
   the documents already stuck. This route needs no deploy: `/doc-read` has been
   served since 2026-08-15.

   READ-ONLY ON THE BOOK. Two SELECTs on the host, no SDK session, no outbox row.
   The only WRITE is `linked_ac_dtlkey` on our own rows — a link, never a value:
   no money moves, no stock moves, no document is created or changed in AutoCount.

   THE MATCHING RULES, AND EVERY REFUSAL, LIVE IN `lib/autocount-relink-lines`,
   with their own tests. A wrong key is worse than no key — it silently edits
   somebody else's line in a live account book on the next save — so nothing is
   written that cannot be proven, and an ambiguous line is named rather than
   guessed.
   -------------------------------------------------------------------------- */
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { activeCompanyId } from '../lib/companyScope';
import { callAcRead } from '../../services/autocount-host-read';
import { planLineRelink, type BookLine } from '../lib/autocount-relink-lines';
import { NEW_LINE_TABLE } from '../lib/autocount-line-keys';

/* The same keys as Send again and /book-doc, for the same reason: this reads a
   licensed account book, and it writes line identity. */
const RELINK_KEYS = ['scm.autocount.requeue', '*'] as const;

/* The line table comes from NEW_LINE_TABLE — the same two-entry answer the key
   store uses, and for the same reason: these are the two documents whose lines a
   route inserts by hand. Only the parent/header columns are local. */
const DOC = {
  /* `headerCols` is per-document and REQUIRED, because the two headers are not
     shaped alike: scm.purchase_orders is keyed by a uuid `id` that its lines
     carry, and scm.mfg_sales_orders has NO `id` column at all — its lines carry
     `doc_no`. Selecting a common column list asked the sales-order header for a
     column that does not exist, and PostgREST refused the whole read, so the
     operator's "Match up lines" reported `column mfg_sales_orders.id does not
     exist` and nothing was ever matched (docs/bugs/0601). */
  SO: { lineTable: NEW_LINE_TABLE.SO, parentCol: 'doc_no', headerTable: 'mfg_sales_orders', headerKey: 'doc_no', headerCols: 'linked_ac_docno', parentFrom: 'docNo' },
  PO: { lineTable: NEW_LINE_TABLE.PO, parentCol: 'purchase_order_id', headerTable: 'purchase_orders', headerKey: 'po_number', headerCols: 'id, linked_ac_docno', parentFrom: 'headerId' },
} as const;

type DocKind = keyof typeof DOC;

export const autocountRelinkLinesHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  if (!RELINK_KEYS.some((k) => hasHouzsPerm(c, k))) {
    return c.json({
      error: 'forbidden',
      message: 'Matching a document up against the account book reads it and writes line '
        + `identity, so it is limited to ${RELINK_KEYS.join(' or ')}.`,
    }, 403);
  }

  const body = await c.req.json().catch(() => ({})) as { docType?: string; docNo?: string };
  const docType = String(body.docType ?? '').trim().toUpperCase() as DocKind;
  const docNo = String(body.docNo ?? '').trim();
  const spec = DOC[docType];
  if (!spec) {
    return c.json({
      error: 'invalid_doc_type',
      message: `docType must be one of ${Object.keys(DOC).join(', ')}. The other four are built by `
        + 'conversion and their lines are never added by hand here.',
    }, 400);
  }
  if (!docNo) return c.json({ error: 'invalid_doc_no', message: '`docNo` is required.' }, 400);

  const sb = c.get('supabase');
  const companyId = activeCompanyId(c);

  /* The document has to be OURS before we read it out of the book — the company
     predicate is the whole tenant boundary on this client (it is the service
     role, so no policy is evaluated). */
  const { data: header, error: headerErr } = await sb.from(spec.headerTable)
    .select(spec.headerCols)
    .eq(spec.headerKey, docNo)
    .eq('company_id', companyId)
    .maybeSingle();
  /* BOUND AND BRANCHED, not `?? null`. A failed read and "no such document" are
     opposite facts, and reporting the first as the second sends the operator
     looking for a document that is right there. */
  if (headerErr) return c.json({ error: 'read_failed', reason: headerErr.message }, 500);
  if (!header) return c.json({ error: 'not_found' }, 404);

  const bookDocNo = (header as { linked_ac_docno?: string | null }).linked_ac_docno ?? docNo;

  const read = await callAcRead(c.env, 'doc_read', { DocType: docType, DocNo: bookDocNo });
  if (!read.ok) {
    return c.json({
      ok: false,
      error: read.error,
      message: 'The account book could not be read, so nothing was matched or changed.',
    }, 502);
  }
  const bookLines = Array.isArray(read.body?.lines) ? (read.body?.lines as BookLine[]) : [];

  /* Read off the spec for the same reason `headerCols` is: a per-document fact
     settled by testing a column NAME silently takes the wrong branch the moment
     a third document type is added, and nothing fails to compile. */
  const parentValue = spec.parentFrom === 'headerId'
    ? String((header as { id?: unknown }).id ?? '')
    : docNo;
  const { data: rows, error: rowsErr } = await sb.from(spec.lineTable)
    .select('id, item_code, description2, linked_ac_dtlkey')
    .eq(spec.parentCol, parentValue);
  /* Same rule, and it matters more here: an unbound failure would reach the
     planner as "this document has no lines", which reports "nothing could be
     matched" — a sentence that is indistinguishable from the honest answer. */
  if (rowsErr) return c.json({ error: 'read_failed', reason: rowsErr.message }, 500);

  const erpLines = ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    /* THE RAW ERP CODE, deliberately. The write-back resolves a supplier's own
       spelling through the bindings, and where that resolution applies the raw
       code will simply not match the book's — which this planner treats as
       "cannot be proven" and REFUSES. Fail-closed is the right direction here: a
       refusal is a line the operator is told about, a wrong match is a line
       somebody else loses. Resolving properly is the follow-up, not a silent
       widening. */
    acItemCode: (r.item_code as string | null) ?? null,
    desc2: (r.description2 as string | null) ?? null,
    dtlKey: r.linked_ac_dtlkey == null ? null : Number(r.linked_ac_dtlkey),
  }));

  const plan = planLineRelink({ bookLines, erpLines });

  let stamped = 0;
  const failed: string[] = [];
  for (const a of plan.assign) {
    const { error } = await sb.from(spec.lineTable)
      .update({ linked_ac_dtlkey: a.dtlKey })
      .eq('id', a.id)
      /* Only ever fills a BLANK. Two operators pressing this at once, or a
         backfill landing in between, must not repoint a key that is already
         there. */
      .is('linked_ac_dtlkey', null);
    if (error) failed.push(`${a.itemCode}: ${error.message}`);
    else stamped += 1;
  }

  return c.json({
    ok: true,
    docType,
    docNo,
    bookLines: bookLines.length,
    alreadyKeyed: plan.alreadyKeyed,
    matched: stamped,
    /* NAMED, not counted. Each one is a line the operator still has to deal
       with, and "2 lines could not be matched" sends him hunting. */
    couldNotMatch: [...plan.refused, ...failed],
    /* THE WAY OUT OF A DEAD END. Matching can be IMPOSSIBLE, not merely hard:
       two book lines carrying the same item code with nothing to separate them
       cannot be told apart by any matcher, ever. HC-SO-013394 is that shape, and
       before this the operator was told "nothing could be matched" and left
       there — the document could not be sent by ANY route.

       Owner 2026-09-02: 「如果做得到 inistate 的东西，那就是我删或者 addline 都可以
       sync 进去，就代表这张单也进得去了啊」. He is right: a REBUILD never has to
       match anything, so it is exactly the escape this dead end needs.

       OFFERED, NOT DONE. A rebuild destroys and reissues every DtlKey on the
       document, so it is the operator's call and not a silent consequence of
       pressing Match up lines. `canRebuild` is what the screen turns into that
       choice; the host still refuses it on a document with a transferred line,
       read from the book's own tables. */
    canRebuild: stamped === 0 && plan.refused.length > 0,
    message: stamped > 0
      ? `${stamped} line(s) matched up against the account book. Save the document again.`
      : plan.refused.length > 0
        ? 'These lines cannot be told apart in the account book, so no matcher can '
          + 'choose between them. The document can still be sent by REBUILDING its '
          + 'lines from the ERP — that replaces the account book lines with these '
          + 'ones and cannot be undone.'
        : 'Nothing could be matched — the document is unchanged.',
  });
};
