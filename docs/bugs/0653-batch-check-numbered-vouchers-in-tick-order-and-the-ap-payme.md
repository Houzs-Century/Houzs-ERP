## Batch Check numbered vouchers in tick order, and the AP Payment picker kept offering invoices already applied by unapproved vouchers [medium]

<!-- area: Accounting + GL -->

**Symptom.** Owner, 2026-09-07, two screenshots. First: 我批量 post to
prepared，然后 to checked 时，他的 numbering 不太对，28/04/2026 air selangor
反而成为 HPV-2604-001 — six April vouchers batch-checked, and the two dated
28/04 took 2990-HPV-2604-001/002 while the four dated 21/04 took 003–006.
Second: a New AP Payment for HOUZS VENTURE HOLDING still offered
2990-API-2603-001 at its full RM 2,143.74 although 2990-HPV-2604-006 (checked,
not yet approved) already applied all of it — 我记得我已经 HPV-2604-006 对冲
2990-API-2603-001.

**Root cause (traced).** (1) `PaymentVouchers.tsx` built the batch from
`[...selected]` — a Set in tick order; the header tick-all follows the list,
which was sorted newest first, so Draft-006 (28/04) was checked first and
`mintFormalPvNo` gave it 001. The audit ledger shows the six CHECK rows at
03:46:55–56 in exactly that order. (2) The picker's outstanding was
`total_sen − paid_sen`, and `paid_sen` moves only at Approve
(`settleApInvoicePaidSen` in the post path); `pv_allocations` carried the
reservation from the moment HPV-2604-006 was saved, but nothing read it. The
create and edit doors checked Σ allocations ≤ voucher total and company/hold,
never the headroom left after other unposted vouchers.

**Fix.** The batch sorts its targets by voucher date, then Draft order, before
stamping (`PaymentVouchers.test.tsx`: ticked newest-first, the older voucher is
checked first). `pendingReservations` sums what unposted vouchers applied per
invoice (posted vouchers and advance applications excluded, the edited voucher
excluded by id), served by `GET /payment-vouchers/reservations/list`; the New
and Edit pickers subtract it and drop what is left at zero
(`PaymentVoucherNew.test.tsx`); `allocationHeadroomBreach` refuses
`over_allocation` at create and edit, naming the holder —
`tests/pvReservations.test.ts` was RED on the unfixed door (a second voucher
applying API-2603-001 in full saved with 201) and green after. The six April
vouchers are put back in date order by `repair-renumber-pv-series.yml`
(unposted only; text mirrors renamed with them).

**Ref.** feat/pv-batch-order-reservations, 2026-09-07.
