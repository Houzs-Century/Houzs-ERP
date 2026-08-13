// ----------------------------------------------------------------------------
// so-create-payment-slips — the `payments[]` rows a Sales-Order CREATE may
// carry, and how each row's slip (when it has one) resolves to an R2 key.
//
// ── THE SLIP IS OPTIONAL (Owner 2026-08-13) ─────────────────────────────────
// Verbatim: "其实 SalesOrder 所有的付款都不强制 ... 如果我们用 OCR scan 的话,
// 它就可以直接进。那如果是 manually 填写的话,基本上不需要强求." A payment slip
// is proof, not a precondition: an operator keying a payment by hand may not
// have one, and refusing the row does not produce the slip — it produces an
// order that reads unpaid.
//
// This is the LAST of the SO slip requirements to go. The SAVED-mode route
// (POST /:docNo/payments) dropped it on 2026-07-13; the create path kept it as
// "spec D4 — one slip per payment" until now.
//
// ── WHAT IS STILL REFUSED, AND WHY THAT IS NOT THE SAME RULE ────────────────
// A row that SENDS an `uploadSessionId` must resolve it. An id that names no
// session, or one whose upload never completed, is a client bug or a replay —
// booking such a row would record a payment whose proof silently points
// nowhere, which is strictly worse than an honest slip-less row. Two sessions
// on one create is the same class: it means two payments would claim one photo.
//
// So the rule is not "a slip is required", it is "a slip that is CLAIMED must
// be real". Absent is fine; wrong is not.
//
// Pure by construction — the caller does the `pending_slip_uploads` read and
// owns the HTTP shaping, exactly like so-location-gate.ts.
// ----------------------------------------------------------------------------
import { z } from 'zod';

/**
 * One row of the optional `payments[]` on an SO create (the POS split-payment
 * shape, Loo 2026-06-06). Validated STRICTLY — unlike the tolerant
 * single-deposit fallback, a money row must never be silently dropped.
 */
export const soCreatePaymentSchema = z.object({
  method:            z.enum(['merchant', 'transfer', 'cash', 'installment']),
  amountCenti:       z.number().int().positive(),
  approvalCode:      z.string().optional().nullable(),
  merchantProvider:  z.string().trim().min(1).optional().nullable(),
  installmentMonths: z.number().int().min(0).max(60).optional().nullable(),
  /* OPTIONAL / NULLABLE, not absent: a supplied id is still resolved and still
     attached exactly as before (see planCreatePaymentSlips). `.min(1)` keeps
     an EMPTY STRING out — '' is a client forgetting to omit the field, and
     letting it through would turn a lookup miss into a refusal of a payment
     the operator never claimed a slip for. */
  uploadSessionId:   z.string().min(1).optional().nullable(),
});

export const soCreatePaymentsSchema = z.array(soCreatePaymentSchema).min(1).max(10);

export type SoCreatePayment = z.infer<typeof soCreatePaymentSchema>;

/** A committed-upload row as `pending_slip_uploads` returns it. */
export type PendingSlipRow = { r2_key: string | null; status: string };

export type CreatePaymentSlipPlan =
  /** `slipKeys[i]` is row i's R2 key, or null when that row carries no slip. */
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
 * a create is never left half-proven. A row with no session resolves to null
 * (recorded slip-less) rather than failing.
 */
export function planCreatePaymentSlips(
  rows: ReadonlyArray<Pick<SoCreatePayment, 'uploadSessionId'>>,
  found: ReadonlyMap<string, PendingSlipRow>,
): CreatePaymentSlipPlan {
  const claimed = rows.map((r) => r.uploadSessionId ?? '').filter((id) => id !== '');
  if (new Set(claimed).size !== claimed.length) {
    return { ok: false, reason: 'Each payment needs its own slip.' };
  }

  const slipKeys: Array<string | null> = [];
  for (let i = 0; i < rows.length; i++) {
    const sessionId = rows[i]?.uploadSessionId ?? '';
    if (sessionId === '') { slipKeys.push(null); continue; }
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
