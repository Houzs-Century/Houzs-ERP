import { describe, it, expect } from 'vitest';

/* ═══════════════════════════════════════════════════════════════════════════
   Disabling a member must never depend on an scm.staff INSERT succeeding.
   ═══════════════════════════════════════════════════════════════════════════

   `trg_sync_user_to_staff` (mig 0066) fires AFTER UPDATE OF name, status ON
   public.users, so `UPDATE users SET status='disabled'` runs it inside the
   firing statement — a raise in the trigger rolls the whole UPDATE back and the
   member stays ACTIVE, which is exactly what the operator saw as
   "Something went wrong processing that request."

   The raise was reachable because the trigger's INSERT branch generated
   `'EMP-' || lpad(id,4,'0')` into a column carrying
   `staff_staff_code_unique UNIQUE(staff_code)`, while its ON CONFLICT clause
   arbitrated on the PRIMARY KEY (id) only — so a code already held by a
   DIFFERENT staff row raised duplicate key instead of being absorbed.

   The harness cannot execute the scm PL/pgSQL, so both trigger versions are
   modelled faithfully below (same identity mapping, same branch order, both
   unique constraints enforced) and the fix is pinned as a behavioural diff. */

type Staff = {
  id: string;
  user_id: number | null;
  staff_code: string;
  name: string;
  initials: string;
  active: boolean;
};
type User = { id: number; name: string | null; email: string; status: string };

// Stands in for md5('houzs-user:' || id)::uuid. Only the mapping's PROPERTIES
// matter to these cases — deterministic and injective — and a surrogate keeps
// the suite off a node:crypto shim inside workerd.
const staffUuid = (id: number) => `houzs-user:${id}`;

const pad4 = (n: number) => String(n).padStart(4, '0');

const resolvedName = (u: User) => u.name?.trim() || u.email || `User ${u.id}`;

const initialsOf = (name: string) => {
  const words = name.split(/\s+/).filter(Boolean).slice(0, 2);
  return (words.length ? words.map((w) => w[0]).join('') : name.slice(0, 2)).toUpperCase();
};

// INSERT ... ON CONFLICT (id) DO UPDATE. The id arbiter is handled by the
// engine, so an id hit never reaches the staff_code check — but a MISS does,
// and staff_code is unique.
function insertOnConflictId(staff: Staff[], row: Staff) {
  const byId = staff.find((s) => s.id === row.id);
  if (byId) {
    byId.name = row.name;
    byId.active = row.active;
    byId.initials = row.initials;
    byId.user_id = row.user_id;
    return;
  }
  if (staff.some((s) => s.staff_code === row.staff_code)) {
    throw new Error(
      'duplicate key value violates unique constraint "staff_staff_code_unique"',
    );
  }
  staff.push(row);
}

/** mig 0066 — the shipped behaviour that could raise. */
function syncV0066(staff: Staff[], u: User) {
  const vId = staffUuid(u.id);
  const vActive = u.status !== 'disabled';
  const vName = resolvedName(u);
  const vInitials = initialsOf(vName);

  const matched = staff.filter((s) => s.id === vId || s.user_id === u.id);
  if (matched.length) {
    for (const s of matched) {
      s.name = vName;
      s.active = vActive;
      s.initials = vInitials;
    }
    return;
  }
  insertOnConflictId(staff, {
    id: vId,
    user_id: u.id,
    staff_code: `EMP-${pad4(u.id)}`,
    name: vName,
    initials: vInitials,
    active: vActive,
  });
}

/** mig 0234 — no-op on deactivate, collision-checked code otherwise. */
function syncV0234(staff: Staff[], u: User) {
  const vId = staffUuid(u.id);
  const vActive = u.status !== 'disabled';
  const vName = resolvedName(u);
  const vInitials = initialsOf(vName);

  const matched = staff.filter((s) => s.id === vId || s.user_id === u.id);
  if (matched.length) {
    for (const s of matched) {
      s.name = vName;
      s.active = vActive;
      s.initials = vInitials;
    }
    return;
  }
  if (!vActive) return;

  let code = `EMP-${pad4(u.id)}`;
  let tries = 0;
  while (staff.some((s) => s.staff_code === code)) {
    tries += 1;
    if (tries > 50) break;
    code = `EMP-${pad4(u.id)}-${tries}`;
  }
  insertOnConflictId(staff, {
    id: vId,
    user_id: u.id,
    staff_code: code,
    name: vName,
    initials: vInitials,
    active: vActive,
  });
}

/** `UPDATE users SET status=...` — the trigger runs inside it, so a raise
 *  leaves the row untouched, which is the whole user-visible symptom. */
function setStatus(
  staff: Staff[],
  user: User,
  status: string,
  sync: (s: Staff[], u: User) => void,
) {
  const next = { ...user, status };
  const before = staff.map((s) => ({ ...s }));
  try {
    sync(staff, next);
  } catch (e) {
    staff.splice(0, staff.length, ...before); // rollback
    throw e;
  }
  user.status = status;
}

const member = (over: Partial<User> = {}): User => ({
  id: 42,
  name: 'Ng Wei Ming',
  email: 'ng@houzs.com',
  status: 'active',
  ...over,
});

// A staff row squatting on EMP-0042 that is NOT linked to user 42 — the shape
// that makes the INSERT branch reachable and fatal.
const squatter = (): Staff => ({
  id: staffUuid(9999),
  user_id: null,
  staff_code: 'EMP-0042',
  name: 'Imported Legacy Staff',
  initials: 'IL',
  active: true,
});

describe('trg_sync_user_to_staff — disabling a member', () => {
  it('0066 REGRESSION: unlinked member whose staff_code is taken cannot be disabled', () => {
    const staff = [squatter()];
    const u = member();
    expect(() => setStatus(staff, u, 'disabled', syncV0066)).toThrow(
      /staff_staff_code_unique/,
    );
    expect(u.status).toBe('active'); // the UPDATE rolled back — the bug
  });

  it('0234: the same disable is a no-op on scm.staff and succeeds', () => {
    const staff = [squatter()];
    const u = member();
    expect(() => setStatus(staff, u, 'disabled', syncV0234)).not.toThrow();
    expect(u.status).toBe('disabled');
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ staff_code: 'EMP-0042', active: true }); // squatter untouched
  });

  it('0234: a linked member is still deactivated in place (0066 behaviour kept)', () => {
    const staff: Staff[] = [
      {
        id: staffUuid(42),
        user_id: 42,
        staff_code: 'EMP-0042',
        name: 'Ng Wei Ming',
        initials: 'NW',
        active: true,
      },
    ];
    const u = member();
    setStatus(staff, u, 'disabled', syncV0234);
    expect(u.status).toBe('disabled');
    expect(staff[0].active).toBe(false);
  });

  it('0234: re-enabling an unlinked member creates the row on a free code', () => {
    const staff = [squatter()];
    const u = member({ status: 'disabled' });
    setStatus(staff, u, 'active', syncV0234);
    expect(u.status).toBe('active');
    expect(staff).toHaveLength(2);
    const created = staff.find((s) => s.user_id === 42)!;
    expect(created.staff_code).toBe('EMP-0042-1'); // not the taken EMP-0042
    expect(created.id).toBe(staffUuid(42)); // 0066 id-mapping invariant holds
    expect(created.active).toBe(true);
  });

  it('0234: the preferred staff_code is still used when it is free', () => {
    const staff: Staff[] = [];
    const u = member();
    syncV0234(staff, u);
    expect(staff[0].staff_code).toBe('EMP-0042');
    expect(staff[0].initials).toBe('NW');
  });

  it('0234: creating a user whose code is taken no longer raises', () => {
    const staff = [squatter()];
    expect(() => syncV0066(staff, member())).toThrow(/staff_staff_code_unique/);
    expect(() => syncV0234([squatter()], member())).not.toThrow();
  });
});
