// ----------------------------------------------------------------------------
// autocount-stale-key-recompose — a keyed edit AutoCount refused because the
// line it names was RE-KEYED in the ERP goes out again, composed as the document
// stands now, once. The sibling of autocount-held-edit-resend (docs/bugs/0924):
// that one is about a line whose key had not arrived YET; this one is about a
// line whose key is already GONE.
//
// The production case is HC-SO-011654 on 2026-09-15 (handoff, 13:00Z). A line
// was deleted in the ERP at 10:21:01; the save was a Rebuild that deleted the
// book's 7 lines and added 6 with fresh DtlKeys 931973–931978, and the ERP
// stored those. Five ordinary edits composed 10:21:08–10:22:05 still named the
// OLD keys 803471–803477, and AcSyncService answered each of them
// `line 803474 not found on SO-011654` (AcSyncService.cs:3729) six times until
// they gave up `failed`. The drain REPLAYS a stored payload and never
// recomposes, so a refusal like this can never succeed on retry: the payload
// names a key that no longer exists.
//
// THE ONE DISTINCTION THAT MATTERS. A book line the ERP no longer carries under
// that key means the ERP re-keyed it — compose the document as it is now and it
// goes. A book line the ERP STILL carries under that key means the account book
// itself lost the line (a person deleted it in AutoCount); recomposing would
// send the very same key again, so it is left failing for a person to see. The
// deciding read is the ERP's own live lines, never the message text.
// ----------------------------------------------------------------------------
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AcDocType } from '../../services/autocount-writeback';
import { REQUEUE_NOTE_PREFIX, isRequeuedNote } from './autocount-outbox-status';
import type { HeldEditEnqueue } from './autocount-held-edit-resend';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client type autocount-outbox.ts hands in (its own Sb)
type Sb = SupabaseClient<any, any, any>;

/**
 * The account book's words when a keyed edit names a line the book no longer
 * holds under that key: `line <DtlKey> not found on <docNo>`
 * (AcSyncService.cs:3729). The DtlKey is the only reliable thing in it — the
 * DocNo there is the BOOK number, and the key alone decides everything below.
 */
export function refusedDtlKey(lastError: string | null | undefined): number | null {
  const text = lastError ?? '';
  /* A re-queued row is history: its document is queued or sent under a newer
     row, and re-reading its old refusal would recompose a second time. */
  if (isRequeuedNote(text)) return null;
  const m = text.match(/line (\d+) not found on /);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Is this a line-not-found refusal we can act on (and not already re-queued)? */
export const isStaleKeyRefusal = (lastError: string | null | undefined): boolean =>
  refusedDtlKey(lastError) != null;

/**
 * The ERP's live line keys for a document — the authority on whether a refused
 * key was re-keyed (gone) or is still carried (the book lost the line).
 *
 * An SO's lines are keyed by its document number, a PO's by its row id, exactly
 * as composeSoState / composePoState read them. Cancelled lines are INCLUDED:
 * the SDK offers no line delete, so a cancelled ERP line keeps its DtlKey and
 * the book keeps it at quantity zero — its key is still "on the document". Only
 * a rebuild, which deletes and re-adds, actually retires a key.
 */
export type LiveLineKeys = (docType: AcDocType, docNo: string, docId: string | null) => Promise<Set<number>>;

export async function liveLineKeys(
  sb: Sb,
  docType: AcDocType,
  docNo: string,
  docId: string | null,
): Promise<Set<number>> {
  const q = docType === 'SO'
    ? sb.from('mfg_sales_order_items').select('linked_ac_dtlkey').eq('doc_no', docNo)
    : sb.from('purchase_order_items').select('linked_ac_dtlkey').eq('purchase_order_id', String(docId ?? docNo));
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const out = new Set<number>();
  for (const r of (data as Array<{ linked_ac_dtlkey: unknown }> | null) ?? []) {
    const n = r.linked_ac_dtlkey == null ? NaN : Number(r.linked_ac_dtlkey);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return out;
}

export type StaleKeyOutcome =
  /** Not a line-not-found refusal, or a newer edit already carries the state, or
   *  the document cannot be composed — do nothing and let normal handling run. */
  | { kind: 'none' }
  /** The ERP still carries the refused key: the account book lost the line, not
   *  the ERP. Leave it failing for a person. */
  | { kind: 'office_changed'; key: number }
  /** The ERP re-keyed the line; a fresh edit of the document as it now stands
   *  was queued. */
  | { kind: 'queued'; key: number };

type EditRow = { id: string; status: string; created_at: string };

/**
 * Decide what to do about a keyed `edit` the account book refused as
 * line-not-found, and — when the ERP has re-keyed the line — queue one fresh
 * edit composed from the document as it stands now.
 *
 * Injected `enqueue` and `liveKeys` keep this testable and keep the module free
 * of a runtime import back into autocount-outbox.ts, which calls it.
 */
export async function recomposeStaleKeyedEdit(
  sb: Sb,
  failed: {
    id: string;
    company_id: number;
    doc_type: AcDocType;
    doc_no: string | null;
    doc_id: string | null;
    op: string;
    last_error: string | null;
  },
  enqueue: HeldEditEnqueue,
  liveKeys: LiveLineKeys,
): Promise<StaleKeyOutcome> {
  /* Only a keyed edit of an SO or a PO composes a line-keyed state from live
     rows; a conversion carries a stored instruction and a cancel carries none. */
  if (failed.op !== 'edit' || !failed.doc_no) return { kind: 'none' };
  if (failed.doc_type !== 'SO' && failed.doc_type !== 'PO') return { kind: 'none' };
  const key = refusedDtlKey(failed.last_error);
  if (key == null) return { kind: 'none' };
  /* An SO is composed by its number; a PO only by its row id. */
  const docId = failed.doc_id ?? null;
  if (failed.doc_type === 'PO' && !docId) return { kind: 'none' };

  let live: Set<number>;
  try {
    live = await liveKeys(failed.doc_type, failed.doc_no, docId);
  } catch {
    /* Could not read the ERP's own lines — decide nothing rather than guess. */
    return { kind: 'none' };
  }
  /* The ERP STILL carries the key the book refused. The book lost the line, not
     the ERP; sending the same key again would be refused the same way. */
  if (live.has(key)) return { kind: 'office_changed', key };

  /* Re-keyed. Compose once: if a newer edit of this document is already queued
     or has gone, it carries the current state and this recompose would be a
     duplicate. `created_at` is read here, not off the row, because AcOutboxRow
     does not carry it. */
  try {
    const { data, error } = await sb.from('autocount_outbox')
      .select('id, status, created_at')
      .eq('company_id', failed.company_id)
      .eq('doc_type', failed.doc_type)
      .eq('doc_no', failed.doc_no)
      .eq('op', 'edit')
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return { kind: 'none' };
    const edits = (data as EditRow[] | null) ?? [];
    const me = edits.find((r) => r.id === failed.id);
    if (!me) return { kind: 'none' };
    const newerLiveEdit = edits.some(
      (r) => r.id !== failed.id && r.created_at > me.created_at && (r.status === 'pending' || r.status === 'sent'),
    );
    if (newerLiveEdit) return { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }

  const queued = await enqueue({
    companyId: failed.company_id,
    docType: failed.doc_type,
    docNo: failed.doc_no,
    docId,
    createdBy: null,
  });
  return queued ? { kind: 'queued', key } : { kind: 'none' };
}

/**
 * The note prepended to the refused row when a recompose is queued, so the page
 * folds it as Replaced (isRequeuedNote) rather than counting it as open.
 */
export function staleKeyReplacedNote(key: number, at: Date = new Date()): string {
  return `${REQUEUE_NOTE_PREFIX} ${at.toISOString()} -> re-composed with the current line keys after a rebuild retired line ${key}] `;
}
