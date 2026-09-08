// ---------------------------------------------------------------------------
// The person-vs-machine rule, pinned against the ACTUAL rows the tree writes.
//
// Every fixture below is a verbatim copy of a real writer's arguments, with the
// file and line it came from, so this file fails when a writer changes rather
// than when somebody's idea of a system name changes. The sweep that produced
// the list is recorded in audit-author.ts.
//
// THE RED CASE is `a salesperson's own edit`. Before this rule existed,
// sync-ac-delta.mjs asked `actor_id === SCM_SYSTEM_STAFF_ID ? machine : person`
// — and that uuid is what EVERY human sales-order edit carries, because
// middleware/auth.ts pins it. That test called every person a machine, so the
// "never overwrite a human" veto refused nothing. The assertion below is the
// one that was red.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  classifyAuditAuthor,
  isPersonAuthored,
  auditMachineSql,
  auditPersonSql,
  planPersonEditVeto,
  type VetoAuditRow,
} from './audit-author';

/* middleware/auth.ts:47 — the uuid pinned onto c.get('user').id for EVERY
   authenticated SCM caller, and therefore onto every `actorId: user.id` the 21
   recordSoAudit call sites in routes/mfg-sales-orders.ts pass. */
const PINNED_STAFF_ID = '00000000-0000-4000-8000-000000000001';

describe('classifyAuditAuthor — the machine writers, verbatim', () => {
  const MACHINE_ROWS: Array<[string, { actor_id: string | null; actor_name_snapshot: string }]> = [
    ['so-stock-allocation.ts:998 (the allocation cron, UPDATE_LINE)',
      { actor_id: null, actor_name_snapshot: 'system (auto-allocate)' }],
    ['so-stock-allocation.ts:1082 (the allocation cron, UPDATE_STATUS)',
      { actor_id: null, actor_name_snapshot: 'System (auto-allocate)' }],
    ['free-gift-reconcile.ts:138 (DELETE_LINE)',
      { actor_id: null, actor_name_snapshot: 'System (free gift)' }],
    ['free-gift-reconcile.ts:237 (ADD_LINE)',
      { actor_id: null, actor_name_snapshot: 'System (free gift)' }],
    /* These two are the reason the actor_id arm had to go: so-delivery-sync
       passes `actorId ?? null`, which is the PINNED uuid whenever a person's
       action triggered the sync. #3177's rule (actor_id IS NULL AND name ILIKE
       'system%') called both of these a person. */
    ['so-delivery-sync.ts:129 (release refused), triggered by a caller',
      { actor_id: PINNED_STAFF_ID, actor_name_snapshot: 'System (delivery sync)' }],
    ['so-delivery-sync.ts:360 (lines auto-stamped READY), unattributed',
      { actor_id: null, actor_name_snapshot: 'System (delivery sync)' }],
    ['backfill-2990-delivered-dos.mjs:127',
      { actor_id: null, actor_name_snapshot: 'System (2990 delivered-chain backfill)' }],
  ];

  for (const [where, row] of MACHINE_ROWS) {
    it(`is a machine: ${where}`, () => {
      expect(classifyAuditAuthor(row)).toBe('machine');
      expect(isPersonAuthored(row)).toBe(false);
    });
  }
});

describe('classifyAuditAuthor — a person', () => {
  /* THE RED ASSERTION. A salesperson editing a sales order in the browser:
     actor_id is the pinned system uuid (auth.ts), the NAME is theirs. */
  it("a salesperson's own edit is a PERSON, even though actor_id is the pinned system uuid", () => {
    const row = { actor_id: PINNED_STAFF_ID, actor_name_snapshot: 'Wei Siang' };
    expect(classifyAuditAuthor(row)).toBe('person');
  });

  it('a person whose name merely CONTAINS "system" is still a person', () => {
    expect(classifyAuditAuthor({ actor_id: PINNED_STAFF_ID, actor_name_snapshot: 'Ecosystem Lim' }))
      .toBe('person');
  });

  it('an unattributed, unnamed row counts as a PERSON — the direction that surfaces it', () => {
    expect(classifyAuditAuthor({ actor_id: null, actor_name_snapshot: null })).toBe('person');
    expect(classifyAuditAuthor({ actor_id: null, actor_name_snapshot: '   ' })).toBe('person');
  });

  it('leading whitespace does not smuggle a machine row past the prefix', () => {
    expect(classifyAuditAuthor({ actor_id: null, actor_name_snapshot: '  System (free gift)' }))
      .toBe('machine');
  });
});

describe('auditMachineSql / auditPersonSql — the same rule in SQL', () => {
  it('builds the ILIKE predicate for a qualified column', () => {
    expect(auditMachineSql('a.actor_name_snapshot'))
      .toBe("(COALESCE(a.actor_name_snapshot, '') ILIKE 'system%')");
    expect(auditPersonSql('a.actor_name_snapshot'))
      .toBe("NOT (COALESCE(a.actor_name_snapshot, '') ILIKE 'system%')");
  });

  it('accepts a bare column', () => {
    expect(auditMachineSql('actor_name_snapshot'))
      .toBe("(COALESCE(actor_name_snapshot, '') ILIKE 'system%')");
  });

  it('refuses anything that is not a plain column reference', () => {
    for (const bad of ["a.name'; DROP TABLE scm.staff --", 'a.b.c', '', 'lower(a.name)', '1']) {
      expect(() => auditMachineSql(bad)).toThrow(/not a plain column reference/);
    }
  });

  /* The JS side and the SQL side must agree on the NULL case, which is the one
     a reader is most likely to get wrong: COALESCE makes it FALSE for machine,
     i.e. person, matching classifyAuditAuthor. Asserted as a statement about
     the fragment rather than executed, because this suite has no database. */
  it('the SQL fragment coalesces NULL so an unnamed row lands on the person side', () => {
    expect(auditMachineSql('actor_name_snapshot')).toContain("COALESCE");
    expect(classifyAuditAuthor({ actor_name_snapshot: null })).toBe('person');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   THE OVERWRITE, PROVED RED THEN GREEN.

   The scenario is the owner's, in one row: he opens the sales orders to his
   staff, a salesperson corrects the delivery address on a migrated order, and
   the next AutoCount delta sync reads the account book's older address and
   plans to write it back over her.

   `OLD_VETO_RULE` is sync-ac-delta.mjs:1175 as it stood, copied verbatim:

       if (!r.actor_id || String(r.actor_id) === SYS_ACTOR) { sysAuthored++; continue; }

   The first assertion runs that rule against her audit row and shows it lets
   the overwrite through. The second runs planPersonEditVeto against the same
   row and shows it refused. Neither needs a database: the defect is in the
   predicate, and a predicate is testable.
   ───────────────────────────────────────────────────────────────────────── */
describe('the account book must not overwrite a salesperson — red, then green', () => {
  const PINNED = '00000000-0000-4000-8000-000000000001';

  /** Her edit, in the shape scm.mfg_so_audit_log actually stores it. */
  const HER_EDIT: VetoAuditRow = {
    doc: 'HC-SO-013361',
    actor_id: PINNED,                       // auth.ts pins this for every caller
    actor_name_snapshot: 'Wei Siang',       // ...and personalises only the name
    fieldChangesText: JSON.stringify([
      { field: 'deliveryAddress', from: '12 Jalan Lama', to: '88 Jalan Baru, Klang' },
    ]),
  };

  /** The allocation cron, on the same order, in the same window. */
  const THE_CRON: VetoAuditRow = {
    doc: 'HC-SO-013361',
    actor_id: null,
    actor_name_snapshot: 'system (auto-allocate)',
    fieldChangesText: JSON.stringify([{ field: 'stockStatus', from: 'auto', to: '2 line(s) -> READY' }]),
  };

  /* The header fields the sync would write, in lib/ac-header-fields.mjs's shape. */
  const FIELDS = [
    { key: 'deliveryAddress', erp: 'delivery_address' },
    { key: 'salesAgent', erp: 'salesperson_id' },
  ];

  /* sync-ac-delta.mjs:1175, verbatim, as a predicate. */
  const OLD_VETO_RULE = (r: VetoAuditRow) => !(!r.actor_id || String(r.actor_id) === PINNED);

  it('RED: the rule that shipped classified her edit as the system and would have overwritten it', () => {
    expect(OLD_VETO_RULE(HER_EDIT)).toBe(false);
    /* And it was right about the cron — which is why nobody noticed: the rule
       looked like it was working every time it ran. */
    expect(OLD_VETO_RULE(THE_CRON)).toBe(false);
  });

  it('GREEN: the shared rule refuses her field, counts the cron, and leaves the rest of the document alone', () => {
    const veto = planPersonEditVeto([HER_EDIT, THE_CRON], FIELDS);

    expect(veto.fields.has('HC-SO-013361|deliveryAddress')).toBe(true);
    expect(veto.docs.has('HC-SO-013361')).toBe(true);

    /* The veto is per FIELD, not per document: the book may still correct the
       sales agent on this same order, because nobody touched it. */
    expect(veto.fields.has('HC-SO-013361|salesAgent')).toBe(false);

    expect(veto.rowsRead).toBe(2);
    expect(veto.personRows).toBe(1);
    expect(veto.machineRows).toBe(1);
  });

  it('a document only the cron touched is not vetoed at all', () => {
    const veto = planPersonEditVeto([THE_CRON], FIELDS);
    expect(veto.docs.size).toBe(0);
    expect(veto.fields.size).toBe(0);
    expect(veto.machineRows).toBe(1);
    expect(veto.personRows).toBe(0);
  });

  it('an empty field list vetoes nothing — so the caller must pass one, and it is required', () => {
    expect(planPersonEditVeto([HER_EDIT], []).fields.size).toBe(0);
  });

  it('matches a camelCase field_changes key against the snake_case ERP column', () => {
    const veto = planPersonEditVeto([HER_EDIT], [{ key: 'deliveryAddress', erp: 'delivery_address' }]);
    expect(veto.fields.has('HC-SO-013361|deliveryAddress')).toBe(true);
  });

  it('a field with no ERP column is skipped rather than matching everything', () => {
    const veto = planPersonEditVeto([HER_EDIT], [{ key: 'ghost', erp: null }]);
    expect(veto.fields.size).toBe(0);
  });
});
