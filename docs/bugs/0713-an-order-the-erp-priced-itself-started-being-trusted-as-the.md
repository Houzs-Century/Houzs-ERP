## An order the ERP priced itself started being trusted as the account book's price [high]

**Symptom.** A salesperson creates a sales order, the ERP prices its lines from
the catalogue with the special-order and fabric surcharges applied, and it
saves. Minutes later the AutoCount write-back pushes it into the book. From that
moment the ERP treats that order's prices as **AutoCount's**, not its own:

* an approved amendment stops re-pricing its lines to the current catalogue —
  including a QTY-ONLY amendment, where re-pricing is the intended behaviour on
  a native order (`so-revision.ts`, `amendTrust`);
* a plain line PATCH stops recomputing the surcharges over the stored price
  (`mfg-sales-orders.ts`, `patchSoIsMigrated`, the guard `docs/bugs/0600` added).

Nobody reported it, and that is the worrying part: the failure is silent, it
only bites on the SECOND edit of an order, and the number that comes out is a
plausible one.

**Root cause (traced).** Both of those trust flags come from the same wrong
predicate as `docs/bugs/0703` — `scm.mfg_sales_orders.linked_ac_docno IS NOT
NULL`:

```
backend/src/scm/lib/so-revision.ts:372
  const soIsMigrated = ((soHdrCo as { linked_ac_docno?: string | null } | null)
                          ?.linked_ac_docno ?? null) !== null;
backend/src/scm/routes/mfg-sales-orders.ts:8219
  const patchSoIsMigrated = await soIsMigrated(
    (d) => sb.from('mfg_sales_orders').select('linked_ac_docno')...
```

and it feeds `erpLineTrust(..., soIsMigrated)` (`mfg-pricing-recompute.ts:296`),
whose whole meaning is *"this price is what AutoCount recorded as negotiated
with the customer, and `mfg_products.sell_price_sen` is in no sense a better
answer for an order this ERP never priced"* (`so-revision.ts`'s own comment). On
a written-back order that sentence is FALSE in every clause: the ERP priced it,
this morning, from that same catalogue.

**This is 0703's bug wearing different clothes, and it is the reason the fix had
to move the shared module rather than the lock.** 0703 is about a LOCK, which is
visible the moment it bites; this is about MONEY, and it is not. Both read one
column that carries two populations — "carried over by the 2026-08 cutover" and
"pushed to AutoCount by us" — and both wanted only the first.

**Fix.** `soIsMigrated` / `soIsMigratedShape` in
`backend/src/scm/lib/so-is-migrated.ts` — the shared home both paths already
reached for — now decide from the two document numbers rather than from the
presence of one. All five sites that asked the question move together:
`so-is-migrated.ts` (the middleware's read), `migrated-so-readonly.ts`
(`withSoMigratedReadonly`, `migratedSoListGate`),
`routes/mfg-sales-orders.ts:8219` and `so-revision.ts:372`. Full reasoning,
options and the production measurement are in
`docs/bugs/0703-a-brand-new-sales-order-becomes-read-only-minutes-after-it-i.md`.

Pinned by `backend/tests/soIsMigratedShape.test.ts`, which names both real
documents. **Proved RED on the unfixed predicate**: with
`soIsMigratedShape` reverted to `linked_ac_docno !== ''`, 7 of its 24 tests
fail, including *"HC-SO-2609-001 — created by staff, written back, is NOT
migrated"*; restored, 24 pass.

**What this does NOT touch.** No historical price is corrected by this. It
changes what the ERP will do on the NEXT edit of an ERP-originated order. Only
one such order exists in production today — `HC-SO-2609-001`, created
2026-09-08 — and it has not been amended, so there is no exposure to repair.
Measured: Actions -> *SO migrated shape (read-only)*, run `34214516108` — 1
write-back order of 2,883.

> **UPDATED 2026-09-08.** That one order, `HC-SO-2609-001`, has since been
> DELETED from the ERP on 2026-09-08 at the owner's instruction — it was a test order. So there is now NO ERP-originated sales
> order in production, and the exposure this paragraph measures is zero by
> construction rather than by inspection. The fix is unaffected: it changes what
> happens on the next such order, and `soIsMigratedShape` is a pure function
> whose test fixtures do not need the row. Ledger:
> `docs/bugs/0715-deleting-a-sales-order-trusted-a-hand-written-child-list-nob.md`.

**Ref.** fix/so-open-for-new, 2026-09-08. Follows `docs/bugs/0703-*` and
`docs/bugs/0600-*`.
