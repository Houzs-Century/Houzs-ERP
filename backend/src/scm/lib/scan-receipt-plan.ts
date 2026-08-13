// ---------------------------------------------------------------------------
// Scan Order — PURE receipt→payment planner.
//
// The Scan flow OCRs a handwritten order slip plus ZERO OR MORE printed
// card-terminal payment receipts, and books ONE payments-ledger row per
// receipt (deposit + balance, split card terminals; owner: "每个 payment slip =
// one payment"). The DB side (dedup pre-checks, recordSoPaymentRow inserts,
// audit) stays in scan-so.ts; THIS module owns only the pure decision — given
// the parse, WHICH receipts book, for how much, with which method / slip proof
// / deposit flag / payment date — so that "0 / 1 / N receipts" is unit-testable
// without a database.
//
// BACKWARD-COMPATIBLE by construction: when the model emits no per-receipt
// `payments[]` (an older parse, or a single-receipt read), the FIRST receipt
// falls back to the slip's singular payment fields (depositRm / approvalCode /
// method matches) — byte-for-byte the pre-multi behaviour — and any extra
// receipt with no readable amount books nothing (owner: no RM0 phantom rows).
// ---------------------------------------------------------------------------

/** A card/bank/cash method derived for a ledger row (mirrors the ledger's
 *  closed method vocabulary). `guessed` = the slip's method field was not a
 *  recognised value, so we assumed a card terminal (Merchant). */
export type LedgerMethod = {
  method: 'merchant' | 'transfer' | 'cash';
  merchantProvider: string | null;
  installmentMonths: number | null;
  onlineType: string | null;
  guessed: boolean;
};

/** The four SO-Maintenance option VALUES a payment carries (already
 *  catalog-validated upstream). Any may be absent. */
export type PaymentMethodValues = {
  paymentMethodValue: string | null;
  bankValue: string | null;
  onlineTypeValue: string | null;
  installmentPlanValue: string | null;
};

/** One per-receipt payment the vision model read off a single payment-receipt
 *  image. `imageIndex` ties it to the uploaded image (and its R2 key) the model
 *  classified as `payment_receipt`. */
export type ExtractedPayment = PaymentMethodValues & {
  imageIndex: number;
  amountRm: number | null;
  approvalCode: string | null;
  /* THE CARD TERMINAL'S OWN PRINTED TRANSACTION DATE for THIS receipt
     (YYYY-MM-DD) when read; else null → the planner falls back to the slip's
     own written date (ExtractedSlip.slipDate), then today.
     It is NOT the Sales Order's Processing Date (`internal_expected_dd`) and it
     is NOT the slip date. All three were once called "processingDate", which is
     exactly how the wrong one kept getting picked; this one is the money date —
     it becomes the payment ledger row's paid_at (see resolvePaidAt). */
  receiptTxnDate: string | null;
};

/** A ledger row the planner decided to book. Amounts are always > 0 (RM0
 *  receipts are dropped, never booked — owner rule). */
export type PlannedReceiptPayment = {
  imageIndex: number;
  // The R2 key that proves this payment (scan-jobs/{jobId}/{imageIndex} when the
  // enqueue-time put succeeded, else the provenance receipt copy for the first
  // receipt, else null).
  slipKey: string | null;
  amountCenti: number;
  approvalCode: string | null;
  method: LedgerMethod['method'];
  merchantProvider: string | null;
  installmentMonths: number | null;
  onlineType: string | null;
  // The header deposit IS the first receipt — is_deposit stops the paid-rollup
  // adding header deposit_centi on top of this row (double count). Exactly one
  // planned row (the first receipt) carries it, matching the pre-multi flow.
  isDeposit: boolean;
  // Payment date, already clamped to a plausible window (see resolvePaidAt).
  paidAt: string;
  // Carried so the caller can annotate the row's note ("method not read …").
  methodGuessed: boolean;
};

/** 'One Shot'/blank → null; 'N months' → N (the same planToMonths rule the
 *  client and buildDraftSoBodyFromSlip use). */
export function installmentPlanToMonths(planValue: string | null | undefined): number | null {
  const m = /^(\d+)\s*month/i.exec((planValue ?? '').trim());
  return m ? Number(m[1]) : null;
}

/** Map a payment's option VALUES to a ledger method (merchant / transfer /
 *  cash). Shared by the slip-level legacy path and every per-receipt row so the
 *  two can never derive a method differently. */
export function deriveLedgerMethod(v: PaymentMethodValues): LedgerMethod {
  const raw = (v.paymentMethodValue ?? '').trim().toLowerCase();
  if (raw === 'cash') {
    return { method: 'cash', merchantProvider: null, installmentMonths: null, onlineType: null, guessed: false };
  }
  if (raw === 'online') {
    return {
      method: 'transfer',
      merchantProvider: null,
      installmentMonths: null,
      onlineType: v.onlineTypeValue ?? null,
      guessed: false,
    };
  }
  // 'Merchant', legacy 'Installment', or nothing readable (guessed = assume a
  // card terminal so a real payment is never dropped for an unread method).
  return {
    method: 'merchant',
    merchantProvider: v.bankValue ?? null,
    installmentMonths: installmentPlanToMonths(v.installmentPlanValue),
    onlineType: null,
    guessed: raw !== 'merchant' && raw !== 'installment',
  };
}

/** Payment date = a plausible receipt-transaction / slip date, else today (MYT
 *  string). Never the Sales Order's Processing Date — that date has nothing to
 *  do with when money changed hands.
 *  SANITY CLAMP (evidence 2026-07: the OCR invented years — "2015-09-17" for a
 *  current slip — which would book money YEARS in the past): only trust a date
 *  within [today-60d, today+7d]; anything outside books at today instead. */
export function resolvePaidAt(dateStr: string | null | undefined, nowMs: number, todayStr: string): string {
  const d = (dateStr ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return todayStr;
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(t)) return todayStr;
  const dayMs = 86_400_000;
  if (t < nowMs - 60 * dayMs || t > nowMs + 7 * dayMs) return todayStr;
  return d;
}

export type PlanReceiptPaymentsInput = {
  jobId: string;
  // Uploaded-image indices the model classified as payment_receipt, in image
  // order, deduped, filtered to indices that were actually uploaded.
  receiptIndices: number[];
  // scan-jobs/{jobId}/{n} keys whose enqueue-time R2 put succeeded.
  storedImageKeys: string[];
  // Provenance receipt copy (scan-slips/{sampleId}-receipt) — the fallback slip
  // proof for the FIRST receipt when its enqueue-time put failed.
  receiptImageKey: string | null;
  // Per-receipt OCR, keyed by imageIndex. Empty → legacy single-field fallback.
  payments: ExtractedPayment[];
  // Slip-level singular fields — the FALLBACK for the first receipt when
  // payments[] is empty (the pre-multi contract).
  legacy: PaymentMethodValues & { depositRm: number | null; approvalCode: string | null };
  /* Fallback payment date — the SLIP'S OWN WRITTEN DATE (ExtractedSlip.slipDate),
     used only when a receipt printed no transaction date of its own. NOT the
     Sales Order's Processing Date. Plus the clock, for the clamp. */
  slipDate: string | null;
  nowMs: number;
  todayStr: string;
};

/** Decide the ledger rows to book, one per payment receipt that carries a real
 *  (> 0) amount. Pure — no DB, no clock reads (the caller injects nowMs). The
 *  caller still applies cross-SO dedup and inserts each row via
 *  recordSoPaymentRow. */
export function planReceiptPayments(input: PlanReceiptPaymentsInput): PlannedReceiptPayment[] {
  const { jobId, receiptIndices, storedImageKeys, receiptImageKey, payments } = input;
  if (receiptIndices.length === 0) return [];

  const byIndex = new Map<number, ExtractedPayment>();
  for (const p of payments) {
    if (!byIndex.has(p.imageIndex)) byIndex.set(p.imageIndex, p);
  }
  const hasPerReceipt = payments.length > 0;

  const rows: PlannedReceiptPayment[] = [];
  for (let i = 0; i < receiptIndices.length; i += 1) {
    const imageIndex = receiptIndices[i];
    const first = i === 0;
    const entry = byIndex.get(imageIndex) ?? null;

    // Amount: the receipt's own OCR'd amount when present; else (legacy, no
    // payments[]) the slip's single deposit — but ONLY for the first receipt.
    // Extra receipts with no per-receipt amount carry nothing.
    const amountRm = entry
      ? entry.amountRm
      : (!hasPerReceipt && first ? input.legacy.depositRm : null);
    const amountCenti = typeof amountRm === 'number' && amountRm > 0 ? Math.round(amountRm * 100) : 0;
    // Owner: never book RM0.00 phantom rows — a receipt with no readable amount
    // books NOTHING (the operator adds it by hand; its slip is still on R2).
    if (amountCenti <= 0) continue;

    // Method / bank / plan / online come from the receipt's own matches, else
    // (first receipt, legacy) the slip singular fields.
    const methodValues: PaymentMethodValues = entry
      ? {
          paymentMethodValue: entry.paymentMethodValue,
          bankValue: entry.bankValue,
          onlineTypeValue: entry.onlineTypeValue,
          installmentPlanValue: entry.installmentPlanValue,
        }
      : (first
          ? {
              paymentMethodValue: input.legacy.paymentMethodValue,
              bankValue: input.legacy.bankValue,
              onlineTypeValue: input.legacy.onlineTypeValue,
              installmentPlanValue: input.legacy.installmentPlanValue,
            }
          : { paymentMethodValue: null, bankValue: null, onlineTypeValue: null, installmentPlanValue: null });
    const m = deriveLedgerMethod(methodValues);

    const approvalCode = (entry ? entry.approvalCode : (first ? input.legacy.approvalCode : null));
    const jobKey = `scan-jobs/${jobId}/${imageIndex}`;
    // Prefer the durable enqueue-time copy; fall back to the provenance receipt
    // copy for the first receipt only (the singular receipt_image_key).
    const slipKey = storedImageKeys.includes(jobKey) ? jobKey : (first ? receiptImageKey : null);
    // THIS receipt's own printed transaction date wins; the slip's written date
    // is the fallback; resolvePaidAt clamps both and lands on today otherwise.
    const paidAt = resolvePaidAt(entry?.receiptTxnDate ?? input.slipDate, input.nowMs, input.todayStr);

    rows.push({
      imageIndex,
      slipKey,
      amountCenti,
      approvalCode: (approvalCode ?? '').trim() || null,
      method: m.method,
      merchantProvider: m.merchantProvider,
      installmentMonths: m.installmentMonths,
      onlineType: m.onlineType,
      isDeposit: first,
      paidAt,
      methodGuessed: m.guessed,
    });
  }
  return rows;
}
