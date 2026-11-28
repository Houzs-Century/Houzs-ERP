// ----------------------------------------------------------------------------
// /so-mirror — IMPORT-ONCE receiver for the 2990 -> Houzs SO mirror.
//
// The 2990 database (via pg_cron + pg_net) POSTs each changed SO here as
// { docNo, header, items, payments } (raw 2990-shaped rows) or { docNo,
// deleted:true }. We apply the SAME transform as the batch importer
// (migrate-2990-into-houzs.mjs) — 2990- doc-no prefix, company_id=2, and every
// id copied VERBATIM (never remapped — see lib/mirror-map.ts).
//
// THE CONTRACT CHANGED 2026-08-20, AND A STALE COMMENT HERE IS HOW THE OLD ONE
// SURVIVED THE CUTOVER. This header used to read "idempotently UPSERT by
// doc_no. Retried deliveries never duplicate", which describes a LIVE replica
// and was true before the flip. Houzs took over the 2990 write path on
// 2026-07-21 (HOUZS_OWNS_2990="true", companyScope.houzsOwns2990): the POS
// writes 2990- Sales Orders natively here, Houzs mints their doc numbers, and
// the readonly wall in mfg-sales-orders.ts lifts so staff can EDIT them. This
// receiver went on replaying 2990's older copy over those edits — and because
// it replaced the item set with a DELETE-then-INSERT, every replay blanked the
// Delivery-Order lines pointing at those SO lines through the FK's ON DELETE
// SET NULL. Ten such orphaned delivery lines across four documents were live on
// 2026-08-20, whole documents at a time — which is the shape only a
// whole-item-set replacement produces.
//
// WHAT THIS IS *NOT*, corrected 2026-08-20 before it could mislead anyone. This
// comment first said "Owner-visible: a delivery fee edited 250 -> 125 came back
// as 250, and the order went to 0 items". That symptom is NOT this route's.
// 2990's outbox (`public.sync_outbox`) shows the last successful delivery at
// 2026-08-19T08:42:39Z with pending=0 and sent=0 since, read by
// mirror-drift-sentinel.mjs; the fee edits postdate it, and the deletes behind
// them carry application_name "PostgREST 14.5" — the Houzs fee rebuild, not
// this receiver, which reaches Postgres through postgres.js. The fee symptom
// was three Houzs-side faults, all fixed there: #2490 (rebuild wrote
// discount_sen 0 over the discount), #2514 / mig 0310 (rebuild replaced the
// SVC-DELIVERY* rows so they changed id), #2516 (the discount was read-only in
// SoLineCard, so nobody could type one). Import-once stands on the orphaned
// links, which is evidence it does carry.
//
// SO THE RULE IS NOW: THE FIRST DELIVERY WINS, AND ONLY THE FIRST.
//
//   doc_no absent for company 2   -> import it exactly as before (header, then
//                                    the whole item + payment set).
//   doc_no already present        -> touch NOTHING. 200 + skipped_existing —
//                                    or skipped_conflict when the delivery
//                                    names a DIFFERENT customer than the row
//                                    Houzs holds (see soMirrorSkipAction).
//   deleted:true on a present doc -> REFUSE. 200 + refused_delete. Houzs owns
//                                    the lifecycle of these orders now, so a
//                                    2990-side delete must not drop one.
//
// WHY 200 AND NOT 409 ON A SKIP. The caller is 2990's pg_cron drainer and it
// keys on HTTP STATUS — non-2xx keeps the outbox row PENDING and it retries
// forever, so one refused order wedges the queue behind it and every later SO
// stops arriving. A skip IS a successful delivery of a message we chose not to
// apply: 200, a flag in the body, a loud log line, and a DURABLE ROW. Never a
// non-2xx. (The same reasoning already governs the pair gate below.)
//
// THE DURABLE ROW IS WHAT MAKES THE REFUSAL PROVABLE (mig 0311,
// scm.so_mirror_skips). Without it the only evidence a delivery was declined is
// a console line nobody was tailing — and with 2990's outbox idle, "I edited a
// 2990 order and it survived" is equally true of a mirror that held the line
// and a mirror that sent nothing. `last_seen` moving beside a surviving edit is
// the proof; `last_seen` not moving says the mirror was quiet and the test
// proved nothing. Read it with scripts/check-so-mirror-skips.mjs.
//
// FIRST-IMPORT ATOMICITY, and the window it closes is not theoretical. A
// failure BETWEEN the header write and the items would leave a header-only
// order that the retry then SKIPS — the exact "0 items" symptom, reintroduced
// by the fix. On 2026-08-19 the payments upsert really did die on amount_sen's
// NOT NULL and retry every 10 seconds (mirror-map.ts's alias note has the
// trace); nothing was lost only because the retry replayed the whole document.
// So the header is the COMMIT MARKER: if any part of a FIRST import throws, we
// remove the header we just created before returning 500, and the retry redoes
// the document from scratch.
//
// AUTH: a static shared secret (x-sync-secret == env.SYNC_SECRET), because the
// caller is a database (pg_net), not a user with a Supabase JWT. Service-only.
//
// Mounted at '/api/sync/so-mirror' in src/index.ts — PRE-AUTH, above the /api/*
// staff-session gate, because the caller is a database with no session.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../../types';
import { C2990, createMirrorMapper, mirrorAuthed, prefixDoc, upsert } from '../lib/mirror-map';
import {
  SO_PROCESSING_DATE_COLUMN,
  SO_PROCESSING_DATE_LEGACY_COLUMNS,
} from '../shared/so-processing-date';

export const soMirror = new Hono<{ Bindings: Env }>();

const CANON_SO_STATUS = new Set(['DRAFT', 'CONFIRMED', 'CANCELLED']);
function normalizeStatus(v: unknown): unknown {
  if (v == null) return v;
  const s = String(v).trim().toUpperCase();
  return CANON_SO_STATUS.has(s) ? s : 'CONFIRMED';
}

const SO_HEADER_ALIASES: Record<string, string> = Object.fromEntries(
  SO_PROCESSING_DATE_LEGACY_COLUMNS.map((legacy) => [legacy, SO_PROCESSING_DATE_COLUMN]),
);

const { tableMap, applyMap } = createMirrorMapper({
  mfg_sales_orders: {
    prefixCols: ['doc_no', 'cross_category_source_doc_no'],
    forceCols: { venue_id: null },
    normalize: { status: normalizeStatus },
    aliasCols: SO_HEADER_ALIASES,
  },
  mfg_sales_order_items: { prefixCols: ['doc_no'] },
  mfg_sales_order_payments: { prefixCols: ['so_doc_no'] },
});

/* date-pair-ok: NO PAIR GATE HERE, a decision (2026-08-14). This route replicates
   rows 2990 already committed; refusing one keeps it PENDING in 2990's outbox
   and wedges every later SO behind it. The pair rule for company 2 belongs in
   2990's own write paths. Count unpaired rows with probe-so-date-xor.mjs. */
async function recordSkip(DB: Env['DB'], doc: string, action: 'skipped_existing' | 'skipped_conflict' | 'refused_delete') {
  try {
    await DB.prepare(
      `INSERT INTO scm."so_mirror_skips" (company_id, doc_no, action)
            VALUES (?, ?, ?)
       ON CONFLICT (company_id, doc_no, action)
       DO UPDATE SET hits = scm."so_mirror_skips".hits + 1, last_seen = now()`,
    ).bind(C2990, doc, action).run();
  } catch (e) {
    console.error('[so-mirror] could not record the declined delivery — the refusal still stands:', doc, action, (e as Error).message);
  }
}

/* SKIPPED-EXISTING CONFLATES TWO CASES, and only one of them is benign
 * (2026-08-21, found while investigating 2990-SO-2607-019):
 *
 *   1. A RE-DELIVERY of an order Houzs already imported — the outbox retrying,
 *      or a full re-send. Skipping is correct and boring.
 *   2. A DIFFERENT ORDER wearing a doc_no Houzs already holds. 2990's own SO
 *      series is minted bare (`SO-2607-019`, max+1 over ITS rows) and cannot
 *      see the numbers Houzs mints natively for company 2 (`2990-SO-2607-019`),
 *      so both sides can hand out the same suffix — a split-brain double-mint.
 *      prefixDoc then lands both on ONE Houzs key. Before import-once (#2515)
 *      that OVERWROTE: on 2026-07-26 a POS-side order took `SO-2607-019` and
 *      its delivery replaced 2990-SO-2607-019 — Larding Chen's paid sofa —
 *      wholesale (header, items, deposit) with a different customer's order,
 *      leaving no audit trail. Import-once stops the overwrite, but a silent
 *      skip would now DROP the new order instead — the same loss, mirrored.
 *
 * The classifier below separates them by the customer name on the delivery vs
 * the row Houzs holds. A mismatch cannot be auto-resolved here (which order
 * rightfully owns the number is a human call), so it stays a SKIP — but a
 * loud one: action 'skipped_conflict' in scm.so_mirror_skips + console.error,
 * so check-so-mirror-skips.mjs surfaces it instead of it hiding among benign
 * re-deliveries. A Houzs-side rename of the debtor followed by a re-delivery
 * of the original row false-positives into 'skipped_conflict'; that is
 * acceptable for a tripwire — it is evidence, not state, and nothing reads it
 * to decide behaviour. */
const normDebtorName = (v: unknown): string =>
  String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function soMirrorSkipAction(
  held: { debtor_name?: unknown } | null | undefined,
  inboundHeader: Record<string, unknown> | null | undefined,
): 'skipped_existing' | 'skipped_conflict' {
  const heldName = normDebtorName(held?.debtor_name);
  const offeredName = normDebtorName(inboundHeader?.['debtor_name']);
  if (heldName && offeredName && heldName !== offeredName) return 'skipped_conflict';
  return 'skipped_existing';
}

soMirror.post('/', async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  let body: { docNo?: string; deleted?: boolean; header?: Record<string, unknown>; items?: Record<string, unknown>[]; payments?: Record<string, unknown>[] };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const rawDoc = String(body.docNo ?? body.header?.doc_no ?? '').trim();
  if (!rawDoc) return c.json({ error: 'doc_no_required' }, 400);
  const doc = String(prefixDoc(rawDoc));
  const DB = c.env.DB;

  try {
    const existing = await DB.prepare(
      `SELECT debtor_name FROM scm."mfg_sales_orders" WHERE company_id=? AND doc_no=? LIMIT 1`,
    ).bind(C2990, doc).first<{ debtor_name: string | null }>();

    if (existing) {
      if (body.deleted) {
        console.warn('[so-mirror] refused_delete — 2990 asked to delete an order Houzs owns:', doc);
        await recordSkip(DB, doc, 'refused_delete');
        return c.json({ ok: true, docNo: doc, action: 'refused_delete', refused: true });
      }
      const action = soMirrorSkipAction(existing, body.header);
      if (action === 'skipped_conflict') {
        console.error(
          '[so-mirror] skipped_conflict — 2990 delivered a DIFFERENT order under a doc_no Houzs already holds (split-brain double-mint):',
          doc, 'held:', existing.debtor_name, 'offered:', body.header?.['debtor_name'],
        );
      } else {
        console.warn('[so-mirror] skipped_existing — 2990 re-delivered an order Houzs already holds:', doc);
      }
      await recordSkip(DB, doc, action);
      return c.json({ ok: true, docNo: doc, action, skipped: true });
    }

    if (body.deleted) {
      await DB.prepare(`DELETE FROM scm."mfg_sales_orders" WHERE company_id=? AND doc_no=?`).bind(C2990, doc).run();
      return c.json({ ok: true, docNo: doc, action: 'deleted' });
    }
    if (!body.header) return c.json({ error: 'header_required' }, 400);

    const hMap = await tableMap(DB, 'mfg_sales_orders');
    const iMap = await tableMap(DB, 'mfg_sales_order_items');
    const pMap = await tableMap(DB, 'mfg_sales_order_payments');

    let headerWritten = false;
    try {
      await upsert(DB, 'mfg_sales_orders', applyMap(body.header, hMap), 'doc_no');
      headerWritten = true;

      await DB.prepare(`DELETE FROM scm."mfg_sales_order_items" WHERE company_id=? AND doc_no=?`).bind(C2990, doc).run();
      for (const it of body.items ?? []) await upsert(DB, 'mfg_sales_order_items', applyMap(it, iMap), 'id');

      await DB.prepare(`DELETE FROM scm."mfg_sales_order_payments" WHERE company_id=? AND so_doc_no=?`).bind(C2990, doc).run();
      for (const p of body.payments ?? []) await upsert(DB, 'mfg_sales_order_payments', applyMap(p, pMap), 'id');
    } catch (e) {
      if (headerWritten) {
        try {
          await DB.prepare(`DELETE FROM scm."mfg_sales_orders" WHERE company_id=? AND doc_no=?`).bind(C2990, doc).run();
        } catch (undoErr) {
          console.error('[so-mirror] first import failed AND its header could not be removed — this doc will now be skipped as if imported:', doc, (undoErr as Error).message);
        }
      }
      throw e;
    }

    return c.json({ ok: true, docNo: doc, action: 'imported', items: (body.items ?? []).length, payments: (body.payments ?? []).length });
  } catch (e) {
    return c.json({ error: 'mirror_failed', reason: (e as Error).message }, 500);
  }
});
