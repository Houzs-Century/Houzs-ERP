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
import { Hono } from 'hono';
import {
  classifyAuditAuthor,
  isPersonAuthored,
  auditMachineSql,
  auditPersonSql,
} from './audit-author';
import { supabaseAuth, SCM_SYSTEM_STAFF_ID } from '../middleware/auth';
import type { Variables } from '../env';

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
   THE MEASUREMENT THE WHOLE RULE RESTS ON, RUN RATHER THAN READ.

   Everything above depends on one claim: `actor_id` cannot distinguish a
   person from the system, because the auth middleware pins ONE uuid onto every
   authenticated SCM caller. That claim has now been wrong twice in this
   repository's history, in both directions, and each time it was settled by
   reading a file:

     · sync-ac-delta.mjs read `!actor_id` as "the system did it" and overwrote
       people's edits (docs/bugs/0700).
     · the fix for that kept `actor_id === <pinned uuid> => system`, which is
       the same mistake wearing the opposite sign (docs/bugs/0703).

   So this suite EXECUTES the real middleware instead of quoting it. A caller
   whose Houzs user id is 4242 goes in; what comes back out on `c.get('user')`
   is the assertion. If the pinning ever changes, this fails, and the rule is
   revisited on purpose rather than becoming quietly wrong a third time.
   ───────────────────────────────────────────────────────────────────────── */
describe('the pinned actor — measured, not quoted', () => {
  it('supabaseAuth replaces the caller id with ONE uuid, so actor_id carries no authorship', async () => {
    /* Typed as the SCM app's own Variables so `houzsUser` resolves — the bare
       Hono generic knows only the global ContextVariableMap. */
    const app = new Hono<{ Variables: Variables }>();
    let seenUserId: unknown = 'the handler never ran';
    let seenHouzsId: unknown = null;

    app.use('*', async (c, next) => {
      /* What the global /api/* auth leaves behind: the REAL Houzs user. */
      c.set('user', { id: 4242, email: 'ws@example.com', name: 'Wei Siang', permissions: ['*'] } as never);
      await next();
    });
    app.use('*', supabaseAuth);
    app.get('/probe', (c) => {
      seenUserId = (c.get('user') as { id?: unknown }).id;
      seenHouzsId = (c.get('houzsUser') as { id?: unknown } | undefined)?.id ?? null;
      return c.text('ok');
    });

    /* getSupabaseService reads these off the env; the client is never called. */
    const res = await app.request('/probe', {}, {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40),
    } as never);

    expect(res.status).toBe(200);
    /* THE FINDING: her id went in, the pinned uuid came out. This is the value
       all 21 `actorId: user.id` call sites in routes/mfg-sales-orders.ts write
       onto her audit row. */
    expect(seenUserId).toBe(SCM_SYSTEM_STAFF_ID);
    /* Her real identity survives only on houzsUser (an integer) and, for the
       audit trail, in the NAME snapshot — which is why the name is the signal. */
    expect(seenHouzsId).toBe(4242);
  });
});
