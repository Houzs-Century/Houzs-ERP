## 292 sofa SKUs carry no supplier binding, so MRP shows the buyer no maker [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner, 2026-09-11, on an MRP row: 「822822 怎么会没有 Supplier 呢」.
On one sales order `822-CNR` offers RED SOFA PLT while `822-2A(LHF)` and
`822-1ABOX(RHF)`, the same sofa, read `— none —`. The buyer cannot see who
builds the piece he is being asked to order.

**Root cause (measured, not a code fault).** Nothing in the code drops the
supplier — `scm.supplier_material_bindings` simply has no row for those SKUs.
Read off production (company 1, read-only) 2026-09-11: of **739** sofa SKUs,
**292 carry no binding at all**, and that reaches **149 live sales-order lines
across 79 orders**. The shape is one-sided twins — `822-1A(LHF)` bound,
`822-1A(RHF)` not; `822-2A(RHF)` bound, `822-2A(LHF)` not — i.e. whoever built
the master did one hand of each pair. It is a master-data gap, so there is no
line of code to point at and no test that could have failed.

**Fix.** `backend/scripts/derive-sofa-supplier-bindings.mjs` +
`.github/workflows/derive-sofa-supplier-bindings.yml`. A sofa SKU is
`<model>-<module>` and every module of one model is built by the same maker, so
an unbound module can take the supplier its bound SIBLINGS already name — that
is copying a fact the master holds, not inventing one. Plan by default; apply
behind a confirm phrase; INSERT only, so a binding a person has already set is
untouchable; verified on a FRESH connection against each row's supplier and
price rather than a row count.

The bar refuses more than it writes where the evidence is thin. Measured
2026-09-11: **225 derivable** (the model names exactly one supplier), **34
refused** because the model names two or three suppliers and picking wrong sends
the order to a factory that does not build that piece, **33 refused** because no
sibling of the model is bound at all. The owner's two screenshot SKUs are both in
the 225 and both derive RED SOFA PLT — the same supplier his screenshot shows on
`822-CNR`.

**PRICE IS DELIBERATELY NOT COPIED.** A corner and a one-seater are the same
model and not the same money, so `unit_price_sen` is the one field a copy would
make plausibly wrong rather than obviously wrong, and it feeds
`deriveMfgPoUnitCost` straight into a purchase-order line total. New rows carry
0, which is what these SKUs already produce today with no binding, so it is not
a regression — but the price must be set before any of them is priced onto a PO.
`lead_time_days` and `currency` ARE copied: those belong to the supplier and the
model, not to the module.

**No code test pins this** — it is a data repair and the engine is not changing.
The plan was run against the read-only production DSN and its output is in the
PR body. **APPLY HAS NOT BEEN RUN**: it is a production write and the owner's
call.

**Ref.** `fix/sofa-supplier-bindings`, 2026-09-11.
