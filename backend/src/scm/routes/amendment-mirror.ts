// ----------------------------------------------------------------------------
// /amendment-mirror — LIVE receiver for the 2990 -> Houzs one-way SO AMENDMENT
// mirror. The owner's ask: an amendment raised in 2990 must show up in Houzs.
//
// The 2990 database (via pg_cron + pg_net) POSTs each changed amendment here as
// { amendmentId, header, lines } (raw 2990-shaped rows) or { amendmentId,
// deleted:true }. Same shape, same auth, same transform rules as so-mirror.ts —
// see docs/2990-live-sync/04_amendment_outbox_2990.sql for the sender.
//
// ONE-WAY, READ-ONLY. Nothing here writes back to 2990 and Houzs cannot drive a
// mirrored amendment: all five mutation gates in routes/so-amendments.ts load
// through loadAmendmentForWrite, which refuses when isMirroredDocNo(so_doc_no).
// Because we stamp `2990-` on so_doc_no below, every row this route writes is
// read-only in Houzs BY CONSTRUCTION. The command channel (approving from Houzs)
// is a separate build and deliberately does not exist yet.
//
// AUTH: the same static shared secret as so-mirror (x-sync-secret ==
// env.SYNC_SECRET) — the caller is the same 2990 database, not a user with a
// Supabase JWT. Fail-closed when the secret is unset.
//
// Mounted at '/api/sync/amendment-mirror' in src/index.ts — PRE-AUTH, above the
// /api/* staff-session gate, because the caller is a database with no session.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../../types';
import { C2990, createMirrorMapper, mirrorAuthed, prefixDoc, upsert } from '../lib/mirror-map';

export const amendmentMirror = new Hono<{ Bindings: Env }>();

/* Status vocabulary guard. Unlike the SO mirror's normalizeStatus — which
   coerces an unknown value to CONFIRMED because the richer SO states are all
   DERIVED — an amendment's status IS its state machine, and scm.so_amendments.
   status is a Postgres ENUM. There is no safe "nearest" value: guessing would
   report a fabricated approval state on a document that gates a financial
   rewrite. So we REFUSE an unknown status instead of coercing it. The refusal is
   non-2xx, so 2990's confirm_amendment_outbox() puts the row back to 'pending'
   and retries forever, and the drift surfaces as a stall the sentinel alarms on
   rather than as a wrong number nobody notices. */
const CANON_AMENDMENT_STATUS = new Set([
  'REQUESTED', 'SUPPLIER_PENDING', 'SO_APPROVED', 'PO_APPROVED', 'SENT', 'REJECTED',
]);

/* Per-table transform rules. so_amendment_lines needs none beyond the shared
   company_id stamp + dest-column filtering: it carries no doc numbers, and its
   sales_order_item_id points at scm.mfg_sales_order_items.id, which so-mirror
   writes VERBATIM — so the reference still resolves after the SO mirror's
   delete-and-reinsert of that SO's lines. That is D4 (verbatim identity) paying
   for itself; a remap here would dangle every line reference. */
const { tableMap, applyMap } = createMirrorMapper({
  so_amendments: {
    // so_doc_no FKs to scm.mfg_sales_orders(doc_no), whose mirrored value is
    // prefixed — unprefixed would be an instant FK violation. amendment_no is
    // minted by 2990 as `${so_doc_no}/A${n}`, so the prefix flows through it too
    // and a mirrored amendment reads `2990-SO-2607-006/A1`.
    prefixCols: ['so_doc_no', 'amendment_no'],
    // header_changes / old_header_snapshot are Houzs-only (mig 0119) and have no
    // 2990 equivalent: 2990's amendments carry line changes ONLY. NULL is the
    // schema's own encoding of "line changes only" (0119's header says so), so
    // forcing NULL states the truth about a 2990 amendment rather than leaving a
    // Houzs-authored value to be misread as 2990's intent.
    forceCols: { header_changes: null, old_header_snapshot: null },
    normalize: {
      status: (v: unknown) => {
        const s = v == null ? '' : String(v).trim().toUpperCase();
        if (!CANON_AMENDMENT_STATUS.has(s)) throw new Error(`unknown_amendment_status:${String(v)}`);
        return s;
      },
    },
  },
  so_amendment_lines: {},
});

amendmentMirror.post('/', async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  let body: {
    amendmentId?: string;
    deleted?: boolean;
    header?: Record<string, unknown>;
    lines?: Record<string, unknown>[];
  };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const id = String(body.amendmentId ?? body.header?.id ?? '').trim();
  if (!id) return c.json({ error: 'amendment_id_required' }, 400);
  const DB = c.env.DB;

  try {
    // DELETE: amendment removed in 2990 -> drop the mirror (lines cascade on the
    // amendment_id FK). Scoped to company 2 so a bad id can never reach a
    // Houzs-native amendment.
    if (body.deleted) {
      await DB.prepare(`DELETE FROM scm."so_amendments" WHERE company_id=? AND id=?`).bind(C2990, id).run();
      return c.json({ ok: true, amendmentId: id, action: 'deleted' });
    }
    if (!body.header) return c.json({ error: 'header_required' }, 400);

    const hMap = await tableMap(DB, 'so_amendments');
    const lMap = await tableMap(DB, 'so_amendment_lines');

    // header — upsert by id (uuid PK, carried VERBATIM from 2990, so a retry
    // converges onto the same row instead of minting a second one).
    await upsert(DB, 'so_amendments', applyMap(body.header, hMap), 'id');

    // lines — replace the whole set for this amendment (delete-then-insert) so a
    // line removed from the request in 2990 disappears here too. Same
    // replace-set semantics as so-mirror's items/payments. Idempotent.
    await DB.prepare(`DELETE FROM scm."so_amendment_lines" WHERE company_id=? AND amendment_id=?`).bind(C2990, id).run();
    for (const l of body.lines ?? []) await upsert(DB, 'so_amendment_lines', applyMap(l, lMap), 'id');

    return c.json({ ok: true, amendmentId: id, lines: (body.lines ?? []).length });
  } catch (e) {
    // Non-2xx -> 2990's drainer keeps the outbox row pending and retries. Zero-loss.
    // The reason lands in 2990's net._http_response.content, which is where an
    // operator reads it. Two expected, self-describing failures:
    //   * so_amendments_so_doc_no_fk — the parent SO has not mirrored yet (the
    //     two outboxes are independent and unordered). Retry converges once the
    //     SO arrives; no action needed.
    //   * so_amendments_requested_by_fk (or the other actor FKs) — a 2990 staff
    //     member hired AFTER the one-time import does not exist in scm.staff.
    //     This does NOT self-heal: it needs the masters mirror (design D6/Phase 1)
    //     or a staff backfill. See BUG-HISTORY / the PR notes.
    //   * uq_so_amendment_open — another OPEN amendment already exists on this
    //     so_doc_no (e.g. the hand-copied artifact row). Purge it; the mirror
    //     will re-create it correctly.
    return c.json({ error: 'mirror_failed', reason: (e as Error).message }, 500);
  }
});
