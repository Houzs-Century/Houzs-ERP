import { describe, it, expect } from 'vitest';


type CrewRow = { user_id: number | null; in_house: boolean | null; active: boolean };

function disableSyncOld(rows: CrewRow[], userId: number): void {
  for (const r of rows) if (r.user_id === userId && r.active) r.active = false;
}

function disableSyncNew(rows: CrewRow[], userId: number): void {
  for (const r of rows) if (r.user_id === userId && r.active && r.in_house !== false) r.active = false;
}

describe('sync_user_to_tms — disabling the linked account', () => {
  it('FIX: an outsource row (in_house=false) stays active when its account is disabled', () => {
    const rows: CrewRow[] = [{ user_id: 93, in_house: false, active: true }];
    disableSyncNew(rows, 93);
    expect(rows[0].active).toBe(true);
  });

  it('REGRESSION: the old branch wrongly deactivated that same outsource row', () => {
    const rows: CrewRow[] = [{ user_id: 93, in_house: false, active: true }];
    disableSyncOld(rows, 93);
    expect(rows[0].active).toBe(false);
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
      { user_id: 93, in_house: false, active: true },
      { user_id: 58, in_house: true, active: true },
    ];
    disableSyncNew(rows, 93);
    expect(rows).toEqual([
      { user_id: 93, in_house: false, active: true },
      { user_id: 58, in_house: true, active: true },
    ]);
  });
});
