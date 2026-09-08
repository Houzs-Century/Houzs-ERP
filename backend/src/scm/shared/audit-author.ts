// ---------------------------------------------------------------------------
// audit-author.ts — WAS THIS AUDIT ROW WRITTEN BY A PERSON, OR BY A MACHINE?
//
// THE ONE HOME. Both audit tables (scm.mfg_so_audit_log for sales orders,
// scm.entity_audit_log for every other SCM document, migration 0139) carry the
// same two columns, and three different callers have to answer the same
// question about them:
//
//   · the go-live change log the owner reads (routes/change-log.ts)
//   · the migrated-order lock check (scripts/check-so-open-for-new.mjs)
//   · the AutoCount delta sync's refusal to overwrite a person
//     (scripts/sync-ac-delta.mjs)
//
// Those three used to hold three different answers. The rule lives here, and
// they import it — check-duplicated-decisions.mjs exists because a business
// rule with two homes drifts, and this one had already drifted in the most
// expensive direction possible (see THE DEFECT, below).
//
// ── THE RULE ──
// A row is MACHINE-written when `actor_name_snapshot` starts with "system"
// (case-insensitive). Everything else is a PERSON.
//
// ── WHY THE NAME, AND NOT actor_id ──
// `actor_id` carries NO information about authorship in this codebase, and the
// reason is structural rather than accidental. scm/middleware/auth.ts:112 pins
// `c.get('user').id` to ONE seeded staff uuid — SCM_SYSTEM_STAFF_ID,
// 00000000-0000-4000-8000-000000000001 — for every authenticated SCM caller,
// because the ported 2990 routes expect a uuid and Houzs users are integers.
// All 21 `recordSoAudit` call sites in routes/mfg-sales-orders.ts pass
// `actorId: user.id`. So EVERY sales-order edit a person makes through the web
// is written with actor_id = SCM_SYSTEM_STAFF_ID. Only the NAME is
// personalised (auth.ts carries the real caller's name into
// user_metadata.name, which was itself a later fix for exactly this reason).
//
// ── THE DEFECT THIS FIXES [critical] ──
// sync-ac-delta.mjs's header lane classified authorship as
//
//     if (!r.actor_id || String(r.actor_id) === SYS_ACTOR) { sysAuthored++; continue; }
//
// with SYS_ACTOR = SCM_SYSTEM_STAFF_ID. Since that uuid is what EVERY human
// edit carries, the "never overwrite a human" veto matched every human edit as
// a system row and skipped it: the veto refused NOTHING, and the account book's
// older value would have been written over a salesperson's change with no
// signal at all. Proven by reading the two files, and asserted red-first in
// audit-author.test.ts. See docs/bugs/0702.
//
// ── WHY A NAME PREFIX IS A SOUND SIGNAL ──
// It is the writer's own self-declaration, and every machine writer in the tree
// makes it. Swept 2026-09-08 across backend/src and backend/scripts, these are
// all of them, and audit-author.test.ts pins each string verbatim:
//
//   'system (auto-allocate)'                    so-stock-allocation.ts:998
//   'System (auto-allocate)'                    so-stock-allocation.ts:1082
//   'System (free gift)'                        free-gift-reconcile.ts:138, :237
//   'System (delivery sync)'                    so-delivery-sync.ts:129, :360
//   'System (2990 delivered-chain backfill)'    backfill-2990-delivered-dos.mjs:127
//
// ── THE PERMISSIVE DIRECTION IS "PERSON", DELIBERATELY ──
// A row with NO name at all counts as a PERSON. It is the direction that
// SURFACES a row rather than hiding it: on the change log an unattributed edit
// is exactly the thing the owner wants to see, and on the sync guard it costs a
// refusal (which is reported and reversible) instead of an overwrite (which is
// not). This half of the rule is inherited from check-so-open-for-new.mjs,
// where PR #3177 established it after a run reported "50 staff actions" that
// were 50 of 50 the allocation cron.
//
// ── WHAT THIS GENERALISES ──
// #3177's rule was `actor_id IS NULL AND name ILIKE 'system%'`. The actor_id
// arm is dropped here because it is a constant, and because it made the two
// so-delivery-sync writers — which pass the caller's pinned actor_id through —
// read as people. Every row #3177 called a machine, this still calls a machine.
//
// ── WHAT IT DOES NOT DECIDE ──
// `source` ('web', 'automation', 'auto-allocation', 'backfill', …) is REPORTED
// by the readers and decides nothing. It is a free-form column with 30+ live
// spellings, several of which are not audit sources at all; making it a second
// arm of this rule would be a second rule wearing the first one's name.
// ---------------------------------------------------------------------------

/** The self-declaration every machine writer makes, lower-cased. */
export const AUDIT_MACHINE_NAME_PREFIX = 'system';

/** What wrote an audit row. Two values, no third — an "unknown" would only ever
 *  be rendered as one of these anyway, and naming it invites a caller to invent
 *  its own tie-break, which is how the rule got two homes the first time. */
export type AuditAuthor = 'person' | 'machine';

/** The two columns the rule reads. Both nullable in both tables; both REQUIRED
 *  here — a caller that has not loaded `actor_name_snapshot` must not be able
 *  to omit it and silently get "person" for every row. */
export type AuditAuthorRow = {
  actor_name_snapshot: string | null;
  /* Read for nothing but the record. Present in the type so a caller passing a
     whole audit row type-checks, and so the docblock above has somewhere to
     point when the next person asks why it is not consulted. */
  actor_id?: string | null;
};

/**
 * Person or machine, for ONE audit row.
 *
 * `row` is required and so is `row.actor_name_snapshot` — an optional
 * parameter that DECIDES something is how this rule silently answers "person"
 * for a query that forgot to select the column.
 */
export function classifyAuditAuthor(row: AuditAuthorRow): AuditAuthor {
  const name = (row.actor_name_snapshot ?? '').trim().toLowerCase();
  return name.startsWith(AUDIT_MACHINE_NAME_PREFIX) ? 'machine' : 'person';
}

/** Convenience for the common filter. Same rule, one place. */
export function isPersonAuthored(row: AuditAuthorRow): boolean {
  return classifyAuditAuthor(row) === 'person';
}

/**
 * The SAME rule as a SQL predicate, for the raw-SQL readers (the two scripts
 * run against postgres.js and cannot pass every row through JS before the
 * count). Returns a fragment that is TRUE for a MACHINE row.
 *
 * `column` is required: there is no sensible default when the two tables spell
 * the table alias differently, and a default would let a caller point the rule
 * at the wrong column without noticing.
 *
 * The fragment is interpolated into SQL, so the column reference is validated
 * rather than trusted — this takes an identifier from the CALLER, and a caller
 * is one refactor away from taking it from somewhere else.
 */
export function auditMachineSql(column: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(column)) {
    throw new Error(`auditMachineSql: not a plain column reference: ${column}`);
  }
  /* ILIKE 'system%' is the same test as classifyAuditAuthor's
     startsWith on a lower-cased string; COALESCE makes a NULL name FALSE here,
     which is "person", matching the JS side's permissive direction. */
  return `(COALESCE(${column}, '') ILIKE '${AUDIT_MACHINE_NAME_PREFIX}%')`;
}

/** TRUE for a PERSON row. The readers want this one more often than its twin. */
export function auditPersonSql(column: string): string {
  return `NOT ${auditMachineSql(column)}`;
}

/* ──────────────────────────────────────────────────────────────────────
   THE VETO — "a row a person has edited is theirs".
   ────────────────────────────────────────────────────────────────────── */

/** One audit row, reduced to what the veto reads. */
export type VetoAuditRow = AuditAuthorRow & {
  /** The document the row belongs to (so_doc_no, or entity_doc_no). */
  doc: string;
  /** `field_changes` rendered as text. The match is a substring test over the
   *  whole blob — the same test sync-ac-delta has always used; only the
   *  AUTHORSHIP arm changed, and changing two things at once is how a fix
   *  becomes unattributable. */
  fieldChangesText: string;
};

/** A field the sync knows how to write: its own key, and the ERP column. */
export type VetoField = { key: string; erp: string | null | undefined };

export type PersonEditVeto = {
  /** `${doc}|${fieldKey}` for every field a PERSON changed. */
  fields: Set<string>;
  /** The documents at least one of those fields belongs to. */
  docs: Set<string>;
  /** Denominators, for the run to print. */
  rowsRead: number;
  machineRows: number;
  personRows: number;
};

const camelise = (s: string) => s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/**
 * Which (document, field) pairs a PERSON has edited, and must therefore never
 * be overwritten from the account book.
 *
 * Both parameters are REQUIRED. `fields` in particular decides the whole
 * outcome: defaulting it to an empty list would make the veto vacuously empty
 * and every overwrite would proceed, which is the exact failure this function
 * exists to prevent.
 */
export function planPersonEditVeto(rows: VetoAuditRow[], fields: VetoField[]): PersonEditVeto {
  const out: PersonEditVeto = {
    fields: new Set(),
    docs: new Set(),
    rowsRead: rows.length,
    machineRows: 0,
    personRows: 0,
  };
  const inScope = fields.filter((f): f is { key: string; erp: string } => !!f.erp);
  for (const r of rows) {
    if (classifyAuditAuthor(r) === 'machine') { out.machineRows++; continue; }
    out.personRows++;
    const fc = (r.fieldChangesText || '').toLowerCase();
    for (const f of inScope) {
      if (fc.includes(f.erp.toLowerCase()) || fc.includes(camelise(f.erp).toLowerCase())) {
        out.fields.add(`${r.doc}|${f.key}`);
        out.docs.add(r.doc);
      }
    }
  }
  return out;
}
