// ----------------------------------------------------------------------------
// autocount-relink-sweep — clear the KEYLESS CONVERSION backlog hands-free.
//
// THE PROBLEM IT SOLVES. A delivery order or goods receipt the ERP converted
// before the account book reported its line keys back sits on the "not accepted"
// list as `keyless-line`: the book already holds the document, but our lines
// carry no `linked_ac_dtlkey`, so the edit that would sync a later change cannot
// name which book line to touch and refuses rather than append a duplicate. The
// screen's remedy is "Match up lines, then save again" — a person, per document.
// The owner has no person, and asked for this to happen on its own.
//
// WHY A CRON SWEEP AND NOT A WORKFLOW. Matching a line up means READING THE LIVE
// account book (`/doc-read`), and only the Worker can reach the host
// (AC_SYNC_URL / AC_SYNC_KEY are Worker secrets, forbidden in Actions — the DB
// is one shared book and the key bypasses RLS). The only hands-free trigger
// inside the Worker is its own cron.
//
// IT SHIPS DARK. `scm.app_config 'scm.autocount_relink_sweep'` is the switch:
//   absent / 'off'  -> NO-OP (the seeded, unset state)
//   'plan'          -> read the book and REPORT what it would stamp/queue; writes nothing
//   'apply'         -> stamp the keys and queue the keyed edit
// Any other/unreadable value fails CLOSED to 'off', exactly as the write-back
// flag does and for the same reason: this ends in a write to a live licensed
// account book, and a typo must never start one.
//
// WHY IT CANNOT DUPLICATE A LINE OR AN EDIT — the two things a live book cannot
// take back:
//   • the RELINK stamps only what planLineRelink can PROVE (item code, and Desc2
//     where the code repeats) and refuses the ambiguous — link, never money or
//     stock, the same guarantee as the "Match up lines" button;
//   • the keyed edit is queued ONLY on the run that just FINISHED the keying
//     (`stamped > 0` and no keyless line left). A document already fully keyed on
//     a later sweep has `stamped === 0`, so it is never re-queued; and one still
//     carrying a keyless line is never queued at all, so `enqueueEdit` can never
//     be handed a document it would refuse (KeylessLineError) — or worse, append.
//
// enqueueEdit self-gates on the write-back switch, so 'apply' still sends nothing
// while scm.autocount_writeback is off. Both switches must be on to move a
// document; the relink half (link only) is the same either way.
// ----------------------------------------------------------------------------
import type { Env } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { callAcRead } from '../../services/autocount-host-read';
import { planLineRelink, type BookLine, type ErpLineForRelink } from './autocount-relink-lines';
import { classifyAcSkip } from './autocount-outbox-status';
import { DOWNSTREAM } from './autocount-convert-lines';
import { enqueueEdit } from './autocount-outbox';

type Sb = ReturnType<typeof getSupabaseService>;

/* The four conversion documents, taken from DOWNSTREAM rather than re-listed:
   its keys ARE this vocabulary, and a second copy of it is exactly the drift the
   duplicated-decision audit exists to stop. */
type SweepDocType = keyof typeof DOWNSTREAM;
const SWEEP_TYPES = Object.keys(DOWNSTREAM) as SweepDocType[];

export const RELINK_SWEEP_KEY = 'scm.autocount_relink_sweep';

export type SweepMode = 'off' | 'plan' | 'apply';

/**
 * The switch, read fresh. Never throws (a sweep failure must never break the
 * cron slot), and fails CLOSED to 'off' on anything it does not understand —
 * unlike the write-back flag it is NOT cached, because a sweep runs once every
 * five minutes and the owner turning it off must take effect on the very next
 * run, not up to thirty seconds later.
 */
export async function readRelinkSweepMode(sb: Sb): Promise<SweepMode> {
  try {
    const { data, error } = await sb
      .from('app_config')
      .select('value')
      .eq('key', RELINK_SWEEP_KEY)
      .maybeSingle();
    if (error) return 'off';
    const v = String((data as { value?: string } | null)?.value ?? '').trim().toLowerCase();
    return v === 'apply' ? 'apply' : v === 'plan' ? 'plan' : 'off';
  } catch {
    return 'off';
  }
}

export interface SweepDocResult {
  companyId: number;
  docType: SweepDocType;
  docId: string;
  bookDocNo: string;
  /** ERP lines that carried no key at the start of this run. */
  keylessBefore: number;
  /** Keys stamped this run (0 in plan mode — reported as `wouldStamp`). */
  stamped: number;
  wouldStamp: number;
  /** Lines planLineRelink could not match, named for a person. */
  refused: string[];
  /** True when a keyed edit was (or would be) queued this run. */
  enqueued: boolean;
  wouldEnqueue: boolean;
  /** Set when the document was looked at but skipped, with why. */
  skipped?: string;
}

export interface SweepSummary {
  mode: SweepMode;
  scanned: number;
  linesStamped: number;
  docsEnqueued: number;
  docs: SweepDocResult[];
}

const LIMIT = 25;

/**
 * One pass. Bounded to LIMIT distinct documents so a large backlog drains over
 * several cron slots rather than holding one slot open.
 */
export async function relinkHeldBackSweep(env: Env): Promise<SweepSummary> {
  const sb = getSupabaseService(env);
  const mode = await readRelinkSweepMode(sb);
  if (mode === 'off') return { mode, scanned: 0, linesStamped: 0, docsEnqueued: 0, docs: [] };

  /* The held-back conversion rows. `skipped` + kind keyless-line is the only
     class relink can fix; the item-code, Desc2 and sofa refusals need a
     different repair and are deliberately left for a person. Newest last so a
     document raised while a slot runs is caught next time, not skipped. */
  const { data: rows, error } = await sb
    .from('autocount_outbox')
    .select('id, company_id, doc_type, doc_id, doc_no, last_error, created_at')
    .in('doc_type', SWEEP_TYPES as unknown as string[])
    .eq('status', 'skipped')
    .is('archived_at', null)
    .not('doc_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) return { mode, scanned: 0, linesStamped: 0, docsEnqueued: 0, docs: [] };

  /* One document, however many queue rows it left. Keyed by company+type+id —
     the id is the header uuid enqueueConvert always stores. */
  const seen = new Set<string>();
  const targets: Array<{ companyId: number; docType: SweepDocType; docId: string }> = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    if (classifyAcSkip(r.last_error as string | null).kind !== 'keyless-line') continue;
    const companyId = Number(r.company_id);
    const docType = String(r.doc_type).toUpperCase() as SweepDocType;
    const docId = String(r.doc_id ?? '');
    if (!docId || !SWEEP_TYPES.includes(docType) || !Number.isFinite(companyId)) continue;
    const k = `${companyId}:${docType}:${docId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    targets.push({ companyId, docType, docId });
    if (targets.length >= LIMIT) break;
  }

  const docs: SweepDocResult[] = [];
  let linesStamped = 0;
  let docsEnqueued = 0;

  for (const t of targets) {
    const res = await relinkOneHeldBackDoc(sb, env, mode, t);
    docs.push(res);
    linesStamped += res.stamped;
    if (res.enqueued) docsEnqueued += 1;
  }

  return { mode, scanned: targets.length, linesStamped, docsEnqueued, docs };
}

async function relinkOneHeldBackDoc(
  sb: Sb,
  env: Env,
  mode: SweepMode,
  t: { companyId: number; docType: SweepDocType; docId: string },
): Promise<SweepDocResult> {
  const spec = DOWNSTREAM[t.docType];
  const base: SweepDocResult = {
    companyId: t.companyId, docType: t.docType, docId: t.docId, bookDocNo: '',
    keylessBefore: 0, stamped: 0, wouldStamp: 0, refused: [], enqueued: false, wouldEnqueue: false,
  };

  /* OURS, and in the book. The company predicate is the whole tenant boundary on
     the service client, and linked_ac_docno is the book number /doc-read needs;
     a document with none never reached AutoCount, so there is nothing to match. */
  const { data: header, error: hErr } = await sb
    .from(spec.table)
    .select('id, linked_ac_docno')
    .eq('id', t.docId)
    .eq('company_id', t.companyId)
    .maybeSingle();
  if (hErr) return { ...base, skipped: `header read failed: ${hErr.message}` };
  if (!header) return { ...base, skipped: 'document not found for this company' };
  const bookDocNo = (header as { linked_ac_docno?: string | null }).linked_ac_docno ?? '';
  if (!bookDocNo) return { ...base, skipped: 'no linked_ac_docno — the document is not in the account book' };

  const read = await callAcRead(env, 'doc_read', { DocType: t.docType, DocNo: bookDocNo });
  if (!read.ok) return { ...base, bookDocNo, skipped: `account book unreadable: ${read.error ?? 'unknown'}` };
  const body = read.body as { lines?: BookLine[] };
  const bookLines = Array.isArray(body.lines) ? body.lines : [];

  const { data: lineRows, error: lErr } = await sb
    .from(spec.itemTable)
    .select('id, item_code, description2, linked_ac_dtlkey')
    .eq(spec.itemFk, t.docId);
  if (lErr) return { ...base, bookDocNo, skipped: `line read failed: ${lErr.message}` };

  const erpLines: ErpLineForRelink[] = (lineRows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    /* The raw ERP code, deliberately — the same fail-closed choice the "Match up
       lines" route makes: a supplier's own spelling that the bindings would
       resolve simply will not match the book's and is refused, not guessed. */
    acItemCode: (r.item_code as string | null) ?? null,
    desc2: (r.description2 as string | null) ?? null,
    dtlKey: r.linked_ac_dtlkey == null ? null : Number(r.linked_ac_dtlkey),
  }));
  const keylessBefore = erpLines.filter((l) => !(Number.isFinite(Number(l.dtlKey)) && Number(l.dtlKey) > 0)).length;

  const plan = planLineRelink({ bookLines, erpLines });

  let stamped = 0;
  if (mode === 'apply') {
    for (const a of plan.assign) {
      const { error: uErr } = await sb
        .from(spec.itemTable)
        .update({ linked_ac_dtlkey: a.dtlKey })
        .eq('id', a.id)
        .eq('company_id', t.companyId)
        /* Only ever fills a BLANK — two sweeps or a backfill landing in between
           must not repoint a key that is already there. */
        .is('linked_ac_dtlkey', null);
      if (!uErr) stamped += 1;
      else plan.refused.push(`${a.itemCode}: ${uErr.message}`);
    }
  }

  /* THE ONE RUN THAT FINISHED THE KEYING. keylessAfter is what remains once this
     run's stamps (apply) or would-be stamps (plan) are applied. A keyed edit is
     queued ONLY when this run closed the last gap — stamped>0 AND nothing left
     keyless — so a document already fully keyed on a later sweep (stamped 0) is
     never re-queued, and one still carrying a keyless line is never queued. */
  const progressed = mode === 'apply' ? stamped : plan.assign.length;
  const keylessAfter = keylessBefore - progressed;
  const completesKeying = progressed > 0 && keylessAfter === 0;

  let enqueued = false;
  if (completesKeying && mode === 'apply') {
    /* No newLineIds: every line is keyed now, so composeDownstreamState names
       each book line by its key — a delta edit, never an append. enqueueEdit
       self-gates on the write-back switch and returns false when it is off. */
    enqueued = await enqueueEdit(sb, { companyId: t.companyId, docType: t.docType, docId: t.docId });
  }

  return {
    ...base,
    bookDocNo,
    keylessBefore,
    stamped,
    wouldStamp: mode === 'plan' ? plan.assign.length : 0,
    refused: plan.refused,
    enqueued,
    wouldEnqueue: completesKeying && mode === 'plan',
  };
}
