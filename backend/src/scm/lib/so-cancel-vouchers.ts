/* company-scope-file: the two updates below match on `source_doc_no` /
 * `redeemed_doc_no`, which hold a Sales Order's doc_no. doc_no is
 * mfg_sales_orders' PRIMARY KEY and is prefix-partitioned per company, so only
 * the cancelling company's own vouchers can match.
 *
 * This is NOT true of `.eq('code', ...)` on the same table: mig 0188 re-keyed
 * pwp_codes (company_id, code), and that is exactly what made
 * lib/pwp-claim-single.ts a real cross-company write. Same table, different
 * column, opposite answer — which is why each statement gets read rather than
 * the file getting a blanket exemption.
 */

/* PWP (换购) voucher settlement for a CANCELLED Sales Order.
 *
 * `pwp_codes.source_doc_no` / `.redeemed_doc_no` are plain `text` with NO
 * foreign key to `mfg_sales_orders` (2990s-full-schema.sql:1220-1237 — the only
 * FKs on that table are rule_id / owner_staff_id / customer_id). Every other SO
 * child cascades, which is exactly why this one was missed: there is no
 * relationship for the database to act on. So cancelling an order left the
 * vouchers it issued AVAILABLE and redeemable on a live order, and burned the
 * vouchers the customer had earned elsewhere and spent on it.
 *
 * The rules mirror `backend/scripts/delete-test-so.mjs` (2026-07-28), adapted
 * for a cancel — which VOIDS rather than deletes, because a cancelled order
 * still exists and its history must stay auditable:
 *
 *   issued BY this SO (source_doc_no)
 *     · redeemed on ANOTHER order  -> BLOCK the cancel (see below)
 *     · anything else              -> status VOID (never deleted)
 *   redeemed ON this SO but earned elsewhere (redeemed_doc_no, source elsewhere)
 *     -> the customer's property: back to AVAILABLE, redemption columns cleared
 *
 * WHY BLOCK rather than void-anyway: this is the same "already consumed
 * downstream" shape the TBC trigger swap already rules on
 * (`pwp_trigger_cross_order`, mfg-sales-orders.ts) — a voucher this order
 * minted that someone has since spent on a DIFFERENT order is a reward already
 * given out. Voiding it would claw back a reward from a live order; leaving it
 * live while silently cancelling its origin is how the voucher became
 * untraceable in the first place. Both the TBC swap and the purge script refuse
 * and hand it to a coordinator, so this does too.
 *
 * WHY VOID and not one of the existing statuses: `pwp_codes.status` is plain
 * `text` with DEFAULT 'RESERVED' and NO check constraint or enum, and the three
 * values in use (RESERVED / AVAILABLE / USED) all carry a meaning a cancelled
 * order's voucher does not have. Every redemption gate is an ALLOW-list —
 * `status === 'AVAILABLE' || (status === 'RESERVED' && owned by caller)` in
 * routes/pwp-codes.ts and lib/pwp-claim-single.ts — so an unknown value is
 * refused by construction ("code is not redeemable (VOID)"), which is the
 * fail-safe direction. USED was rejected because it would assert the customer
 * spent a voucher they never spent.
 */

/** Status written to a voucher whose issuing order was cancelled. */
export const PWP_VOID_STATUS = 'VOID';

/** Status a voucher earned elsewhere returns to when the order it was spent on
 *  is cancelled (mirrors delete-test-so.mjs RESTORE_REDEEMED). */
export const PWP_RESTORED_STATUS = 'AVAILABLE';

export type PwpVoucherRow = {
  code: string;
  status: string;
  source_doc_no?: string | null;
  redeemed_doc_no?: string | null;
};

export type SoCancelVoucherBlock = {
  error: 'pwp_voucher_redeemed_elsewhere';
  reason: string;
  codes: string[];
};

export type SoCancelVoucherPlan = {
  /** Vouchers this SO issued — voided by the cancel. */
  toVoid: PwpVoucherRow[];
  /** Vouchers earned elsewhere and spent here — handed back to the customer. */
  toRestore: PwpVoucherRow[];
  /** Non-null = the cancel must be refused with this 409 body. */
  blocked: SoCancelVoucherBlock | null;
};

const upper = (v: unknown): string => String(v ?? '').toUpperCase();

/**
 * Read-only. Works out what the cancel would do to this order's vouchers, so a
 * refusal can be returned BEFORE anything is written.
 */
export async function planSoCancelVouchers(
  sb: any,
  docNo: string,
): Promise<SoCancelVoucherPlan> {
  const { data: issuedRows } = await sb.from('pwp_codes')
    .select('code, status, source_doc_no, redeemed_doc_no')
    .eq('source_doc_no', docNo);
  const { data: redeemedRows } = await sb.from('pwp_codes')
    .select('code, status, source_doc_no, redeemed_doc_no')
    .eq('redeemed_doc_no', docNo);

  const issued = ((issuedRows ?? []) as PwpVoucherRow[]);
  const redeemedHere = ((redeemedRows ?? []) as PwpVoucherRow[]);

  /* A voucher minted AND spent on this same order is wholly internal to it —
     its reward line dies with the cancel, so it is voided, not blocked. Only a
     redemption on a DIFFERENT, still-live order is a reward already given out.
     (Same test as the TBC swap's pwp_trigger_cross_order branch.) */
  const spentElsewhere = issued.filter((r) => upper(r.status) === 'USED'
    && !!r.redeemed_doc_no && r.redeemed_doc_no !== docNo);
  if (spentElsewhere.length > 0) {
    const codes = spentElsewhere.map((r) => r.code);
    return {
      toVoid: [],
      toRestore: [],
      blocked: {
        error: 'pwp_voucher_redeemed_elsewhere',
        reason: `This order issued PWP voucher${codes.length > 1 ? 's' : ''} `
          + `${spentElsewhere.map((r) => `${r.code} (redeemed on ${r.redeemed_doc_no})`).join(', ')}. `
          + 'Cancelling would take back a reward that is already on another order — ask the coordinator to settle it first.',
        codes,
      },
    };
  }

  const issuedCodes = new Set(issued.map((r) => r.code));
  return {
    // Already-void codes are skipped so a re-run is a no-op.
    toVoid: issued.filter((r) => upper(r.status) !== PWP_VOID_STATUS),
    // Earned elsewhere only — a code this SO issued is voided, not restored.
    toRestore: redeemedHere.filter((r) => !issuedCodes.has(r.code)),
    blocked: null,
  };
}

/**
 * Apply the plan. MUST run inside the same transaction as the status flip
 * (`runScmPgCommand`) — a half-applied cancel either burns the customer's
 * vouchers on a live order or leaves a cancelled order's vouchers redeemable.
 *
 * Each update is guarded on the status the plan observed, so a voucher that was
 * legitimately claimed between the read and the write is not clobbered; the
 * verification pass below then catches that as a rollback rather than a silent
 * miss.
 */
export async function applySoCancelVouchers(
  sb: any,
  docNo: string,
  plan: SoCancelVoucherPlan,
): Promise<void> {
  const now = new Date().toISOString();

  // Hand back first: these are the customer's, earned on an order that stays live.
  if (plan.toRestore.length > 0) {
    const byStatus = groupByStatus(plan.toRestore);
    for (const [status, codes] of byStatus) {
      const { error } = await sb.from('pwp_codes')
        .update({
          status: PWP_RESTORED_STATUS,
          redeemed_doc_no: null,
          redeemed_item_code: null,
          updated_at: now,
        })
        .in('code', codes)
        .eq('redeemed_doc_no', docNo)
        .eq('status', status);
      if (error) throw new Error(`PWP voucher restore failed: ${error.message}`);
    }
  }

  /* Voided, never deleted — the cancelled order still exists and the voucher
     row is the only record of what it issued. redeemed_doc_no is deliberately
     left standing on a code that was spent on THIS order: that is provenance,
     and VOID already stops redemption. */
  if (plan.toVoid.length > 0) {
    const byStatus = groupByStatus(plan.toVoid);
    for (const [status, codes] of byStatus) {
      const { error } = await sb.from('pwp_codes')
        .update({ status: PWP_VOID_STATUS, updated_at: now })
        .in('code', codes)
        .eq('source_doc_no', docNo)
        .eq('status', status);
      if (error) throw new Error(`PWP voucher void failed: ${error.message}`);
    }
  }

  /* Prove it landed. Anything still pointing at this doc_no in a live state
     means a concurrent claim won the race — throw, so the transaction rolls the
     whole cancel back instead of committing a half-settled order. */
  const { data: leftover } = await sb.from('pwp_codes')
    .select('code, status')
    .eq('source_doc_no', docNo);
  const stillLive = ((leftover ?? []) as PwpVoucherRow[])
    .filter((r) => upper(r.status) !== PWP_VOID_STATUS);
  if (stillLive.length > 0) {
    throw new Error(
      `PWP voucher settlement incomplete for ${docNo}: `
      + `${stillLive.map((r) => `${r.code}(${r.status})`).join(', ')} still live`,
    );
  }
  const { data: stillSpent } = await sb.from('pwp_codes')
    .select('code, status')
    .eq('redeemed_doc_no', docNo);
  /* A VOID row still pointing here is settled by definition — this order issued
     it and it died with the order; redeemed_doc_no is kept as provenance. */
  const notHandedBack = ((stillSpent ?? []) as PwpVoucherRow[])
    .filter((r) => upper(r.status) !== PWP_VOID_STATUS);
  if (notHandedBack.length > 0) {
    throw new Error(
      `PWP voucher settlement incomplete for ${docNo}: `
      + `${notHandedBack.map((r) => r.code).join(', ')} still redeemed on this order`,
    );
  }
}

function groupByStatus(rows: PwpVoucherRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const arr = out.get(r.status) ?? [];
    arr.push(r.code);
    out.set(r.status, arr);
  }
  return out;
}

/** Audit field-change entries describing what the cancel did to the vouchers. */
export function soCancelVoucherAuditChanges(
  plan: SoCancelVoucherPlan,
): Array<{ field: string; from?: unknown; to?: unknown }> {
  const out: Array<{ field: string; from?: unknown; to?: unknown }> = [];
  if (plan.toVoid.length > 0) {
    out.push({
      field: 'pwpVouchersVoided',
      from: plan.toVoid.map((r) => `${r.code} (${r.status})`).join(', '),
      to: PWP_VOID_STATUS,
    });
  }
  if (plan.toRestore.length > 0) {
    out.push({
      field: 'pwpVouchersReturned',
      from: plan.toRestore.map((r) => r.code).join(', '),
      to: PWP_RESTORED_STATUS,
    });
  }
  return out;
}
