// THE GUARD: a sync must never overwrite a row a PERSON edited. It must refuse
// and say which document, which line, both values, and who.
//
// EVERY ASSERTION IN THIS FILE FAILED on the tree it was written against
// (2026-09-08, branch fix/sync-human-edit-guard, before the fix commit). The
// red run is the evidence; the two bug entries are
// docs/bugs/0693-* and docs/bugs/0694-*.
//
// The two defects being pinned:
//
//   1. scripts/sync-ac-delta.mjs section 6 read `!r.actor_id` as "the SYSTEM
//      wrote this row". A null actor is a NORMAL shape for a person's row in
//      this schema — so-amendments.ts:262 writes one on purpose, so-handover.ts
//      writes one whenever the session's user object is thin — and a person's
//      edit classified as the system's is a person's edit OVERWRITTEN, with no
//      conflict printed anywhere.
//
//   2. the same section vetoed PURCHASE-ORDER header writes against a set keyed
//      by SALES-ORDER document numbers, so `humanField.has('PO-010163|po_date')`
//      could never be true and the PO header lane had NO human veto at all.
//      `po_date` is staff-editable (routes/mfg-purchase-orders.ts:2546 PATCH)
//      and is `kind: "copy"` in PO_HEADER_FIELDS, so it was planned and written
//      straight over the person's value.
//
// The behavioural half runs against scripts/lib/ac-human-edit.mjs. The
// source-anchored half is here for the reason keyWithoutIdentityGuards.test.mjs
// gives: the property is not "the rule is right", it is "the rule is APPLIED AT
// THIS CALL SITE", and a call-site population is exactly what a unit test
// cannot see. If a refactor moves the code, re-anchor these — do not delete
// them.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MIGRATION_ACTOR_ID,
  formatHumanRefusal,
  humanEditIndex,
  humanTouchedDocs,
  isSystemAuditRow,
  normaliseFieldChanges,
} from '../scripts/lib/ac-human-edit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const read = (p) => readFileSync(join(BACKEND, p), 'utf8');

/* The audit row so-handover.ts:189 writes when a person reassigns a migrated
   order's salesperson and the session's user object carries no id — actor_id
   NULL, actor_name_snapshot NULL, and a field the header lane WRITES. */
const HANDOVER_BY_A_PERSON = {
  docNo: 'HC-SO-012929',
  actorId: null,
  actorName: null,
  at: '2026-09-08T02:15:00.000Z',
  action: 'UPDATE_DETAILS',
  fieldChanges: [{ field: 'salespersonId', from: 'staff-a', to: 'staff-b' }],
};

/* The same edit made by a named person through a route that leaves actor_id
   null on purpose (so-amendments.ts:262). */
const NAMED_PERSON_NULL_ACTOR = {
  ...HANDOVER_BY_A_PERSON,
  actorName: 'Wei Siang',
};

/* What the stock-allocation cron writes, constantly, on every migrated order:
   so-stock-allocation.ts:998 (lower case) and :1082 (capitalised). */
const CRON_ROW = {
  docNo: 'HC-SO-012929',
  actorId: null,
  actorName: 'system (auto-allocate)',
  at: '2026-09-08T02:16:00.000Z',
  action: 'UPDATE_LINE',
  fieldChanges: [{ field: 'stockStatus', from: 'auto', to: '2 line(s) -> READY' }],
};

const CRON_ROW_CAPITALISED = { ...CRON_ROW, actorName: 'System (auto-allocate)', action: 'UPDATE_STATUS' };

/* The migration's own writes carry the pinned actor id. */
const MIGRATION_ROW = {
  docNo: 'HC-SO-012929',
  actorId: MIGRATION_ACTOR_ID,
  actorName: 'AutoCount import',
  at: '2026-08-29T00:00:00.000Z',
  action: 'CREATE',
  fieldChanges: [{ field: 'salespersonId', from: null, to: 'staff-a' }],
};

const SO_FIELDS = [
  { key: 'salesperson_id', erp: 'salesperson_id' },
  { key: 'delivery_address', erp: 'delivery_address' },
  { key: '(CreditorName)', erp: null },
];

describe('isSystemAuditRow — the authorship rule, identical to check-so-open-for-new.mjs', () => {
  it('a null actor named "system…" is the cron, in both spellings the code writes', () => {
    expect(isSystemAuditRow(CRON_ROW, MIGRATION_ACTOR_ID)).toBe(true);
    expect(isSystemAuditRow(CRON_ROW_CAPITALISED, MIGRATION_ACTOR_ID)).toBe(true);
  });

  it("the migration's pinned actor is the system", () => {
    expect(isSystemAuditRow(MIGRATION_ROW, MIGRATION_ACTOR_ID)).toBe(true);
  });

  it('RED: a NAMED person whose row carries a null actor_id is a PERSON, not the system', () => {
    // This is defect 1. `!r.actor_id` answered `true` here and the edit was overwritten.
    expect(isSystemAuditRow(NAMED_PERSON_NULL_ACTOR, MIGRATION_ACTOR_ID)).toBe(false);
  });

  it('RED: an UNATTRIBUTED row is a PERSON — the permissive direction would hide it', () => {
    expect(isSystemAuditRow(HANDOVER_BY_A_PERSON, MIGRATION_ACTOR_ID)).toBe(false);
    expect(isSystemAuditRow({ actorId: null, actorName: '' }, MIGRATION_ACTOR_ID)).toBe(false);
  });

  it('an ordinary staff actor_id is a person', () => {
    expect(isSystemAuditRow({ actorId: 'e3f0…', actorName: 'Ah Meng' }, MIGRATION_ACTOR_ID)).toBe(false);
  });

  it('a name merely CONTAINING "system" is not the cron — the match is a prefix, like the SQL', () => {
    expect(isSystemAuditRow({ actorId: null, actorName: 'Ana Systems' }, MIGRATION_ACTOR_ID)).toBe(false);
  });

  it('a table with no pinned migration actor passes null, and null never matches an actor', () => {
    expect(isSystemAuditRow({ actorId: MIGRATION_ACTOR_ID, actorName: null }, null)).toBe(false);
    expect(isSystemAuditRow({ actorId: null, actorName: 'system' }, null)).toBe(true);
  });

  it('the deciding parameter is REQUIRED, so the compiler-equivalent is a throw at every call site', () => {
    expect(() => isSystemAuditRow(CRON_ROW)).toThrow(/migrationActorId is required/);
  });
});

describe('humanEditIndex — per (document, field), with WHO', () => {
  it('RED: a person\'s null-actor edit vetoes the field the sync would write', () => {
    const ix = humanEditIndex({
      rows: [MIGRATION_ROW, CRON_ROW, NAMED_PERSON_NULL_ACTOR],
      fields: SO_FIELDS,
      migrationActorId: MIGRATION_ACTOR_ID,
    });
    expect(ix.byDocField.has('HC-SO-012929|salesperson_id')).toBe(true);
    expect(ix.byDocField.get('HC-SO-012929|salesperson_id').who).toContain('Wei Siang');
    expect(ix.personRows).toBe(1);
    expect(ix.systemRows).toBe(2);
  });

  it('a field the person did NOT touch is left writable — the veto is per field, not per document', () => {
    const ix = humanEditIndex({
      rows: [NAMED_PERSON_NULL_ACTOR],
      fields: SO_FIELDS,
      migrationActorId: MIGRATION_ACTOR_ID,
    });
    expect(ix.byDocField.has('HC-SO-012929|salesperson_id')).toBe(true);
    expect(ix.byDocField.has('HC-SO-012929|delivery_address')).toBe(false);
  });

  it('matches the snake_case spelling of a column as well as the camelCase one', () => {
    const snake = { ...NAMED_PERSON_NULL_ACTOR, fieldChanges: [{ field: 'salesperson_id', from: 1, to: 2 }] };
    const ix = humanEditIndex({ rows: [snake], fields: SO_FIELDS, migrationActorId: MIGRATION_ACTOR_ID });
    expect(ix.byDocField.has('HC-SO-012929|salesperson_id')).toBe(true);
  });

  it('a field with no ERP column can never be vetoed, because it can never be written', () => {
    const row = { ...NAMED_PERSON_NULL_ACTOR, fieldChanges: [{ field: 'CreditorName', from: 'a', to: 'b' }] };
    const ix = humanEditIndex({ rows: [row], fields: SO_FIELDS, migrationActorId: MIGRATION_ACTOR_ID });
    expect(ix.byDocField.size).toBe(0);
  });

  it('the cron alone leaves everything writable', () => {
    const ix = humanEditIndex({
      rows: [CRON_ROW, CRON_ROW_CAPITALISED],
      fields: SO_FIELDS,
      migrationActorId: MIGRATION_ACTOR_ID,
    });
    expect(ix.byDocField.size).toBe(0);
    expect(ix.byDoc.size).toBe(0);
    expect(ix.systemRows).toBe(2);
  });

  it('migrationActorId is required here too', () => {
    expect(() => humanEditIndex({ rows: [], fields: [] })).toThrow(/migrationActorId is required/);
  });
});

describe('humanTouchedDocs — the document-level answer for the narrowed lanes', () => {
  it('RED: 550 cron rows do not make a document "staff edited"', () => {
    const rows = Array.from({ length: 550 }, () => CRON_ROW);
    const ix = humanTouchedDocs({ rows, migrationActorId: MIGRATION_ACTOR_ID });
    expect(ix.byDoc.size).toBe(0);
    expect(ix.systemRows).toBe(550);
    expect(ix.personRows).toBe(0);
  });

  it('one person among them refuses the document, and is named', () => {
    const rows = [CRON_ROW, NAMED_PERSON_NULL_ACTOR, CRON_ROW_CAPITALISED];
    const ix = humanTouchedDocs({ rows, migrationActorId: MIGRATION_ACTOR_ID });
    expect(ix.byDoc.get('HC-SO-012929').who).toContain('Wei Siang');
    expect(ix.personRows).toBe(1);
  });
});

describe('normaliseFieldChanges', () => {
  it('accepts the parsed jsonb the driver returns and the ::text a caller may select', () => {
    expect(normaliseFieldChanges([{ field: 'a', from: 1, to: 2 }])).toEqual([{ field: 'a', from: 1, to: 2 }]);
    expect(normaliseFieldChanges('[{"field":"a","from":1,"to":2}]')).toEqual([{ field: 'a', from: 1, to: 2 }]);
  });
  it('a malformed value is empty, never a throw inside a sync', () => {
    expect(normaliseFieldChanges('not json')).toEqual([]);
    expect(normaliseFieldChanges(null)).toEqual([]);
  });
});

describe('formatHumanRefusal — document, line, BOTH values, who', () => {
  it('names all four', () => {
    const s = formatHumanRefusal({
      doc: 'HC-SO-012929', line: 'dtl=44821', field: 'description2',
      erp: 'ELT 2ER', book: 'ELT 2ER CNR', who: 'Wei Siang', at: '2026-09-08T02:15:00.000Z',
    });
    expect(s).toContain('HC-SO-012929');
    expect(s).toContain('dtl=44821');
    expect(s).toContain('ELT 2ER');
    expect(s).toContain('ELT 2ER CNR');
    expect(s).toContain('Wei Siang');
    expect(s).toContain('REFUSED');
  });

  it('a header field says so instead of pretending to have a line', () => {
    const s = formatHumanRefusal({ doc: 'PO-010163', line: null, field: 'po_date', erp: '2026-08-01', book: '2026-07-20', who: 'Ah Meng' });
    expect(s).toContain('(header)');
    expect(s).toContain('PO-010163');
  });

  it('`line` is required — a header genuinely has none, and that is not the same as forgetting', () => {
    expect(() => formatHumanRefusal({ doc: 'X', field: 'f', erp: 1, book: 2, who: 'w' }))
      .toThrow(/`line` is required/);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   THE CALL SITES. sync-ac-delta.mjs is the only writer these rules exist for.
   ──────────────────────────────────────────────────────────────────────────── */
describe('scripts/sync-ac-delta.mjs applies the rule at every lane', () => {
  const src = read('scripts/sync-ac-delta.mjs');

  it('imports the one home rather than re-deciding authorship inline', () => {
    expect(src).toMatch(/from "\.\/lib\/ac-human-edit\.mjs"/);
  });

  it('RED: the header lane no longer reads a null actor as the SYSTEM', () => {
    // The exact expression that lost the edit.
    expect(src).not.toContain('if (!r.actor_id || String(r.actor_id) === SYS_ACTOR)');
    // and nothing else in the file may reintroduce the shape
    expect(src).not.toMatch(/!\s*r\.actor_id\s*\|\|/);
  });

  it('RED: the PURCHASE-ORDER header lane has a veto of its own, from entity_audit_log', () => {
    // Defect 2: humanField was keyed on so_doc_no and the PO tally looked itself
    // up in it by po_number, so it could never match.
    expect(src).toMatch(/entity_audit_log[\s\S]{0,400}PURCHASE_ORDER/);
    expect(src).toContain('poHumanField');
  });

  it('the PO header tally is handed its own veto index, not the sales-order one', () => {
    const poTally = src.match(/tally\(\s*"PURCHASE ORDER HEADERS"[^\n]*\n?[^\n]*/);
    expect(poTally, 'the PO tally call moved — re-anchor this test, do not delete it').not.toBeNull();
    expect(poTally[0]).toContain('poHumanField');
  });

  it('every refusal names the person, so a conflict is actionable rather than a count', () => {
    expect(src).toContain('formatHumanRefusal');
  });

  it('`version` is never used as an authorship signal', () => {
    // It may still appear as an extra conservatism on the desc/pay lanes, but
    // it must never be the thing that ANSWERS "did a person edit this".
    expect(src).not.toMatch(/const\s+touched\s*=\s*new Set\(\);/);
  });
});
