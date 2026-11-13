import { describe, it, expect } from 'vitest';

/* ═══════════════════════════════════════════════════════════════════════════
   scm.sync_user_to_tms() — disabling an account must NOT retire an outsource
   crew row (migration 20261113T1600).
   ═══════════════════════════════════════════════════════════════════════════

   SYMPTOM. Penang / outsource drivers and helpers (in_house = false) kept
   disappearing from the Setup & Dismantle crew pickers and from Delivery
   Planning's Driver / Helper dropdowns — both read the same active-only roster,
   so the name dropped from both at once.

   CAUSE. The AFTER-trigger on public.users mirrors a crew account into
   scm.drivers / scm.helpers. Its "account disabled" branch deactivated the
   linked Fleet row regardless of whether that row was ours or a 3PL's. An
   outsource transporter's ERP account is an invite that gets disabled in Member
   cleanups, so the 3PL driver kept vanishing.

   FIX. The disable branch now carries `AND in_house IS NOT FALSE`, so only an
   in-house row (in_house true, or the historical NULL default) follows the
   account into retirement; an outsource row (in_house = false) is kept.

   The harness cannot execute the scm PL/pgSQL, so both the old and new disable
   branches are modelled faithfully below (same WHERE predicate) and the fix is
   pinned as a behavioural diff, exactly like db/user-staff-sync.test.ts. */

type CrewRow = { user_id: number | null; in_house: boolean | null; active: boolean };

/** Pre-fix (20261029T1700): UPDATE ... SET active=false WHERE user_id=NEW.id AND active. */
function disableSyncOld(rows: CrewRow[], userId: number): void {
  for (const r of rows) if (r.user_id === userId && r.active) r.active = false;
}

/** Fixed (20261113T1600): ... AND in_house IS NOT FALSE.
 *  `in_house IS NOT FALSE` is true for TRUE and NULL, false for FALSE —
 *  mirrored here by `r.in_house !== false`. */
function disableSyncNew(rows: CrewRow[], userId: number): void {
  for (const r of rows) if (r.user_id === userId && r.active && r.in_house !== false) r.active = false;
}

describe('sync_user_to_tms — disabling the linked account', () => {
  it('FIX: an outsource row (in_house=false) stays active when its account is disabled', () => {
    const rows: CrewRow[] = [{ user_id: 93, in_house: false, active: true }]; // e.g. Shakti @ MSJ TRANSPORT
    disableSyncNew(rows, 93);
    expect(rows[0].active).toBe(true);
  });

  it('REGRESSION: the old branch wrongly deactivated that same outsource row', () => {
    const rows: CrewRow[] = [{ user_id: 93, in_house: false, active: true }];
    disableSyncOld(rows, 93);
    expect(rows[0].active).toBe(false); // the bug this migration removes
  });

  it('kept: an in-house row (in_house=true) is still retired with its account', () => {
    const rows: CrewRow[] = [{ user_id: 58, in_house: true, active: true }];
    disableSyncNew(rows, 58);
    expect(rows[0].active).toBe(false);
  });

  it('kept: the historical NULL in_house default counts as in-house and is retired', () => {
    const rows: CrewRow[] = [{ user_id: 58, in_house: null, active: true }];
    disableSyncNew(rows, 58);
    expect(rows[0].active).toBe(false);
  });

  it('only the disabled account’s rows are touched; another account’s crew is left alone', () => {
    const rows: CrewRow[] = [
      { user_id: 93, in_house: false, active: true }, // outsource — kept
      { user_id: 58, in_house: true, active: true },  // different account — untouched
    ];
    disableSyncNew(rows, 93);
    expect(rows).toEqual([
      { user_id: 93, in_house: false, active: true },
      { user_id: 58, in_house: true, active: true },
    ]);
  });
});
