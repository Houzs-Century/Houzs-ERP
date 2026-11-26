
import type { SupabaseClient } from '@supabase/supabase-js';
import { diffFields, type FieldChange } from './so-audit';
import { resolveCallerStaffId } from './salesScope';
import { isMissingRpc, isUnsupportedTransactionRpc } from './rpc-missing';

export { diffFields };
export type { FieldChange };

export const ENTITY_TYPES = [
  'PAYMENT_VOUCHER',
  'GRN',
  'STOCK_TAKE',
  'STOCK_TRANSFER',
  'INVENTORY_ADJUSTMENT',
  'SALES_INVOICE',
  'PURCHASE_ORDER',
  'PURCHASE_INVOICE',
  'DELIVERY_ORDER',
  'PURCHASE_RETURN',
  /* 申请付款 (owner 2026-09-30): a payment request's own trail — submitted,
     edited, withdrawn, returned by Finance with the why, answered by a voucher. */
  'PAYMENT_REQUEST',
  /* A product request (owner 2026-10-06): raised, edited, withdrawn, approved or
     rejected by the Purchaser, its Model + SKU built, its PC Order raised. */
  'PRODUCT_REQUEST',
  /* An Event Commission month (owner 2026-10-26, 关月): closed (POST) and
     reopened (REVERSE), keyed "<company id>:<YYYY-MM>". Write-only so far. */
  'COMMISSION_MONTH',
  /* The books' opening (owner 2026-10-28; Finance › Setup › Opening Balance):
     its accounts and stock re-posted, a paper added, changed or cancelled, the
     opening locked or unlocked. Write-only so far. */
  'OPENING_BALANCE',
  'LORRY_OFF_ROAD',
  'GL_ACCOUNT',
  'CREDIT_NOTE',
  /* Daily Bank's cash book (owner 2026-11-23): a money account's starting
     balance, keyed by the account code (set, changed, removed), and a typed
     receipt, keyed by its row id (typed, edited, deleted). */
  'DAILY_BANK_START',
  'DAILY_BANK_RECEIPT',
  /* An approved voucher ticked off the cash book as already in its bank's starting
     balance, and unticked (owner 2026-11-25: 要，加勾选), keyed by the voucher's id. */
  'DAILY_BANK_SKIP',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(v: unknown): v is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(String(v));
}

/* BIND_SHADOW records an OBSERVATION, not a change: the DO-time live allocator
   (soft-until-DO stage 2, Decision 2026-08-06 — docs/modules/purchase-order.md
   §Decision) runs in SHADOW beside the stored-link resolution in
   resolveShipCommitments (delivery-orders-mfg.ts), and its divergences used to
   go only to the Worker console — wrangler tail, ephemeral, gone when the
   stream closes. The flip (PR-4) is gated on REVIEWED shadow evidence, and
   evidence that evaporates with a log stream is not evidence — the same
   lesson RECOUNT_FAILED encodes one comment up. One row per divergence
   (status_snapshot 'DIVERGENCE') plus one per resolution (status_snapshot
   'SUMMARY' — the denominator a soak verdict needs). Written best-effort from
   the shadow's own try/catch, so persistence can never touch shipping; read
   back by scripts/check-bind-shadow.mjs, never by the History drawer (the
   frontend's AuditEntityType union does not include DELIVERY_ORDER). */
/* The phase-3 approval verbs (payment vouchers, 2026-08-28): SUBMIT_FOR_APPROVAL
   and WITHDRAW_FROM_APPROVAL are the requester's half, APPROVE and REJECT the
   decider's. They answer "who asked for this money, who said yes/no, and when" —
   the question the 决定 trail exists for. A REJECT row carries the why as a
   field change (rejection_note), where the submitter reads it.
   REMIND_APPROVER (2026-11-03) is a note sent to the approver's bell about a
   checked voucher: it changes nothing on the voucher, and the trail is where
   the hour between two reminders is read from. */
export const AUDIT_ACTIONS = ['CREATE', 'UPDATE', 'POST', 'CANCEL', 'REVERSE', 'DELETE', 'SEND', 'AMENDMENT_PO_APPROVED', 'RECOUNT_FAILED', 'BIND_SHADOW', 'SUBMIT_FOR_APPROVAL', 'WITHDRAW_FROM_APPROVAL', 'CHECK', 'APPROVE', 'REJECT', 'REMIND_APPROVER'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

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
  actor?: AuditActor | null;
  companyId?: number | null;
  fieldChanges?: FieldChange[];
  statusSnapshot?: string | null;
  source?: string;
  note?: string;
};

/** What actually happened to the history row. See recordEntityAudit. */
export type AuditWriteResult = {
  recorded: boolean;
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
    let actorId: string | null = null;
    if (args.actor?.id != null) {
      try {
        actorId = await resolveCallerStaffId(sb, args.actor.id);
      } catch {
      }
    }

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
      p_entity_id: args.entityId ?? 'preflight',
      p_action: args.action,
      p_company_id: args.companyId ?? null,
    });
    if (!error) {
      if (data === true) return { ok: true };
      return { ok: false, reason: 'probe_reported_not_writable' };
    }
    if (!isMissingRpc(error)) {
      // eslint-disable-next-line no-console
      console.error('[entity-audit] pre-flight probe failed:', args.entityType, error.message);
      return { ok: false, reason: error.message };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isUnsupportedTransactionRpc(msg)) {
      // eslint-disable-next-line no-console
      console.error('[entity-audit] pre-flight probe threw:', args.entityType, e);
      return { ok: false, reason: msg };
    }
    // eslint-disable-next-line no-console
    console.error('[entity-audit] probe RPC not callable in this transaction client, using reachability fallback:', args.entityType);
  }

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


/**
 * One explicit from->to pair, or null when nothing moved.
 *
 * MONEY IS INTEGER SEN IN THIS CODEBASE and must be recorded as the INTEGER, not
 * a formatted string: "RM 1,234.50" cannot be summed, compared or reconciled,
 * and the moment a locale changes the history becomes unparseable. Formatting is
 * the reader's job. Pass amount_sen straight in.
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
