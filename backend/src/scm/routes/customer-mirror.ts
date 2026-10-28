// ----------------------------------------------------------------------------
// /customer-mirror — LIVE receiver for the 2990 -> Houzs one-way CUSTOMER mirror.
//
// WHY THIS EXISTS: this is design risk R3 firing in production. The one-time
// master import (scripts/migrate-2990-into-houzs.mjs) is a FROZEN snapshot that
// never updates, but SOs mirror LIVE. scm.mfg_sales_orders.customer_id carries a
// live FK to scm.customers (proven, not assumed: SO-2607-013 resolved every other
// FK it holds and still 500s on customer_id alone). So a 2990 customer that does
// not exist in Houzs makes that customer's first SO fail the FK forever — the
// receiver 500s, 2990's outbox retries every 10s, and the SO never lands.
// SO-2607-013 sat wedged for 27+ hours across 6582 attempts on exactly this.
// D6 says masters must mirror before their children. They never did.
//
// The 2990 database (via pg_cron + pg_net) POSTs each changed customer here as
// { customerId, customer } (a raw 2990-shaped row) or { customerId, deleted:true }.
// Same shape, same auth, same transform rules as so-mirror.ts / amendment-mirror.ts
// — see docs/2990-live-sync/05_customer_outbox_2990.sql for the sender.
//
// ONE-WAY, READ-ONLY. Unlike the SO and amendment mirrors, the read-only-ness is
// NOT enforced by a doc-no prefix, because a customer has no doc number. See
// lib/companyScope.ts's MIRRORED-SYSTEM OWNERSHIP note for why the prefix (not
// company_id) guards SO writes: company_id over-matches there, because the
// headless scan job legitimately mints a Houzs-NATIVE SO stamped company_id=2.
//
// For customers company_id does NOT over-match, and that is the whole argument:
// per the design's §2a row 2 the verdict is MIRROR-RO — 2990 is a retailer with
// its own customer book, so EVERY company-2 customer is 2990's by definition and
// a Houzs-native company-2 customer is not a thing that should exist. So
// `company_id = 2` is the correct write-guard here, and every statement below is
// scoped to it.
//
// customer_code is NOT a usable provenance marker and must not become one:
// upsert_customer_by_name_phone (backend/scripts/scm-schema/port-missing-functions-
// triggers.sql) mints `2990S-XXXXXXXX` codes in HOUZS too — it is a port of 2990's
// own minter, prefix and all. Both systems emit the same prefix, so the prefix
// distinguishes nothing. The import does not prefix customer_code either, so
// mirrored and batch-imported rows stay interchangeable by leaving it verbatim.
//
// AUTH: the same static shared secret as the SO/amendment mirrors (x-sync-secret
// == env.SYNC_SECRET) — the caller is the same 2990 database, not a user with a
// Supabase JWT. Fail-closed when the secret is unset.
//
// Mounted at '/api/sync/customer-mirror' in src/index.ts — PRE-AUTH, above the
// /api/* staff-session gate, because the caller is a database with no session.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../../types';
import { C2990, createMirrorMapper, mirrorAuthed, upsert } from '../lib/mirror-map';

export const customerMirror = new Hono<{ Bindings: Env }>();

/* No prefixCols: a customer carries no doc number, and customer_code is left
   verbatim (see the header). No forceCols: unlike mfg_sales_orders.venue_id there
   is no customers column pointing at a master that isn't reconciled across
   companies, and unlike so_amendments there is no Houzs-only column a 2990 row
   must be asserted not to carry. The shared company_id stamp + dest-column
   filtering + array coercion from lib/mirror-map.ts is the entire transform.
   Passing an empty config is deliberate, not an oversight: it routes this
   receiver through the SAME applyMap the other two use, so the verbatim-id rule
   (D4) and the text[] coercion cannot drift away from them here. */
const { tableMap, applyMap } = createMirrorMapper({ customers: {} });

customerMirror.post('/', async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  let body: { customerId?: string; deleted?: boolean; customer?: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const id = String(body.customerId ?? body.customer?.id ?? '').trim();
  if (!id) return c.json({ error: 'customer_id_required' }, 400);
  const DB = c.env.DB;

  try {
    // DELETE: customer removed in 2990 -> drop the mirror. Scoped to company 2 so
    // a bad id can never reach a Houzs-native customer. Mirrored SOs that
    // referenced it keep working: mfg_sales_orders.customer_id is ON DELETE SET
    // NULL, which is 2990's own behaviour for the same delete.
    if (body.deleted) {
      await DB.prepare(`DELETE FROM scm."customers" WHERE company_id=? AND id=?`).bind(C2990, id).run();
      return c.json({ ok: true, customerId: id, action: 'deleted' });
    }
    if (!body.customer) return c.json({ error: 'customer_required' }, 400);

    const map = await tableMap(DB, 'customers');
    // upsert by id (uuid PK, carried VERBATIM from 2990 per D4) — so a retry
    // converges onto the same row, and the id the mirrored SO's customer_id holds
    // is the id this row has. That verbatim rule is what makes the FK resolve at
    // all; remapping is the documented cause of the previous mirror's 500s.
    await upsert(DB, 'customers', applyMap(body.customer, map), 'id');

    return c.json({ ok: true, customerId: id });
  } catch (e) {
    // Non-2xx -> 2990's drainer keeps the outbox row pending and retries. Zero-loss.
    // The reason lands in 2990's net._http_response.content, which is where an
    // operator reads it. The one expected failure worth naming:
    //   * customers_name_phone_unique / customers_customer_code_unique — these are
    //     GLOBAL uniques in the ported schema, NOT company-scoped, so a 2990
    //     customer sharing (name, phone) with a Houzs-native one is rejected even
    //     though the two customer books are independent. That would wedge this
    //     mirror exactly like the FK wedged the SO. Migration 0123 re-scopes both
    //     indexes by company_id to make it structurally impossible; if this error
    //     appears, 0123 has not applied.
    return c.json({ error: 'mirror_failed', reason: (e as Error).message }, 500);
  }
});
