// ----------------------------------------------------------------------------
// /warehouse-mirror — LIVE receiver for the 2990 -> Houzs one-way WAREHOUSE
// mirror.
//
// WHY THIS EXISTS: the same design risk R3 that wedged SO-2607-013 for 27 hours
// on a missing customer, one FK column over. scm.mfg_sales_order_items.
// warehouse_id carries a live FK to scm.warehouses (mfg_sales_order_items_
// warehouse_id_warehouses_id_fk), and warehouses were a ONE-TIME frozen import
// (migrate-2990-into-houzs.mjs, 33 tables, ON CONFLICT DO NOTHING, never
// updates). So the first SO line bound to a warehouse 2990 opened after that
// import fails the FK forever, exactly as the customer did. D6: masters mirror
// first, or everything else 500s.
//
// Unlike customers, this one is NOT known to be firing today — see the PR notes.
// It ships as the structural fix for a live FK parent that cannot self-heal, not
// as an incident response.
//
// The 2990 database (via pg_cron + pg_net) POSTs each changed warehouse here as
// { warehouseId, warehouse } (a raw 2990-shaped row) or { warehouseId,
// deleted:true }. Same shape, same auth, same transform rules as the other four
// receivers — see docs/2990-live-sync/06_masters_outbox_2990.sql for the sender.
//
// ONE-WAY, READ-ONLY, and `company_id = 2` IS the correct write-guard here — the
// same argument customer-mirror.ts makes, and it transfers cleanly because the
// same two facts hold: warehouses is a PER-COMPANY table (it has company_id,
// added by mig 0086 precisely so 2990's warehouses could migrate), and company_id
// does not over-match (nothing in Houzs mints a Houzs-NATIVE company-2 warehouse
// the way the headless scan job mints a company-2 SO — see lib/companyScope.ts's
// MIRRORED-SYSTEM OWNERSHIP note for that distinction). Every statement below is
// scoped to it.
//
// The global-unique trap that customers hit (customers_name_phone_unique, an
// unscoped index across two independent books, fixed by mig 0123) WAS present
// here too and is ALREADY FIXED: mig 0087 dropped warehouses_code_unique and
// replaced it with warehouses_company_code_unique UNIQUE (company_id, code). So
// 2990 and Houzs can each hold a warehouse coded 'KL'. No migration is needed for
// this receiver — 0086 + 0087 already prepared the table. Verified by reading
// both files, not assumed.
//
// WHETHER 2990'S WAREHOUSE SET ACTUALLY CHURNS IS NOT KNOWN — see the PR notes.
// The repo can prove the WEDGE (a live FK + a frozen import + FK checks that are
// ON for this receiver but were OFF for the import) but it cannot prove the
// FREQUENCY: nothing in the tree says how often 2990 opens a warehouse. A
// warehouse is opened once a year, not once a day, so the honest reading is that
// this ships as cheap structural insurance on a parent that CANNOT self-heal, not
// as a bug that is firing. If it never fires, it costs one drain tick.
//
// AUTH: the same static shared secret as the other receivers (x-sync-secret ==
// env.SYNC_SECRET) — the caller is the same 2990 database, not a user with a
// Supabase JWT. Fail-closed when the secret is unset (see mirrorAuthed).
//
// Mounted at '/api/sync/warehouse-mirror' in src/index.ts — PRE-AUTH, above the
// /api/* staff-session gate, because the caller is a database with no session.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../../types';
import { C2990, createMirrorMapper, mirrorAuthed, upsert } from '../lib/mirror-map';

export const warehouseMirror = new Hono<{ Bindings: Env }>();

/* No prefixCols: a warehouse carries no doc number, and `code` is left verbatim
   so mirrored and batch-imported rows stay interchangeable (0087 makes the code
   company-scoped, so it does not need to be made unique by prefixing).

   scm.warehouses has NO outbound FK of its own (verified against the schema
   dump: zero `ALTER TABLE "warehouses" ADD CONSTRAINT … FOREIGN KEY`), so unlike
   staff there is no dangling-master column to force NULL.

   is_default IS forced false, and it is the one non-obvious rule here.

   ⚠ ITS ORIGINAL JUSTIFICATION HAS EXPIRED — READ THIS BEFORE RELYING ON IT.
   This block used to say: is_default "is a HOUZS OPERATIONAL FLAG read by
   defaultWarehouseId() (lib/inventory-movements.ts), which is COMPANY-BLIND:
   `.eq('is_default', true).order('code').limit(1)`", so mirroring 2990's
   is_default=true would enter 2990's warehouse into the draw for HOUZS's
   inventory fallback, decided silently on alphabetical order.

   That reader was FIXED on 2026-08-03. `defaultWarehouseId` now reads
   `.eq('is_default', true).eq('company_id', companyId)` with companyId a
   REQUIRED positional argument — its own header dates the change and explains
   the incident. A company-2 default can no longer reach a company-1 fallback,
   so the leak this force was written to stop is closed at the reader.

   WHAT THE FORCE DOES NOW, which is a different thing: it makes it impossible
   for company 2 to HAVE a default warehouse at all through this path. A 2990
   admin can press the same promote button as a HOUZS admin
   (routes/inventory.ts patchWarehouseHandler, correctly per-company), and the
   next mirror delivery of that row clears it again — while HOUZS warehouses,
   which never travel by mirror, keep theirs. `defaultWarehouseId` then returns
   null for company 2 and every fallback that depends on it (GRN, DO, delivery
   return, consignment) resolves nothing.

   NOT CHANGED HERE, deliberately, and the reason is worth stating rather than
   leaving as a silence: removing the force changes what a mirror WRITES into
   production, and nothing in this repo currently measures `is_default` per
   company (no read-only script selects that column), so the blast radius is
   unmeasured. It also depends on whether 2990's own repo has its warehouse
   outbox switched on, which is not readable from here. Measure first — the
   query is one GROUP BY — then remove the force in its own change.

   NOTE: the batch importer did NOT force this (NULL_COLS has no warehouses
   entry), so any already-imported 2990 warehouse may be carrying is_default=true
   in prod right now. The 06 backfill re-delivers every 2990 warehouse through
   this receiver, so switching this mirror on also CLEARS that latent flag. See
   the PR notes — worth checking on staging before enabling.

   is_active is NOT forced: a mirrored SO line's warehouse_id must resolve to a
   readable warehouse, and the warehouse list is already company-scoped
   (scopeToCompany in routes/inventory.ts), so an active 2990 warehouse cannot
   leak into a Houzs picker. Contrast staff, which has no company_id and so has
   to be held out of pickers by `active` instead. Leaving is_active un-forced is
   also what lets the delete path below MEAN something: it is the one column a
   2990 delete writes. */
const { tableMap, applyMap } = createMirrorMapper({
  warehouses: { forceCols: { is_default: false } },
});

warehouseMirror.post('/', async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  let body: { warehouseId?: string; deleted?: boolean; warehouse?: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const id = String(body.warehouseId ?? body.warehouse?.id ?? '').trim();
  if (!id) return c.json({ error: 'warehouse_id_required' }, 400);
  const DB = c.env.DB;

  try {
    // ---- DELETE DEACTIVATES. IT DOES NOT DELETE. -----------------------------
    // The obvious move is to copy customer-mirror and DELETE, on the argument
    // that mfg_sales_order_items.warehouse_id is ON DELETE SET NULL so Houzs
    // would just mirror 2990's own outcome. That argument is WRONG HERE, and the
    // reason is the one thing this mirror does not share with 2990: STATE.
    //
    // scm.warehouses has 13 inbound FKs and five of them are ON DELETE RESTRICT —
    // inventory_lots, inventory_movements, inventory_lot_consumptions,
    // stock_takes, stock_transfers (x2). All three inventory tables ARE in the
    // batch importer's 33-table ORDER, so Houzs holds a FROZEN 2026-snapshot of
    // 2990's inventory still pointing at 2990's warehouses. 2990 can therefore
    // delete a warehouse perfectly legally — it cleared ITS lots first — while
    // Houzs's copy of those same lots is stale and still references the row. The
    // DELETE then RAISES on a restrict FK, the receiver 500s, and the outbox
    // retries forever. That is not a hypothetical: it is SO-2607-013's exact
    // failure shape, re-created by the very file meant to prevent it.
    //
    // So a hard delete has two outcomes and both are bad: it either fails
    // PERMANENTLY on a restrict FK (that row retrying every 10s forever, with no
    // resolution short of an operator), or, if no lot happens to reference the
    // row, it succeeds and silently NULLs warehouse_id on real mirrored SO lines.
    // Deactivating has neither failure: it never raises, it
    // keeps the row alive as the FK target the frozen inventory and the mirrored
    // SO lines both still need, and is_active=false is what actually removes it
    // from Houzs's company-2 warehouse pickers — which is the whole of what
    // "2990 deleted this warehouse" should mean to Houzs.
    //
    // Scoped to company 2 so a bad id can never reach a Houzs-native warehouse.
    // If 2990 later re-creates the id, the normal upsert path carries its real
    // is_active back and the row returns to service.
    if (body.deleted) {
      await DB.prepare(`UPDATE scm."warehouses" SET is_active=false WHERE company_id=? AND id=?`)
        .bind(C2990, id).run();
      return c.json({ ok: true, warehouseId: id, action: 'deactivated' });
    }
    if (!body.warehouse) return c.json({ error: 'warehouse_required' }, 400);

    const map = await tableMap(DB, 'warehouses');
    // upsert by id (uuid PK, carried VERBATIM from 2990 per D4) — so a retry
    // converges onto the same row, and the id a mirrored SO line's warehouse_id
    // holds is the id this row has. Verbatim identity is what makes the FK
    // resolve at all; remapping is the documented cause of the old mirror's 500s.
    await upsert(DB, 'warehouses', applyMap(body.warehouse, map), 'id');

    return c.json({ ok: true, warehouseId: id });
  } catch (e) {
    // Non-2xx -> 2990's drainer keeps the outbox row pending and retries. Zero-loss.
    // The reason lands in 2990's net._http_response.content, which is where an
    // operator reads it. The one expected failure worth naming:
    //   * warehouses_code_unique — the PRE-0087 global index is still in place, so
    //     a 2990 warehouse sharing a code with a Houzs-native one is rejected even
    //     though the two are independent. That would wedge this mirror exactly as
    //     the FK wedged the SO. If this appears, 0087 has not applied — fix that,
    //     not this file. (The post-0087 name is warehouses_company_code_unique;
    //     seeing THAT one means two 2990 warehouses share a code, which is a 2990
    //     data problem.)
    return c.json({ error: 'mirror_failed', reason: (e as Error).message }, 500);
  }
});
