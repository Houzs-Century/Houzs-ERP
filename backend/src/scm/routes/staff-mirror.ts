// ----------------------------------------------------------------------------
// /staff-mirror — LIVE receiver for the 2990 -> Houzs one-way STAFF mirror.
//
// WHY THIS EXISTS: scm.mfg_sales_orders.salesperson_id / .created_by and
// scm.mfg_sales_order_payments.collected_by all carry live FKs to scm.staff, and
// staff was a ONE-TIME frozen import (migrate-2990-into-houzs.mjs). One 2990 hire
// after that import wedges that person's first SO forever — the same 27-hour /
// 6582-attempt failure SO-2607-013 had on customer_id. amendment-mirror.ts:120
// has documented this since it landed: "This does NOT self-heal." This is the
// file that makes it self-heal. D6: masters mirror first, or everything else
// 500s.
//
// The 2990 database POSTs { staffId, staff } or { staffId, deleted:true } — same
// shape and auth as the other four receivers. See docs/2990-live-sync/
// 06_masters_outbox_2990.sql for the sender.
//
// ============================================================================
// THIS IS NOT THE CUSTOMER MIRROR. THREE THINGS MAKE scm.staff DIFFERENT.
// ============================================================================
//
// 1. THERE IS NO company_id TO GUARD WITH.
//    customer-mirror.ts guards every statement with `company_id = 2`, on the
//    argument that 2990 is a retailer with its own customer book so every
//    company-2 customer is 2990's BY DEFINITION. That argument does not transfer,
//    because the column does not exist: 0083's header rules that SHARED masters
//    get NO company_id, staff is one, and no branch adds it (checked). The
//    importer says the same thing in code — NO_CID = { staff: {…} }.
//    This is also why lib/mirror-map.ts stamps company_id only where the dest
//    table HAS the column: routing staff through an unconditional stamp would
//    name a column scm.staff does not have and 500 every single delivery.
//
//    So: WHAT MARKS A STAFF ROW AS 2990-OWNED? The honest answer is NOTHING, and
//    after PR #688 nothing should, because the row STOPS BEING 2990-owned. #688
//    turns 2990's people into real Houzs users and RELINKS their existing 2990
//    staff row (SET user_id) rather than minting a second one. That row is then a
//    Houzs employee's staff identity that happens to have come from 2990.
//    "Which company owns this row" is therefore the wrong question, and a
//    company_id would encode a wrong answer.
//
//    The right question is WHICH SYSTEM IS THE WRITER OF RECORD, and scm.staff
//    already answers it: `user_id`. NULL => no Houzs user exists for this person,
//    nothing in Houzs writes the row, the mirror is the only writer. NOT NULL =>
//    Houzs User Management owns them and mig 0066's trigger drives name/active
//    from public.users. So the guard is `user_id IS NULL`, and it is not a proxy
//    for provenance — it is the handover flag itself.
//
//    PROD ARITHMETIC CONFIRMS THE REACH IS EXACT, which matters because a guard
//    on a table with no ownership column is otherwise a guess. Measured today:
//    scm.staff = 104 rows, 87 with user_id set => 17 unlinked. 2990's public.staff
//    = 16 rows. 16 imported + 1 seeded system row (0022 keeps it; 0066's backfill
//    leaves it user_id NULL) = 17. The set this receiver can write is therefore
//    EXACTLY the 16 rows the batch import created, plus the system row — which is
//    why the system row is refused by id below rather than left to the gate.
//
// 2. MIG 0066's trg_sync_user_to_staff IS A SECOND WRITER ON THIS TABLE.
//    It fires on every public.users INSERT/UPDATE OF name,status and does
//    `UPDATE scm.staff SET name, active, initials WHERE id = md5('houzs-user:'||
//    NEW.id) OR user_id = NEW.id` (INSERT if not found). Its reach is exactly the
//    rows where `user_id = NEW.id` or the md5 id it mints itself — i.e. LINKED
//    rows. This receiver's reach is exactly the rows where `user_id IS NULL`.
//    THE TWO SETS ARE DISJOINT BY CONSTRUCTION, so there is no ping-pong: neither
//    writer can touch a row the other owns. That is why the gate lives in the
//    ON CONFLICT ... WHERE and not in a "last writer wins" rule.
//
// 3. PR #688's RELINK MUST SURVIVE THIS MIRROR — AND IT DOES, TWICE OVER.
//    #688 sets user_id on the EXISTING 2990 uuid so the ~41 FK references to that
//    uuid keep resolving, and because the app resolves a person's staff uuid BY
//    user_id (lib/salesScope.ts resolveCallerStaffId / resolveSalesScopeIds),
//    never by recomputing the md5. An upsert that wrote user_id back to NULL
//    would silently unlink every migrated person — no error, and the app would
//    simply stop finding them.
//      * It cannot happen by accident: 2990's staff table HAS NO user_id COLUMN
//        (it is Houzs-only, added by 0066), so the payload cannot carry one.
//      * It cannot happen on purpose either: user_id is in preserveCols, so it is
//        dropped from the payload and appears in neither the INSERT column list
//        nor the ON CONFLICT SET list. The first fact is an accident of 2990's
//        schema and would evaporate the day someone adds the column there; the
//        second is the assertion. Do not remove it because "the source never
//        sends it" — that is the reason it is cheap, not a reason to omit it.
//    And once #688 has relinked a row, `user_id IS NULL` is false, so this mirror
//    stops updating that person entirely. #688 and this file compose: #688 hands
//    a person over to Houzs UM, and the handover is the mirror's own stop signal.
//
// ONE-WAY, READ-ONLY. Nothing here writes back to 2990.
//
// AUTH: the same static shared secret as the other receivers. Fail-closed when
// unset (see mirrorAuthed). Mounted at '/api/sync/staff-mirror' in src/index.ts —
// PRE-AUTH, because the caller is a database with no session.
// ----------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../../types';
import { createMirrorMapper, mirrorAuthed, upsert } from '../lib/mirror-map';

export const staffMirror = new Hono<{ Bindings: Env }>();

/* The seeded super_admin system row (mig 0022 keeps it; 0066's header names it).
   The SCM auth bridge pins EVERY Houzs SCM caller to this one uuid, so it is the
   single most load-bearing row in the table — and it carries user_id NULL, which
   means the `user_id IS NULL` gate below does NOT protect it. 2990 has no reason
   to ever emit this id (it is a Houzs seed, not an imported row), so this guard
   should never fire; it exists because "should never" is what SO-2607-013 was. */
const SYSTEM_STAFF_ID = '00000000-0000-4000-8000-000000000001';

const { tableMap, applyMap } = createMirrorMapper({
  staff: {
    forceCols: {
      /* showroom_id -> scm.showrooms. THE FK NOBODY WOULD PREDICT: showrooms is
         NOT in the importer's 33-table ORDER and is explicitly NOT seeded (0022:
         "NOT seeded … scm.staff / scm.showrooms / scm.drivers"). So scm.showrooms
         is EMPTY in Houzs, and any 2990 staff row with a showroom_id is an
         instant FK violation -> 500 -> the exact forever-wedge this file fixes.
         The batch import got away with it only because it ran under
         `SET session_replication_role = replica` (FK checks OFF); this receiver
         runs with them ON. A dangling showroom_id may therefore be sitting in
         prod right now, imported silently. */
      showroom_id: null,
      /* venue_id -> scm.venues, ON DELETE SET NULL. Venues WERE imported, but as
         the same frozen snapshot, and so-mirror already forces venue_id NULL on
         every SO for the stated reason that venues are not reconciled across
         companies. A staff row cannot be allowed to assert a venue link the SO
         itself is not allowed to assert. */
      venue_id: null,
      /* active=false is the importer's rule, restated: NO_CID = { staff: {
         forceInactive: true } } — "import so historical FK refs resolve; forced
         inactive so they never appear in Houzs pickers". A mirrored 2990 staff
         row exists to be an FK TARGET, not a person Houzs can pick. Because staff
         has no company_id, `active` is the ONLY thing holding 2990's people out
         of the Houzs pickers (PaymentsTable's Collected-By filters `s.active`) —
         contrast warehouses, which are held out by company scoping instead.
         Mirroring 2990's active=true verbatim would undo the import's intent and
         put 2990's till staff into Houzs's pickers.
         This does NOT deactivate the nine people #688 migrates: their rows are
         relinked (user_id NOT NULL), so the gate below means this row is never
         written for them, and 0066's trigger keeps them active from users.status.
         The `user_id IS NULL` gate is what makes forceInactive and #688 coexist —
         without it, this line would log the migrated nine out of their own
         pickers on the next 2990 edit. */
      active: false,
    },
    /* user_id is HOUZS-OWNED — 0066 mints it, #688 re-points it. See note 3 in
       the header: this is the assertion that #688's relink survives, and the one
       write that would be silent and irreversible if we got it wrong. */
    preserveCols: ['user_id'],
  },
});

staffMirror.post('/', async (c) => {
  if (!mirrorAuthed(c)) return c.json({ error: 'unauthorized' }, 401);
  let body: { staffId?: string; deleted?: boolean; staff?: Record<string, unknown> };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const id = String(body.staffId ?? body.staff?.id ?? '').trim();
  if (!id) return c.json({ error: 'staff_id_required' }, 400);
  // 2xx, not 4xx. This is a well-formed payload we DELIBERATELY refuse, and a
  // non-2xx would put the row back to 'pending' and retry it every 10s forever —
  // the wedge this file exists to prevent. Acknowledge and do nothing, exactly as
  // the delete path below does, so the outbox reaches a terminal state. (The 400s
  // above are different: those are malformed payloads 2990's drain cannot emit, so
  // retrying is the correct response to what would be a real bug.)
  if (id === SYSTEM_STAFF_ID) {
    return c.json({ ok: true, staffId: id, action: 'ignored', reason: 'system_staff_row_never_mirrors' });
  }
  const DB = c.env.DB;

  try {
    // ---- DELETE IS A DOCUMENTED NO-OP. THIS IS A RULING, NOT AN OMISSION. -----
    // customer-mirror deletes; this must not. The full FK census into scm.staff,
    // counted from the schema dump (41 total), makes every branch of a delete bad:
    //
    //   (a) 20 ARE ON DELETE SET NULL => SILENT DATA LOSS. Including the SO trio's
    //       own three — mfg_sales_orders_salesperson_id_staff_id_fk, .created_by,
    //       and mfg_sales_order_payments_collected_by_staff_id_fk. A delete does
    //       not raise; it NULLS salesperson attribution on real, already-mirrored
    //       orders and returns 2xx. The mirror would report success while erasing
    //       who sold what.
    //   (b) 4 ARE ON DELETE CASCADE => ROW LOSS. hr_salesperson_profiles (the
    //       commission module), pos_carts, pos_pin_attempts,
    //       sofa_personal_quick_picks. Not attribution loss — commission data.
    //   (c) THE OTHER 17 (8 restrict + 9 no action) RAISE => THE WEDGE ITSELF. A
    //       staff row referenced by e.g. delivery_orders.created_by (restrict)
    //       cannot be deleted here at all: the receiver 500s, confirm puts the row
    //       back to 'pending', and that row retries every 10s forever with no
    //       possible resolution — SO-2607-013's exact shape (6982 attempts),
    //       re-created inside the fix for SO-2607-013. So a delete does not even
    //       fail SAFELY: for 17 of 41 FKs it fails PERMANENTLY.
    //   (d) POST-#688 A 2990 STAFF ROW MAY BE A LIVE HOUZS EMPLOYEE. 2990 tidying
    //       up its own staff list must not delete a person who works at Houzs.
    //
    // There is no subset of these a delete could satisfy: (a)+(b) are what happens
    // when it succeeds and (c) is what happens when it fails.
    //
    // Why not "deactivate instead of delete", the usual answer? Because there is
    // nothing left to deactivate. Every row this mirror manages (user_id IS NULL)
    // is ALREADY active=false by forceCols above, and every row it does not
    // manage (user_id NOT NULL) is a Houzs person whose active flag belongs to
    // 0066's trigger. A 2990 delete has NO correct effect in Houzs on either set.
    // So: acknowledge with 2xx (the outbox marks it done and stops retrying) and
    // do nothing. The row stays as an FK target forever, which is precisely what
    // the import created it to be.
    if (body.deleted) {
      return c.json({ ok: true, staffId: id, action: 'ignored', reason: 'staff_delete_never_mirrors' });
    }
    if (!body.staff) return c.json({ error: 'staff_required' }, 400);

    const map = await tableMap(DB, 'staff');
    // upsert by id (uuid PK, VERBATIM per D4 — it is what every one of the 41 FK
    // references already points at), gated so the UPDATE arm can only ever touch
    // a row Houzs User Management has not taken over. When the gate is false
    // Postgres updates nothing and raises nothing: the person is a Houzs employee
    // now and 2990 no longer describes them. That silence is correct and is the
    // steady state for everyone #688 migrates — see note 2 in the header.
    // The gate reads the EXISTING row by the table's own name — Postgres exposes
    // it that way inside ON CONFLICT DO UPDATE (`EXCLUDED` is the proposed row).
    await upsert(DB, 'staff', applyMap(body.staff, map), 'id', {
      where: `"staff".user_id IS NULL`,
    });

    return c.json({ ok: true, staffId: id });
  } catch (e) {
    // Non-2xx -> 2990's drainer keeps the outbox row pending and retries. Zero-loss.
    // The reason lands in 2990's net._http_response.content. Expected failures:
    //   * staff_staff_code_unique / staff_email_unique — these are GLOBAL uniques
    //     in the ported schema (verified in the dump: both are bare UNIQUE(col) on
    //     scm.staff) and, unlike customers (mig 0123) and warehouses (0087, which
    //     re-scoped warehouses_code_unique to (company_id, code) and pointedly did
    //     NOT touch staff), THEY CANNOT BE RE-SCOPED BY company_id — staff has no
    //     company_id and must not get one (see note 1). This is the same trap
    //     shape that would have wedged the customer mirror, on a table where the
    //     customer's fix is structurally unavailable.
    //     Today it cannot fire, which is why no migration ships with this PR:
    //       - staff_code namespaces are disjoint. 2990 mints `2990S-###`/`OPS`;
    //         0066's trigger mints `EMP-` || lpad(user_id,4,'0'). No overlap.
    //       - 0066 NEVER writes staff.email (not in its INSERT column list, not in
    //         its UPDATE SET), so every Houzs-native row carries email NULL and
    //         UNIQUE ignores NULLs. #688 puts those emails on public.users, not on
    //         scm.staff, so it does not change this either.
    //     A real structural trap that currently does not fire, not a fixed one. It
    //     would take a hand-made staff row to trip it; the answer then is to
    //     renumber that row, not to widen this receiver.
    //   * staff_showroom_id_showrooms_id_fk — showroom_id was not forced NULL.
    //     scm.showrooms is empty; see forceCols above.
    return c.json({ error: 'mirror_failed', reason: (e as Error).message }, 500);
  }
});
