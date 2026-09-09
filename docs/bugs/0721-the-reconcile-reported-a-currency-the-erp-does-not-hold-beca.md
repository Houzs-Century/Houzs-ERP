## The reconcile reported a currency the ERP does not hold, because it never read the column [high]

<!-- status: fixed -->

<!-- area: AutoCount sync + write-back -->

**白话.** 那张人民币的采购单 HC-PO-009335，**2026-09-07 就已经改好了** —— 改成
CNY，机器自己印出来「verified HC-PO-009335 currency = 'CNY'」。

可是第二天的对账报告还在说「我们系统写的是 RM」。为什么？因为那份报告**从来没有
去看过我们系统那一栏**。它只看账本，看到账本写 CNY，就直接印一句「我们系统写的是
RM」—— 那句话是写死的，不是查出来的。

结果就是：已经改好的东西，报告还在报错。要是有人照着这份报告再改一次，就是改一个
本来没有问题的单。现在改成真的去读我们那一栏，两边一样就不报了。

**Symptom.** `repair-migrated-currency.mjs` ran in `MODE=apply` on 2026-09-07
16:33 UTC (run `34143840216`) and its own verification step printed:

```
PLAN:
  purchase orders  HC-PO-009335       (book PO-009335)  MYR -> CNY   [SUBMITTED]
  verified HC-PO-009335       currency = 'CNY' (scm.currency_code)
```

Reconcile run `34224368330`, 2026-09-08 12:07 UTC — nineteen hours later — still
said:

```
PO-009335: the document is in CNY at rate 0.61938, and the ERP holds MYR
  — document RM 34334.90, local RM 21266.35, ERP RM 34334.90 tagged 'MYR' (ERP HC-PO-009335)
```

Two artifacts, one document, opposite answers. That is a finding, not something
to reconcile in prose.

**Root cause (traced).** The reconcile never reads the ERP's currency column,
for any document type. `grep -c currency backend/scripts/lib/ac-reconcile-erp-sql.mjs`
returned **0** — the ERP-side `docs()` SELECTs carry `erp_no`, `ac_no` and
`total_sen` and nothing else. `currencyVerdict(header)` in
`backend/scripts/lib/ac-scope.mjs` is handed the BOOK header alone, and returned:

```js
return { kind: 'foreign', why: `the document is in ${code} at rate ${rate}, and the ERP holds ${LOCAL_CURRENCY}` };
```

`LOCAL_CURRENCY` is the constant `'MYR'`. So the clause "and the ERP holds MYR"
was not a comparison — it was a sentence printed about a value nothing had read,
for every foreign document, forever. The caller then did
`VERDICT.record(t, ac, d.erp_no, "currency", cur.why)` unconditionally, locking
the document on that axis.

This is `docs/bugs/0715` wearing the opposite hat. There, a comparison that never
ran was counted as `differ`. Here, a comparison that never ran was counted as a
difference **about the ERP side specifically** — the more expensive direction,
because the sentence names a value and invites somebody to go and change it. A
second currency repair against `HC-PO-009335` would have rewritten a document
that was already correct.

**Fix.** `currency` is now on the ERP-side `docs()` SELECT for SO, PO and GR;
`currencyVerdict` returns the `code` and `rate` it read instead of asserting the
other side; and the caller compares. A foreign document whose ERP currency
AGREES with the book is printed as agreeing and records nothing. A type whose
query does not carry the column still records — "we did not read it" must never
resolve to "it agrees", which is the whole lesson of this entry.

The `non-MYR` SUMMARY column keeps counting it either way: it means "compared in
its own currency", which is true whether the code agrees or not, and folding a
foreign document into `money` is what took RM 13,068.55 off a live order
(`docs/bugs/0665`).

Pinned by `backend/tests/poGrTallyVerdict.test.mjs`. **Proved RED**: restoring
the old return value fails 2 of 37 cases — the one asserting the reason string
says nothing about the ERP, and the one asserting the code is handed back.

**Ref.** `feat/po-gr-tally`, 2026-09-08. Found while extending the tally verdict
to purchase orders (`docs/bugs/0720-the-purchase-orders-read-as-po-0-*`), which
is what made anyone look at the one PO finding closely enough to disbelieve it.
