// ----------------------------------------------------------------------------
// so-create-payment-slips — the `payments[]` rows a Sales-Order CREATE may
// carry, and how each row's slip resolves to an R2 key.
//
// ── THE SLIP IS REQUIRED (Owner 2026-10-13, after Admin) ────────────────────
// "please make sure when collect payment is attached with slip." Every keyed
// row carries an upload session, or the whole create is refused — the rule is
// shared/payment-slip-required, read here and by the payments POST, the
// backdate request and the write core. This reverses the 2026-08-13 ruling
// (slip optional): 490 of 856 payments in the month before carried no proof,
// and Admin could verify none of them with Finance.
//
// A CONVERTED row (money moved from a cancelled order) is exempt: it was
// receipted when first collected and names the order it comes from instead.
//
// ── A SLIP THAT IS CLAIMED MUST ALSO BE REAL ────────────────────────────────
// An id that names no session, or one whose upload never completed, is a
// client bug or a replay — booking such a row would record a payment whose
// proof silently points nowhere. Two sessions on one create is the same class:
// two payments would claim one photo.
//
// Pure by construction — the caller does the `pending_slip_uploads` read and
// owns the HTTP shaping, exactly like so-location-gate.ts.
// ----------------------------------------------------------------------------
import { z } from 'zod';
import { PAYMENT_METHOD_CODES } from '../shared/payment-methods';
import { checkPaymentSlip } from '../shared/payment-slip-required';

/**
 * One row of the optional `payments[]` on an SO create (the POS split-payment
 * shape, Loo 2026-06-06). Validated STRICTLY — unlike the tolerant
 * single-deposit fallback, a money row must never be silently dropped.
 */
export const soCreatePaymentSchema = z.object({
  /* READ the shared list, never re-type it — payment-methods.ts states that
     rule, and this file was extracted from the router just as main introduced
     it, so the two arrived together and only look independent. */
  /* Plus `converted` — money moved from a cancelled order (docs/bugs/0927),
     a Sales-Order-only method that names the order it comes from. */
  method:            z.enum([...PAYMENT_METHOD_CODES, 'converted']),
  convertedFromDocNo: z.string().trim().min(1).optional().nullable(),
  amountSen:       z.number().int().positive(),
  approvalCode:      z.string().optional().nullable(),
  merchantProvider:  z.string().trim().min(1).optional().nullable(),
  installmentMonths: z.number().int().min(0).max(60).optional().nullable(),
  /* Nullable in the SCHEMA only so a converted row can send none; a keyed row
     without one is refused by planCreatePaymentSlips with the shared sentence,
     not by a zod issue nobody reads. `.min(1)` keeps an EMPTY STRING out — ''
     is a client forgetting to omit the field. */
  uploadSessionId:   z.string().min(1).optional().nullable(),
});

export const soCreatePaymentsSchema = z.array(soCreatePaymentSchema).min(1).max(10);

export type SoCreatePayment = z.infer<typeof soCreatePaymentSchema>;

/** A committed-upload row as `pending_slip_uploads` returns it. */
export type PendingSlipRow = { r2_key: string | null; status: string };

export type CreatePaymentSlipPlan =
  /** `slipKeys[i]` is row i's R2 key, or null for a converted row (the only kind allowed none). */
  | { ok: true; slipKeys: Array<string | null> }
  | { ok: false; reason: string };

/**
 * The distinct upload sessions a create actually claims — what the caller
 * should look up. Empty when every row is slip-less, so a slip-less create
 * costs no query at all.
 */
export function claimedSlipSessionIds(
  rows: ReadonlyArray<Pick<SoCreatePayment, 'uploadSessionId'>>,
): string[] {
  const ids = rows.map((r) => r.uploadSessionId ?? '').filter((id) => id !== '');
  return [...new Set(ids)];
}

/**
 * Pair every payment row with its slip key, or refuse the whole create.
 *
 * ALL-OR-NOTHING on purpose: the caller runs this BEFORE the header insert, so
 * a create is never left half-proven. A keyed row with no session is refused
 * (shared/payment-slip-required); only a converted row resolves to null.
 */
export function planCreatePaymentSlips(
  rows: ReadonlyArray<Pick<SoCreatePayment, 'method' | 'uploadSessionId'>>,
  found: ReadonlyMap<string, PendingSlipRow>,
): CreatePaymentSlipPlan {
  const claimed = rows.map((r) => r.uploadSessionId ?? '').filter((id) => id !== '');
  if (new Set(claimed).size !== claimed.length) {
    return { ok: false, reason: 'Each payment needs its own slip.' };
  }

  const slipKeys: Array<string | null> = [];
  for (let i = 0; i < rows.length; i++) {
    const row0 = rows[i]!;
    const sessionId = row0.uploadSessionId ?? '';
    if (sessionId === '') {
      const verdict = checkPaymentSlip({ converted: row0.method === 'converted', hasSlip: false });
      if (!verdict.ok) return { ok: false, reason: `Payment ${i + 1}: ${verdict.reason}` };
      slipKeys.push(null);
      continue;
    }
    const row = found.get(sessionId);
    /* 'uploaded' only — a 'promoted' session already belongs to an earlier
       payment, so accepting it here is the replay this guard exists for. */
    if (!row || row.status !== 'uploaded' || !row.r2_key) {
      return { ok: false, reason: `Payment ${i + 1} slip missing or not uploaded.` };
    }
    slipKeys.push(row.r2_key);
  }
  return { ok: true, slipKeys };
}
