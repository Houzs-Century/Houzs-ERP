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
    const edits = (data as EditRow[] | null) ?? [];

    const held = edits.filter((r) => r.status === 'skipped' && isHeldEditRefusal(r.last_error));
    if (!held.length) return 'none';
    if (edits.some((r) => r.status === 'pending')) return 'none';
    const newestHeld = held.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
    if (edits.some((r) => r.status === 'sent' && carriesLines(r) && r.created_at > newestHeld.created_at)) return 'none';

    const docId = newestHeld.doc_id ?? sent.doc_id ?? null;
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
    // eslint-disable-next-line no-console
    console.error(`[autocount-outbox] held edit of ${sent.doc_type} ${sent.doc_no} not re-sent:`, e instanceof Error ? e.message : String(e));
    return 'none';
  }
}
