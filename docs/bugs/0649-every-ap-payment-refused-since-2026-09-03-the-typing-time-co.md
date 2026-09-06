## Every AP Payment refused since 2026-09-03 — the typing-time control lock also judged the supplier's own AP-control line [high]

<!-- area: Accounting + GL -->

**Symptom.** The owner (2026-09-06, screenshot): a New AP Payment to
HOUZS VENTURE HOLDING (405-H001), Paid From 310-0020, prepay 2,143.74 — the
preview read "Books: Dr 405-0000 … Cr 310-0020", Create answered "Save
failed — 405-0000 is a control account (SCC) — 由模块自动过账 … pick an
ordinary account instead." His question: 不是应该 Dr 405, Cr bank 吗? (Yes.)
Production had no supplier-payment voucher created after 2026-09-02 — two
expense drafts only.

**Root cause (traced).** `createPaymentVoucherHandler` runs
`requireLeafAccount` (`routes/accounting-chart.ts`, the header + control lock,
since #2913 on 2026-09-03) on EVERY debit line. A supplier payment's one
line debits the AP control the page itself chose from the supplier's code —
400-0000 or 405-0000, both `special_type = 'SCC'` in production — so the
lock refused the system's own line, for every supplier, from the day the
lock landed. The same loop sits on the edit path. Every test passed because
`tests/pvApControlGuard.test.ts`'s account fixtures carried no
`special_type`, so the lock never fired in a test.

**Fix.** `supplierOwnControl` resolves the supplier's own control first; the
lock skips exactly that line on create and on edit, the wrong-control door
still refuses the other control, and an expense voucher's lines are judged
as before. With it (owner's ask, same conversation): `pvLines` stamps the
supplier on that Dr leg (Dr 405-0000 · 405-H001 / Cr bank), `apply-advance`
accepts AP invoices, and the list carries `advance_remaining_sen`. Pinned by
`backend/tests/pvApControlGuard.test.ts` — fixtures now carry
`special_type: 'SCC'`, and "each supplier saving onto ITS OWN control" was
RED on the unfixed tree with that one fixture change (control_account_locked),
green after — plus the new cases there and in `tests/pvSupplierAdvance.test.ts`.

**Ref.** fix/pv-ap-control-line, 2026-09-06.
