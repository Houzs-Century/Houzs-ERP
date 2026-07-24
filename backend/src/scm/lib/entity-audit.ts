// ----------------------------------------------------------------------------
// entity-audit.ts — the audit-trail writer for every SCM document that is NOT a
// Sales Order. Sibling of lib/so-audit.ts, writing scm.entity_audit_log
// (migration 0139) keyed by (entity_type, entity_id) instead of so_doc_no.
//
// Owner's rule: every edit records WHO, WHEN to the minute, and WHAT changed
// from-value -> to-value. so-audit.ts is the only place in this tree that has
// ever obeyed it; this is that same mechanism pointed at money and stock.
//
// `diffFields` is IMPORTED from so-audit rather than reimplemented. Two differs
// would drift, and the whole point of a from->to record is that both tables
// answer the question the same way.
// ----------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import { diffFields, type FieldChange } from './so-audit';
import { resolveCallerStaffId } from './salesScope';
import { isMissingRpc } from './rpc-missing';

export { diffFields };
export type { FieldChange };

/* The documents this log covers. A closed union rather than a free string so a
   typo cannot silently create a second, invisible history for the same module —
   the read endpoint filters on this exact value. */
export const ENTITY_TYPES = [
  'PAYMENT_VOUCHER',
  'GRN',
  'STOCK_TAKE',
  'STOCK_TRANSFER',
  'INVENTORY_ADJUSTMENT',
  /* The document modules, added after the money/stock set. entity_type is plain
     text in migration 0139 with NO check constraint, deliberately (see the
     migration header), so extending this list needs no migration — but it is
     still the ONLY list, because the read endpoint rejects anything not in it. */
  'SALES_INVOICE',
  'PURCHASE_ORDER',
  'PURCHASE_INVOICE',
  'DELIVERY_ORDER',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(v: unknown): v is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(String(v));
}

/* Stable verbs, shared across every module. so-audit.ts uses per-module verbs
   (ADD_PAYMENT, UPDATE_LINE...) because it describes ONE document type; this log
   spans five, so the verb answers "what kind of event" and the entity_type
   answers "to what". A renderer can label six verbs; it cannot label an open set. */
/* SEND is the only verb here whose event leaves the building: it records that a
   document was transmitted to an EXTERNAL party (today, a PO emailed to its
   supplier). It is a separate verb rather than an UPDATE because the question it
   answers is different — "who told the supplier, and when" is asked long after
   nobody cares which column changed. */
/* AMENDMENT_PO_APPROVED is the one document-revision verb — a Purchase Order
   amendment was approved and APPLIED (snapshot + line diffs + revision bump),
   the PO-side mirror of the SO trail's 'AMENDMENT_PO_APPROVED' recordSoAudit
   action. It answers "who revised this PO, and to which revision", which UPDATE
   (a field edit) does not. See lib/po-revision.ts applyPoAmendment. */
export const AUDIT_ACTIONS = ['CREATE', 'UPDATE', 'POST', 'CANCEL', 'REVERSE', 'DELETE', 'SEND', 'AMENDMENT_PO_APPROVED'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/* The Houzs caller, as middleware/auth.ts stashes it. Deliberately structural:
   the writer needs three fields and taking the whole Variables type would couple
   every caller's import graph to Hono's context generics. */
export type AuditActor = {
  id?: number | null;
  name?: string | null;
  email?: string | null;
};

export type RecordEntityAuditArgs = {
  entityType: EntityType;
  entityId: string;
  entityDocNo?: string | null;
  action: AuditAction;
  /* The REAL Houzs user (c.get('houzsUser')), never c.get('user'). See the actor
     resolution note below — this distinction is the difference between an audit
     trail and a list of identical rows. */
  actor?: AuditActor | null;
  companyId?: number | null;
  fieldChanges?: FieldChange[];
  statusSnapshot?: string | null;
  source?: string;
  note?: string;
};

/** What actually happened to the history row. See recordEntityAudit. */
export type AuditWriteResult = {
  /** true only when the row is committed. */
  recorded: boolean;
  /** Machine-readable cause, for logging. Never shown to an operator. */
  reason?: string;
};

/**
 * Append one row to scm.entity_audit_log.
 *
 * THE OWNER HAS NOW RULED (2026-07-19): a user must never believe an edit
 * succeeded when its audit record did not get written. "如果人家改了单，就不可以失
 * 败呀。那如果失败的话，你就要跳出警告，跟他说'你失败了，请重新操作'。"
 *
 * That ruling is NOT honoured by throwing from here, and the docblock that used
 * to sit at this spot proposed exactly that. Every call site of this function
 * runs AFTER the business write has committed — deliberately, and the placement
 * comments at those sites say why. Throwing here would produce "you failed,
 * please redo" for a payment voucher that has already posted its journal entry:
 * the operator posts it twice and the ledger is wrong. That is a worse lie than
 * the silence it replaces.
 *
 * The ruling is honoured by ORDER instead. assertAuditWritable (below) asks the
 * audit sink whether it will accept a row BEFORE the handler changes anything;
 * a handler that gets `false` refuses up front, and "nothing was changed, please
 * try again" is then simply true. See lib/rpc-missing and
 * scripts/scm-schema/audit-sink-probe.sql.
 *
 * This function therefore stays NON-THROWING — a GRN that received stock must
 * not un-receive it because the history row would not write, and rolling back a
 * write the user watched succeed is the same bug pointing the other way. What
 * changes is that it no longer swallows the OUTCOME: it returns whether it
 * recorded. No caller acts on that yet — see the residual-case note further down
 * for why surfacing it needs a success-response convention this API does not
 * have — but the value exists so the follow-up has a hook, and the log line now
 * states plainly that the business write had already committed.
 *
 * Callers that ignore the return value keep today's behaviour, which is correct
 * for them: the pre-flight is the guarantee, this is the reporting.
 */
export async function recordEntityAudit(
  sb: SupabaseClient,
  args: RecordEntityAuditArgs,
): Promise<AuditWriteResult> {
  try {
    /* ACTOR RESOLUTION — the reason this writer takes `houzsUser` and not the
       Supabase-shaped `user`. Inside /api/scm/*, middleware/auth.ts PINS
       c.get('user').id to one seeded system staff uuid for every caller (a type
       shim: 2990's routes expect a uuid, Houzs users are integers). so-audit.ts's
       47 call sites pass that pinned id, so mfg_so_audit_log.actor_id names the
       same system row on every entry ever written — only its
       actor_name_snapshot is personalised, and that was itself a later fix.
       Copying that would ship a money-movement log whose actor column is a
       constant. The mig-0066 bridge gives every non-disabled user a real staff
       uuid; resolveCallerStaffId is the documented way to reach it. */
    let actorId: string | null = null;
    if (args.actor?.id != null) {
      try {
        actorId = await resolveCallerStaffId(sb, args.actor.id);
      } catch {
        /* swallow — an unattributed row still records WHEN and WHAT. */
      }
    }

    /* Snapshotted at write time so renaming or disabling the user later cannot
       rewrite history. Falls back to the email because a row that says WHO in
       any form beats one that says nobody. */
    const actorName = args.actor?.name ?? args.actor?.email ?? null;

    const { error } = await sb.from('entity_audit_log').insert({
      entity_type:         args.entityType,
      entity_id:           args.entityId,
      entity_doc_no:       args.entityDocNo ?? null,
      ...(args.companyId != null ? { company_id: args.companyId } : {}),
      action:              args.action,
      actor_id:            actorId,
      actor_name_snapshot: actorName,
      field_changes:       args.fieldChanges ?? [],
      status_snapshot:     args.statusSnapshot ?? null,
      source:              args.source ?? 'web',
      note:                args.note ?? null,
    });
    if (error) {
      /* Reported, not swallowed, and not thrown — the business write is already
         committed by the time we are here. The pre-flight is what prevents this;
         reaching this branch means the sink died inside that window. */
      // eslint-disable-next-line no-console
      console.error(
        '[entity-audit] insert failed AFTER the business write committed:',
        args.entityType, args.entityId, args.action, error.message,
      );
      return { recorded: false, reason: error.message };
    }
    return { recorded: true };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      '[entity-audit] unexpected error AFTER the business write committed:',
      args.entityType, args.entityId, args.action, e,
    );
    return { recorded: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/* ──────────────────────────────────────────────────────────────────────
   THE PRE-FLIGHT — the mechanism that makes the owner's ruling honest.
   ────────────────────────────────────────────────────────────────────── */

/**
 * The refusal an operator sees when the audit trail is not writable and the
 * handler therefore did NOT change the document.
 *
 * The wording is load-bearing in two directions. It must be TRUE — "nothing has
 * been changed" is only sayable because the pre-flight runs before the first
 * mutating call — and it must SURVIVE the client's filter: humanApiError
 * (frontend/src/vendor/scm/lib/authed-fetch.ts) drops a server sentence that is
 * over 200 characters, starts with a brace, or contains internals vocabulary
 * (including any bare five-digit number), and falls back to a generic status
 * line. A sentence that gets filtered out is a sentence the operator never sees,
 * so the shape of this string is asserted in tests/entityAudit.test.ts.
 *
 * `error` is deliberately NOT a key in the client's ERROR_CODE_MESSAGES table:
 * that table wins over `message`, so adding an entry there would freeze the
 * wording in the frontend bundle and split it across two repositories' worth of
 * deploys. Unmapped code + plain `message` is the established convention here
 * (see routes/pwp-codes.ts and routes/mfg-sales-orders.ts).
 */
export const AUDIT_UNAVAILABLE_ERROR = 'audit_trail_unavailable';
export const AUDIT_UNAVAILABLE_MESSAGE =
  'This change was not saved, because the record of who changed what could not be written. Nothing has changed. Please try again in a moment, and tell IT if it keeps happening.';

/* THE RESIDUAL CASE IS NOT CLOSED BY THIS FILE, AND IS NOT PRETENDED TO BE.
   If the sink dies in the window between a green pre-flight and the insert, the
   change is saved and unrecorded, and the operator is told nothing. Telling them
   would need a warning carried on a SUCCESS response — and this API has no such
   convention (every route reports trouble only through an error status, which
   humanApiError then maps). Inventing one here means a new response field plus a
   display path in every SCM page that saves, which is a different change than
   this one. recordEntityAudit returns AuditWriteResult so that work has a hook;
   until it is done the window is logged loudly and listed as an open gap in
   BUG-HISTORY. It is narrow — microseconds against a probe taken moments before —
   but it is real, and a comment saying so beats a message that implies it is
   handled. */

/** The 409 body for a pre-flight refusal. One shape, so every handler refuses identically. */
export function auditUnavailableBody(): { error: string; message: string } {
  return { error: AUDIT_UNAVAILABLE_ERROR, message: AUDIT_UNAVAILABLE_MESSAGE };
}

export type AuditPreflight = { ok: boolean; reason?: string };

/**
 * Ask the audit sink whether it will accept a row, BEFORE the caller changes
 * anything. A handler that gets `ok: false` must return auditUnavailableBody()
 * with status 409 and write nothing.
 *
 * PREFERRED PATH — scm.entity_audit_writable performs a real INSERT inside a
 * subtransaction and rolls it back, so it proves the write path end to end
 * (grants, NOT NULLs, schema cache) and leaves no row. The table stays
 * append-only: the probe never commits.
 *
 * FALLBACK — until that function is applied to a given database the RPC is
 * absent; we detect that AND ONLY THAT (isMissingRpc) and fall back to a SELECT,
 * which proves reachability but not writability. That is strictly weaker and is
 * the reason the SQL exists; it is not a substitute for applying it.
 *
 * FAILING OPEN IS THE RIGHT DEFAULT FOR AN UNKNOWN, AND WE DO NOT DO IT. If the
 * probe itself errors we return ok: false and the edit is refused. That is the
 * whole point of the ruling: a refusal costs the operator one retry, whereas
 * proceeding costs an unrecorded change to money or stock, which nobody
 * discovers. The bias is deliberate and belongs here, not at the call sites.
 */
export async function assertAuditWritable(
  sb: SupabaseClient,
  args: { entityType: EntityType; entityId?: string | null; action: AuditAction; companyId?: number | null },
): Promise<AuditPreflight> {
  try {
    const { data, error } = await sb.rpc('entity_audit_writable', {
      p_entity_type: args.entityType,
      /* A CREATE has no id yet — the probe row is rolled back, so a placeholder
         costs nothing and still exercises the NOT NULL on entity_id. */
      p_entity_id: args.entityId ?? 'preflight',
      p_action: args.action,
      p_company_id: args.companyId ?? null,
    });
    if (!error) {
      if (data === true) return { ok: true };
      return { ok: false, reason: 'probe_reported_not_writable' };
    }
    if (!isMissingRpc(error)) {
      /* The function exists and the call failed: the sink is unreachable or the
         database is refusing us. Refuse. */
      // eslint-disable-next-line no-console
      console.error('[entity-audit] pre-flight probe failed:', args.entityType, error.message);
      return { ok: false, reason: error.message };
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[entity-audit] pre-flight probe threw:', args.entityType, e);
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  /* RPC not applied to this database yet — reachability-only fallback. */
  try {
    const { error } = await sb.from('entity_audit_log').select('id').limit(1);
    if (error) {
      // eslint-disable-next-line no-console
      console.error('[entity-audit] pre-flight fallback read failed:', args.entityType, error.message);
      return { ok: false, reason: error.message };
    }
    return { ok: true, reason: 'reachability_only' };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[entity-audit] pre-flight fallback read threw:', args.entityType, e);
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/* ──────────────────────────────────────────────────────────────────────
   Pure helpers for building FieldChange arrays outside a patch-body diff.
   ────────────────────────────────────────────────────────────────────── */

/**
 * One explicit from->to pair, or null when nothing moved.
 *
 * MONEY IS INTEGER SEN IN THIS CODEBASE and must be recorded as the INTEGER, not
 * a formatted string: "RM 1,234.50" cannot be summed, compared or reconciled,
 * and the moment a locale changes the history becomes unparseable. Formatting is
 * the reader's job. Pass amount_centi straight in.
 */
export function fieldChange(field: string, from: unknown, to: unknown): FieldChange | null {
  const a = from == null ? '' : String(from);
  const b = to == null ? '' : String(to);
  if (a === b) return null;
  return { field, from: from ?? null, to: to ?? null };
}

/** Drop the no-ops from a hand-built list. */
export function compactChanges(changes: Array<FieldChange | null>): FieldChange[] {
  return changes.filter((c): c is FieldChange => c !== null);
}

/**
 * The from->to pair for a status transition, the shape POST / CANCEL / REVERSE
 * all record. Separate from `fieldChange` only so every module spells the field
 * name identically — a renderer keying on 'status' must not meet 'Status' too.
 */
export function statusChange(from: string | null | undefined, to: string): FieldChange[] {
  const c = fieldChange('status', from ?? null, to);
  return c ? [c] : [];
}
