// ----------------------------------------------------------------------------
// autocount-requeue — re-attempt a document the write-back REFUSED, once the
// reason for the refusal has been fixed.
//
// THE GAP THIS CLOSES. A document the composer declines to send is written as a
// `skipped` outbox row carrying the reason (noteReadFailure, autocount-outbox.ts).
// That row is TERMINAL, and fixing its cause does not bring the document back:
//
//   • enqueueSoCreate / enqueuePoCreate are called from exactly two places each
//     — the create, and the DRAFT -> live transition. An ordinary edit is
//     neither, so re-saving the order does not re-attempt the create.
//   • enqueueEdit bails on `if (!composed.linkedAcDocNo) return false;` — a
//     document that never reached AutoCount has no counterpart to edit, so
//     editing it silently does nothing.
//
// Measured on production 2026-08-13: HC-SO-2608-001 (ItemCodeError) and
// HC-SO-2608-002 (MissingLocationError) had been sitting `skipped` since their
// save, with the queue holding no other rows at all. The second one's cause was
// already fixed — the order now carries a sales_location — and it still was not
// going anywhere. Nothing in the ERP could re-ask the question.
//
// WHAT THIS IS NOT: a second composer. It does not read the old payload and it
// does not build a new one. It calls the SAME enqueueSoCreate / enqueuePoCreate
// the route calls, against the document AS IT IS NOW, and reports what they
// answered. If the composer has learned a new refusal since, this tool learns it
// on the same day, because there is only one of them.
//
// SCOPE — creates only, and the reason is not laziness:
//
//   create_so / create_po  RECOVERABLE HERE, and nowhere else. No route path
//                          re-attempts a create for a document that already
//                          exists, so without this the row is a dead end.
//   edit                   NOT here. The document IS in AutoCount (an edit is
//                          only composed when linked_ac_docno is set), so the
//                          documented remedy — fix the cause, save the document
//                          again — genuinely re-queues it. Re-queueing it from
//                          here would be strictly WORSE: the original edit may
//                          have carried `retire` entries for lines the save
//                          hard-deleted (§7a), that list is not recoverable from
//                          a skipped row whose payload is `{}`, and an edit
//                          missing them leaves those lines live and transferable
//                          in the account book.
//   conversions            NOT here, and mostly not possible. A parentless
//                          DO/GR/IV/PI can never exist in AutoCount at all
//                          (recordParentlessCreate), a merged conversion has no
//                          AutoCount shape, and re-expressing the DtlKey-subset
//                          refusal would mean rebuilding enqueueConvert's
//                          call-site arguments (from / to / docDate / ref) here
//                          — the route logic copied into a script, which is the
//                          drift this module exists to avoid.
//
// Those rows are still REPORTED, with why they are not re-queueable, because a
// tool that silently ignores two thirds of the backlog teaches the operator the
// backlog is smaller than it is.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueuePoCreate, enqueueSoCreate } from './autocount-outbox';
import { isWritebackEnabled } from './autocount-writeback-flag';

type Sb = SupabaseClient<any, any, any>;

/** The two document types that HAVE a create, and the op that expresses it. */
const CREATE_OP = { SO: 'create_so', PO: 'create_po' } as const;
export type RequeueDocType = keyof typeof CREATE_OP;

/**
 * What a re-queued row's ORIGINAL skip is rewritten to start with.
 *
 * Also matched, as a literal, by check-autocount-outbox-health.mjs — that script
 * runs under plain node against postgres.js and cannot import this module. Keep
 * the two in step; the health report is the only place an operator sees the
 * distinction between a backlog and a settled row.
 */
export const REQUEUE_NOTE_PREFIX = '[re-queued';

export type RequeueOutcome =
  /** DRY RUN: the composer accepted it. APPLY would queue it. */
  | 'would-requeue'
  /** APPLY: a pending row was written and the old skip was annotated. */
  | 'requeued'
  /** The composer refuses it again. `detail` is the reason AS IT STANDS NOW. */
  | 'still-refused'
  /** A skip this tool deliberately does not re-attempt (edit, conversion). */
  | 'not-recoverable'
  /** linked_ac_docno is set: the document is already in the account book. */
  | 'already-in-autocount'
  /** A non-skipped outbox row for the same create already exists. */
  | 'already-queued'
  /** This exact skip was already re-queued by an earlier run. */
  | 'already-requeued'
  /** The ERP document behind the row is gone. */
  | 'document-gone'
  /** scm.autocount_writeback is off for this company, so nothing can queue. */
  | 'switch-off'
  /** The enqueue declined for a reason it did not write down. */
  | 'declined';

export interface RequeueResult {
  rowId: string;
  companyId: number;
  op: string;
  docType: string;
  docNo: string;
  docId: string | null;
  outcome: RequeueOutcome;
  /** Why this outcome, in the operator's vocabulary. */
  detail: string;
  /** What the ORIGINAL skip said, so the report shows the cause being fixed. */
  originalReason: string;
}

export interface RequeueOptions {
  /** One document, by its ERP number. Overrides docType. */
  docNo?: string | null;
  /** Every skipped row of this type, or all of them. */
  docType?: RequeueDocType | 'ALL' | null;
  /** Nothing is written unless this is true. */
  apply?: boolean;
  /** Cap on rows examined, so a pathological backlog cannot run forever. */
  limit?: number;
}

interface SkippedRow {
  id: string;
  company_id: number;
  op: string;
  doc_type: string;
  doc_no: string;
  doc_id: string | null;
  last_error: string | null;
}

interface CapturedWrite {
  table: string;
  kind: 'insert' | 'update' | 'upsert' | 'delete';
  values: Record<string, unknown> | null;
}

/**
 * The SAME client for reads, and a recorder for writes.
 *
 * This is what makes the dry run trustworthy rather than a second opinion. The
 * alternative — predicting the composer's verdict here — would be a copy of the
 * composer's rules, and a copy that said "this will go through" while the real
 * one refused is worse than no dry run at all. So the dry run executes the REAL
 * enqueue, against the REAL document, and simply does not let it write: an
 * insert of a `pending` row means it would have queued, an insert of a `skipped`
 * row means noteReadFailure refused it and the row carries the current reason.
 *
 * APPLY then runs the same enqueue again, for real, only for the documents the
 * probe accepted. Two consequences worth stating:
 *
 *   • APPLY never lands a duplicate `skipped` row for a document that is still
 *     refused — the probe already knows, and the refusal is reported instead of
 *     being appended to the backlog a second time.
 *   • The document is read twice and could change in between. The real enqueue
 *     re-reads and re-refuses safely if it does, so the worst case is a report
 *     that is one refresh stale, not a wrong write.
 */
export function captureWrites(sb: Sb): { sb: Sb; writes: CapturedWrite[] } {
  const writes: CapturedWrite[] = [];
  const swallow = (): any => {
    const b: any = {
      eq: () => b, neq: () => b, in: () => b, is: () => b, match: () => b,
      select: () => b, order: () => b, limit: () => b,
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null, count: null }).then(resolve, reject),
    };
    return b;
  };
  const record = (table: string, kind: CapturedWrite['kind']) => (values?: unknown) => {
    writes.push({ table, kind, values: (values ?? null) as Record<string, unknown> | null });
    return swallow();
  };
  const from = (table: string) => {
    const real = (sb as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'insert' || prop === 'upsert' || prop === 'update') {
          return record(table, prop as CapturedWrite['kind']);
        }
        if (prop === 'delete') return record(table, 'delete');
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
  return { sb: { from } as unknown as Sb, writes };
}

/** The outbox insert a probe produced, if it produced one. */
function outboxInsert(writes: CapturedWrite[]): Record<string, unknown> | null {
  const w = writes.find((x) => x.table === 'autocount_outbox' && x.kind === 'insert');
  return w?.values ?? null;
}

function reasonFor(op: string): string {
  if (op === 'edit') {
    return 'an edit refusal is not re-queued here: the document IS in AutoCount, so fixing the cause '
      + 'and saving the document again really does re-queue it. Re-composing it from a script would '
      + 'also drop any line RETIREMENTS the original save carried, which a skipped row does not record.';
  }
  return 'a conversion refusal is not re-queued here: a parentless DO / GR / IV / PI can never exist '
    + 'in AutoCount at all, a merged conversion has no AutoCount shape, and a DtlKey-subset refusal '
    + 'is fixed by the line-key backfill and then re-raising the document.';
}

async function readCreateTarget(
  sb: Sb,
  row: SkippedRow,
): Promise<{ ok: true; linked: string | null; poId?: string } | { ok: false }> {
  if (row.op === 'create_so') {
    const { data, error } = await sb.from('mfg_sales_orders')
      .select('doc_no, linked_ac_docno').eq('doc_no', row.doc_no).maybeSingle();
    if (error || !data) return { ok: false };
    return { ok: true, linked: (data as { linked_ac_docno: string | null }).linked_ac_docno ?? null };
  }
  /* A PO is addressed by id everywhere in its router, and that is what the
     skipped row carries. Older rows written before docId was passed fall back to
     the human number, which is unique per company. */
  const q = row.doc_id
    ? sb.from('purchase_orders').select('id, linked_ac_docno').eq('id', row.doc_id)
    : sb.from('purchase_orders').select('id, linked_ac_docno').eq('po_number', row.doc_no);
  const { data, error } = await q.maybeSingle();
  if (error || !data) return { ok: false };
  const po = data as { id: string; linked_ac_docno: string | null };
  return { ok: true, linked: po.linked_ac_docno ?? null, poId: String(po.id) };
}

/** Any outbox row for the same create that is NOT a skip. */
async function existingCreateRow(
  sb: Sb,
  row: SkippedRow,
): Promise<{ status: string } | null> {
  const { data, error } = await sb.from('autocount_outbox')
    .select('id, status')
    .eq('company_id', row.company_id)
    .eq('op', row.op)
    .eq('doc_no', row.doc_no)
    .neq('status', 'skipped')
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as { status: string };
}

/**
 * Re-attempt the skipped CREATES whose refusal may have been fixed.
 *
 * Read-only unless `apply` is true. Never throws for a document-level problem —
 * every document gets an outcome, because "the tool crashed on row 3" tells an
 * operator nothing about rows 4 to 12.
 */
export async function requeueSkipped(sb: Sb, opts: RequeueOptions = {}): Promise<RequeueResult[]> {
  const apply = opts.apply === true;
  let q = sb.from('autocount_outbox')
    .select('id, company_id, op, doc_type, doc_no, doc_id, last_error')
    .eq('status', 'skipped')
    .order('created_at', { ascending: true })
    .limit(opts.limit ?? 200);
  if (opts.docNo) q = q.eq('doc_no', opts.docNo);
  else if (opts.docType && opts.docType !== 'ALL') q = q.eq('doc_type', opts.docType);
  const { data, error } = await q;
  if (error) throw new Error(`could not read the outbox: ${error.code ?? ''} ${error.message ?? ''}`.trim());

  const results: RequeueResult[] = [];
  for (const raw of (data ?? []) as SkippedRow[]) {
    const companyId = Number(raw.company_id);
    const base = {
      rowId: String(raw.id),
      companyId,
      op: String(raw.op),
      docType: String(raw.doc_type),
      docNo: String(raw.doc_no),
      docId: raw.doc_id == null ? null : String(raw.doc_id),
      originalReason: raw.last_error ?? '',
    };
    const say = (outcome: RequeueOutcome, detail: string) => {
      results.push({ ...base, outcome, detail });
    };

    if (raw.op !== 'create_so' && raw.op !== 'create_po') {
      say('not-recoverable', reasonFor(raw.op));
      continue;
    }
    if ((raw.last_error ?? '').startsWith(REQUEUE_NOTE_PREFIX)) {
      say('already-requeued', 'an earlier run of this tool already re-queued this skip; the row is '
        + 'history now, not backlog.');
      continue;
    }
    /* The switch is checked HERE as well as inside the enqueue, because inside
       it is indistinguishable from every other silent false. An operator whose
       write-back is off would otherwise read "declined" and go looking for a
       composer problem that does not exist. */
    if (!(await isWritebackEnabled(sb, companyId))) {
      say('switch-off', `scm.autocount_writeback is off for company ${companyId}, so an enqueue `
        + 'would return early and write nothing. Turn it on (AutoCount write-back (on/off) workflow) '
        + 'and run this again.');
      continue;
    }

    const target = await readCreateTarget(sb, raw);
    if (!target.ok) {
      say('document-gone', 'the ERP document this row is about could not be read. Nothing to re-queue.');
      continue;
    }
    /* enqueueSoCreate guards this itself and would return false; the check is
       here so the REPORT can tell an operator which of the several silent
       falses they are looking at. The guard is not defeated — it still runs. */
    if (target.linked) {
      say('already-in-autocount', `it already carries linked_ac_docno ${target.linked}. Creating it `
        + 'again would duplicate the document in the live account book.');
      continue;
    }
    const existing = await existingCreateRow(sb, raw);
    if (existing) {
      say('already-queued', `a ${existing.status} ${raw.op} row for this document already exists. `
        + (existing.status === 'failed'
          ? 'A failed create was sent and refused by AutoCount — a different problem from a refusal '
            + 'that never left the ERP, and not this tool\'s call to re-send.'
          : 'Nothing to add.'));
      continue;
    }

    const probe = captureWrites(sb);
    const enqueue = (client: Sb) => (raw.op === 'create_so'
      ? enqueueSoCreate(client, { companyId, docNo: raw.doc_no })
      : enqueuePoCreate(client, { companyId, poId: target.poId ?? String(raw.doc_id ?? '') }));
    await enqueue(probe.sb);
    const attempted = outboxInsert(probe.writes);
    if (!attempted) {
      say('declined', 'the enqueue returned without composing anything and without writing a note. '
        + 'Nothing was queued and nothing is wrong with the document that this can name.');
      continue;
    }
    if ((attempted.status ?? 'pending') === 'skipped') {
      say('still-refused', String(attempted.last_error ?? 'refused, no reason recorded'));
      continue;
    }
    if (!apply) {
      say('would-requeue', 'the composer accepts it now. APPLY would queue a '
        + `${raw.op} row and annotate this skip.`);
      continue;
    }

    const queued = await enqueue(sb);
    if (!queued) {
      /* The probe accepted it and the real run did not, which is two things and
         both are safe: another run queued it first and lost the race to 0277's
         pending-dedupe index (23505, nothing written twice), or the document
         changed in the seconds between the two reads and the enqueue refused it
         — in which case noteReadFailure has just written a fresh skipped row
         carrying the new reason. Naming one cause as if it were certain is what
         would send an operator the wrong way. */
      say('declined', 'the probe accepted this document and the real enqueue declined it. Either '
        + 'another run queued it first (the pending-dedupe index refuses the second), or the document '
        + 'changed in between and the composer refused it — re-run this to see which.');
      continue;
    }
    const newRowId = await findQueuedRowId(sb, raw);
    await annotate(sb, raw, newRowId);
    say('requeued', `queued as a fresh ${raw.op}${newRowId ? ` (outbox ${newRowId})` : ''}. `
      + 'The 5-minute cron sends it.');
  }
  return results;
}

/** The pending row the re-queue just created, for the audit note. */
async function findQueuedRowId(sb: Sb, row: SkippedRow): Promise<string | null> {
  try {
    const { data, error } = await sb.from('autocount_outbox')
      .select('id')
      .eq('company_id', row.company_id)
      .eq('op', row.op)
      .eq('doc_no', row.doc_no)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return String((data as { id: string }).id);
  } catch {
    return null;
  }
}

/**
 * Settle the old skip so it stops reading as backlog.
 *
 * THE STATUS IS DELIBERATELY UNCHANGED. 0277's CHECK admits exactly four
 * statuses, and every one of them would be a lie here: this row was never sent
 * and never failed, and flipping it to `pending` would hand the drain a row
 * whose payload is `{}`. A fifth status would need a migration to describe a
 * state nothing reads. So the row stays `skipped` — which is still true, nothing
 * was ever sent for it — and the NOTE carries what changed.
 *
 * The note goes in front of `last_error` because that is the one field the
 * health report prints, so an operator sees the settlement in the same line as
 * the original reason. The original text is kept whole: the point of an
 * append-only table is that the refusal that happened is still readable a year
 * later, next to the date somebody re-asked the question.
 */
async function annotate(sb: Sb, row: SkippedRow, newRowId: string | null): Promise<void> {
  const at = new Date().toISOString();
  const note = `${REQUEUE_NOTE_PREFIX} ${at}${newRowId ? ` -> outbox ${newRowId}` : ''}] `;
  await sb.from('autocount_outbox')
    .update({ last_error: `${note}${row.last_error ?? ''}`, updated_at: at })
    .eq('id', row.id);
}
