// ----------------------------------------------------------------------------
// autocount-held-edit-resend — an edit refused only because something it needed
// was still on its way goes out by itself once that has reached AutoCount.
//
// Two refusals say nothing about the document; they are about TIMING:
//
//   KeylessLineError             a line added a moment ago gets its AutoCount key
//                                only when the edit that added it drains, and a
//                                second save composed before then is refused.
//                                HC-SO-011153, 2026-09-15: line 9 added and sent
//                                at 06:14:34, the next save refused at 06:14:35.
//   "edited before its AutoCount the document's own conversion was still queued.
//    counterpart existed"        HC-SI-2609-001, 2026-09-14.
//
// Both rows carry an empty payload, so there is nothing to retry, and nothing
// sent the document again: the operator had saved and moved on, and the change
// stayed out of the account book until someone read the AutoCount Sync page.
//
// After a row of a document is marked sent, this looks for such a refusal of the
// same document. When no edit of it is still queued and none has gone since the
// refusal, it composes the document AS IT IS NOW through the ordinary
// enqueueEdit, so every guard the save route has still applies: a line that has
// no key yet is refused and written down again, never guessed.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AcDocType } from '../../services/autocount-writeback';
import { REQUEUE_NOTE_PREFIX, isRequeuedNote } from './autocount-outbox-status';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client type autocount-outbox.ts hands in (its own Sb)
type Sb = SupabaseClient<any, any, any>;

/** The refusals that are about timing, by the text their rows begin with. */
export const HELD_EDIT_REASONS = [
  'refused, nothing sent (KeylessLineError):',
  'edited before its AutoCount counterpart existed:',
] as const;

/** enqueueEdit, passed in: this module is called FROM the outbox module, and a
 *  runtime import back into it would make the two load each other. */
export type HeldEditEnqueue = (opts: {
  companyId: number;
  docType: AcDocType;
  docNo: string;
  docId: string | null;
  createdBy: null;
}) => Promise<boolean>;

export type HeldEditOutcome = 'none' | 'queued' | 'not_queued';

type EditRow = {
  id: string;
  status: string;
  doc_id: string | null;
  last_error: string | null;
  created_at: string;
  payload: { body?: { Lines?: unknown } } | null;
};

/* The payment's header-only edit (ac-so-payment-edit.ts) is an `edit` with
   `Lines: []`: it carries the balance and nothing a refused save was holding. */
const carriesLines = (r: EditRow): boolean => {
  const lines = r.payload?.body?.Lines;
  return Array.isArray(lines) && lines.length > 0;
};

export const isHeldEditRefusal = (lastError: string | null | undefined): boolean =>
  !isRequeuedNote(lastError) && HELD_EDIT_REASONS.some((r) => (lastError ?? '').startsWith(r));

export async function resendHeldEdits(
  sb: Sb,
  sent: { company_id: number; doc_type: AcDocType; doc_no: string; doc_id: string | null; op: string },
  enqueue: HeldEditEnqueue,
): Promise<HeldEditOutcome> {
  const docType = sent.doc_type;
  if (sent.op === 'cancel' || !sent.doc_no) return 'none';
  try {
    const { data, error } = await sb.from('autocount_outbox')
      .select('id, status, doc_id, last_error, created_at, payload')
      .eq('company_id', sent.company_id)
      .eq('doc_type', docType)
      .eq('doc_no', sent.doc_no)
      .eq('op', 'edit')
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return 'none';
    /* Nullable before defaulting: PostgREST answers a failed read with a null body. */
    const edits = (data as EditRow[] | null) ?? [];

    const held = edits.filter((r) => r.status === 'skipped' && isHeldEditRefusal(r.last_error));
    if (!held.length) return 'none';
    /* A queued edit will compose the document itself when it goes, and this runs
       again after it. Composing now, around it, could send a line the queued one
       is about to add. */
    if (edits.some((r) => r.status === 'pending')) return 'none';
    const newestHeld = held.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
    /* An edit of the lines that went after the refusal carried a later state already. */
    if (edits.some((r) => r.status === 'sent' && carriesLines(r) && r.created_at > newestHeld.created_at)) return 'none';

    const docId = newestHeld.doc_id ?? sent.doc_id ?? null;
    /* An SO is composed by its number; every other type only by its row id. */
    if (docType !== 'SO' && !docId) return 'not_queued';

    const queued = await enqueue({ companyId: sent.company_id, docType, docNo: sent.doc_no, docId, createdBy: null });
    if (!queued) return 'not_queued';

    const note = `${REQUEUE_NOTE_PREFIX} ${new Date().toISOString()} -> sent again by itself after ${sent.op} reached AutoCount] `;
    for (const r of held) {
      await sb.from('autocount_outbox')
        .update({ last_error: note + (r.last_error ?? ''), updated_at: new Date().toISOString() })
        .eq('id', r.id)
        .eq('status', 'skipped');
    }
    return 'queued';
  } catch (e) {
    /* Best effort. The row that triggered this is already marked sent, and a
       failure here leaves the refusal on the page exactly as it was before. */
    // eslint-disable-next-line no-console
    console.error(`[autocount-outbox] held edit of ${sent.doc_type} ${sent.doc_no} not re-sent:`, e instanceof Error ? e.message : String(e));
    return 'none';
  }
}
