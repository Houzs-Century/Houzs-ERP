import type { Env } from '../env';
import { getSupabaseService } from '../../db/supabase';
import { callAcRead } from '../../services/autocount-host-read';
import { planLineRelink, type BookLine, type ErpLineForRelink } from './autocount-relink-lines';
import { classifyAcSkip } from './autocount-outbox-status';
import { DOWNSTREAM } from './autocount-convert-lines';
import { enqueueEdit, bindingsFor } from './autocount-outbox';
import { resolveAcItemCode } from '../../services/autocount-item-code';

type Sb = ReturnType<typeof getSupabaseService>;

type SweepDocType = keyof typeof DOWNSTREAM;
const SWEEP_TYPES = Object.keys(DOWNSTREAM) as SweepDocType[];

export const RELINK_SWEEP_KEY = 'scm.autocount_relink_sweep';

/**
 * WHERE THE LAST RUN WRITES ITSELF DOWN, and why it has to.
 *
 * This sweep reads and writes a LIVE account book, and until 2026-09-11 its only
 * output was `console.log("[cron ac-relink-sweep] …")` in index.ts — a Worker log
 * this account's token cannot read, because `wrangler tail` on
 * autocount-sync-api is DENIED for it. So when the sweep ran in `apply` on
 * 2026-09-11 and stamped ZERO keys on all five held-back documents, the cause
 * could not be established at all: the handoff of that day filed it UNKNOWN and
 * named making this observable as the next action. It was then run twice more,
 * after a real fix to the matcher (docs/bugs/0812), and stamped zero again —
 * still with nothing to read. Two rounds of guessing is the cost this key pays
 * off.
 *
 * `scm.app_config` and not a new table: this module already reads its switch
 * from there, it is flippable without a deploy, and a run summary is operational
 * state of exactly that kind. The value is a trimmed JSON — counts always, and
 * the per-document refusals that say WHY, which is the part nobody could see.
 */
export const RELINK_SWEEP_RUN_KEY = 'scm.autocount_relink_sweep_last_run';

const RUN_DOCS_KEPT = 25;

/**
 * Write the run down where a read-only workflow can find it.
 *
 * BEST-EFFORT, and deliberately so: this is a report about a repair, and a
 * report that fails must never cost the repair. It is awaited rather than
 * fired-and-forgotten only so the row is there before the slot ends.
 */
export async function recordSweepRun(sb: Sb, summary: SweepSummary): Promise<void> {
  try {
    const value = JSON.stringify({
      at: new Date().toISOString(),
      mode: summary.mode,
      scanned: summary.scanned,
      linesStamped: summary.linesStamped,
      docsEnqueued: summary.docsEnqueued,
      docs: summary.docs.slice(0, RUN_DOCS_KEPT).map((d) => ({
        docType: d.docType,
        bookDocNo: d.bookDocNo,
        keylessBefore: d.keylessBefore,
        stamped: d.stamped,
        wouldStamp: d.wouldStamp,
        /* WILL THIS DOCUMENT ACTUALLY MOVE. A run can match every line it is
           able to and still queue nothing, and without this the report showed
           "1 matched" for a document that was about to be released and for one
           that was still stuck — the same two words for opposite outcomes.
           `enqueued` in apply, `wouldEnqueue` in plan, so a plan run answers it
           before anything is written (docs/bugs/0819). */
        enqueued: d.enqueued,
        wouldEnqueue: d.wouldEnqueue,
        refused: d.refused,
        skipped: d.skipped ?? null,
      })),
    });
    await sb.from('app_config').upsert(
      { key: RELINK_SWEEP_RUN_KEY, value, description: 'Last AutoCount relink sweep run (read-only report)' },
      { onConflict: 'key' },
    );
  } catch {
  }
}

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
  keylessBefore: number;
  stamped: number;
  wouldStamp: number;
  refused: string[];
  enqueued: boolean;
  wouldEnqueue: boolean;
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

  const { data: rows, error } = await sb
    .from('autocount_outbox')
    .select('id, company_id, doc_type, doc_id, doc_no, last_error, created_at')
    .in('doc_type', SWEEP_TYPES as unknown as string[])
    .eq('status', 'skipped')
    .is('archived_at', null)
    .not('doc_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) {
    const summary: SweepSummary = { mode, scanned: 0, linesStamped: 0, docsEnqueued: 0, docs: [] };
    await recordSweepRun(sb, { ...summary, docs: [{
      companyId: 0, docType: 'GR' as SweepDocType, docId: '', bookDocNo: '',
      keylessBefore: 0, stamped: 0, wouldStamp: 0, refused: [], enqueued: false,
      wouldEnqueue: false, skipped: `candidate read failed: ${error.message}`,
    }] });
    return summary;
  }

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

  const summary: SweepSummary = { mode, scanned: targets.length, linesStamped, docsEnqueued, docs };
  await recordSweepRun(sb, summary);
  return summary;
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

  const rowsIn = lineRows as Array<Record<string, unknown>>;
  const bindings = await bindingsFor(
    sb, t.companyId, rowsIn.map((r) => String(r.item_code ?? '')),
  ).catch(() => new Map<string, string>());
  const erpLines: ErpLineForRelink[] = rowsIn.map((r) => {
    /* THE BOOK'S SPELLING, NOT OURS — and this is the follow-up the old comment
       here promised and never did (docs/bugs/0816).

       `ErpLineForRelink.acItemCode` is documented as "what the write-back SENDS
       for this row — the book's spelling, not ours". Both callers passed the RAW
       `item_code` instead, and said so: "Resolving properly is the follow-up,
       not a silent widening." The follow-up is this.

       It is the whole reason the sweep stamped zero. The ERP holds
       `AKEMI ARMOUR MATT (SK)`; the account book holds `AK-ARMOUR MATT (SK)`,
       because composeEdit resolves every code through the cutover bindings
       before sending it. Matching on the raw code compares our spelling against
       theirs, so EVERY line of EVERY document whose supplier spells things
       differently was refused with "the account book has no unclaimed line with
       that item code" — which is exactly what the first readable sweep report
       said, on all 13 documents, the moment one existed (docs/bugs/0815).

       STILL FAIL-CLOSED. An unresolvable code falls back to the raw one, which
       is today's behaviour and refuses; resolution only ever turns a guaranteed
       miss into a possible match, never a wrong one into a confident one. */
    const own = (r.item_code as string | null) ?? null;
    const res = own ? resolveAcItemCode(own, { bindings }) : null;
    return {
      id: String(r.id),
      acItemCode: res?.ok ? res.acItemCode : own,
      desc2: (r.description2 as string | null) ?? null,
      dtlKey: r.linked_ac_dtlkey == null ? null : Number(r.linked_ac_dtlkey),
    };
  });
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
        .is('linked_ac_dtlkey', null);
      if (!uErr) stamped += 1;
      else plan.refused.push(`${a.itemCode}: ${uErr.message}`);
    }
  }

  const progressed = mode === 'apply' ? stamped : plan.assign.length;
  const keylessAfter = keylessBefore - progressed;
  const completesKeying = progressed > 0 && keylessAfter === 0;

  /* ── THE LINE THE BOOK NEVER HAD (docs/bugs/0817) ───────────────────────────
     Nine goods receipts stood at "1 of 2 matched" and could not move: the
     mattress matched, and the free pillow that rides with it refused, because
     the account book's copy of that receipt has no pillow line at all. The
     conversion transferred the purchase order's lines and the pillow was never
     one of them, so no amount of matching will ever key it — it is not a line
     we failed to find, it is a line the book does not have.

     ACSYNCSERVICE NAMES THIS EXIT ITSELF, in the refusal it raises:
       "Store the line's AutoCount DtlKey (scm.*_items.linked_ac_dtlkey)
        or mark the line IsNewLine, then retry."
     `IsNewLine` is the sanctioned second way, and `enqueueEdit` has carried
     `newLineIds` since docs/bugs/0588. This path simply never used it.

     WHAT MAKES THE DECLARATION HONEST, and both halves are required:
       · every OTHER line on the document is keyed — which is what this run just
         finished doing, and is the same condition composeEdit already demands
         before it will believe a declared-new line;
       · the book carries NO line with that item code, claimed or not
         (`plan.absent`, not the "no unclaimed line" sentence) — so there is
         nothing on the document this row could be a second copy of.

     WHY THE BAR IS THAT HIGH. This SDK gives DeleteDetail to SalesOrder alone.
     A duplicate appended to a purchase order or a goods receipt is permanent,
     and the whole keyless guard exists because of it. A declaration that is
     merely probable would be worse than the refusal it replaces. */
  const absentIds = plan.absent.map((a) => a.id);
  const declaresNew = absentIds.length > 0
    && progressed > 0
    && keylessAfter === absentIds.length
    && plan.refused.length === absentIds.length;

  let enqueued = false;
  if ((completesKeying || declaresNew) && mode === 'apply') {
    enqueued = await enqueueEdit(sb, {
      companyId: t.companyId,
      docType: t.docType,
      docId: t.docId,
      ...(declaresNew ? { newLineIds: absentIds } : {}),
    });
  }

  return {
    ...base,
    bookDocNo,
    keylessBefore,
    stamped,
    wouldStamp: mode === 'plan' ? plan.assign.length : 0,
    refused: plan.refused,
    enqueued,
    wouldEnqueue: (completesKeying || declaresNew) && mode === 'plan',
  };
}
