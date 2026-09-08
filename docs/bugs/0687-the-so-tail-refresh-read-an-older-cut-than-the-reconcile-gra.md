## The SO tail refresh read an older cut than the reconcile grades against, and keyed line dates on an item code a sofa never spells [high]

**Symptom.** The 2026-09-08 02:00 UTC reconcile (run `34178538830`) read, on the
PROCEEDED company-1 sales orders — the ones the factory builds from:

| field | agree | differ | ERP blank |
| --- | --- | --- | --- |
| `line delivery date` | 2082 | **614** | **142** |
| `delivery date (header)` | 442 | **132** | 0 |

`line delivery date` is a COPY field: the writer copies the book's value, so a
difference is a defect by definition. It is also the date the customer is
waiting for, and the header one is what the stock allocator ranks on
(`so-stock-allocation.effective-date.test.ts`) — so a wrong date does not just
print wrong, it decides who gets scarce stock first.

**Root cause (traced).** Two independent faults in
`backend/scripts/refresh-so-tail-from-book.mjs`, which is the ONLY writer of
these fields after import — so a gap here is invisible everywhere else until the
reconcile counts it.

*1. It reads an older cut than the reconcile grades against.* The tool loaded
`data/ac-so-dates.json.gz`; the reconcile's field-identity section reads
`data/ac-outstanding-so.json.gz`. Both are cuts of the same 14,041 book lines,
but they are cut at different times — `ac-so-dates` last moved 2026-09-07 17:48,
`ac-outstanding-so` 2026-09-08 08:59. Measured on the committed files:

```
PDate vs UDF_PDate same/diff: 14041 0        # the processing date is identical
DeliveryDate, positionally aligned: 13966 same, 75 CHANGED
```

So refreshing from it writes yesterday's answer for 75 lines and reports success.

*2. It keyed line dates on DocNo + ERP item code.* `ac-so-dates.json.gz` carries
no `DtlKey`, so the only key available was the item code translated through
`autocount-erp-mapping-1561.csv`. That key cannot reach a sofa: the ERP
decomposes one book sofa line into one row per compartment, spelled
`8030-1A(LHF)`, and no mapping row produces that string — so those rows matched
nothing, were never written, and stayed blank permanently. It is lossy in the
ordinary case too: two lines of the same product with different dates collapse
to one (2 such lines in today's book).

*And it had not been run since 2026-08-29.* That is what makes the number 614
rather than 75. Diffing the book cut committed at the last run
(`328176626:backend/scripts/data/ac-so-dates.json.gz`) against today's:

```
book lines with a date, 0829 vs today: same 1606, CHANGED 644, new-only 659
```

and the ERP's values are the 0829 ones, line for line — the reconcile's own
samples land exactly on it:

| line | book today | ERP holds | the 2026-08-29 cut said |
| --- | --- | --- | --- |
| `SO-000517` SOFT PILLOW | 2026-08-27 | 2026-08-28 | **2026-08-28** |
| `SO-001404` HOK-2008(A) (K) | 2026-09-20 | 2026-09-02 | **2026-09-02** |
| `SO-002324` DL-TENCEL DREAM (K) | 2026-10-02 | 2026-09-02 | **2026-09-02** |

The ERP is not wrong about a date it invented. It is holding, faithfully, the
answer the book gave ten days ago.

*3. And the PLAN it printed would have ERASED 93 documents.* Found by reading
the plan rather than the code, which is the only place it was visible. The
snapshots carry the IN-SCOPE population — 2,789 orders — while the query is
`WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`, which also returns the
93 company-1 orders that mirror an AutoCount document the scope rule excludes
(the reconcile calls them `present though out of scope`). For those the
snapshot has no row, `rem.get(...) || {}` returned `{}`, and every field
computed to `null`. Run `34179438387`, PLAN, verbatim:

```
headers with differences: 226 — processing_date 93, customer_delivery_date 206,
  sales_exemption_expiry 93, remark2 94, remark3 7, remark4 92, note 17
   HC-SO-011235: processing_date -> null | customer_delivery_date -> null |
     sales_exemption_expiry -> null | remark2 -> null | remark4 -> null
```

93 processing dates, 93 exemption dates, ~93 remarks — the count IS the
out-of-scope population. A missing snapshot row and a cleared book value are
indistinguishable once both are `null`, so this read as ordinary work. It is
pre-existing: the same code shipped the 2026-08-29 run.

**Fix.**

1. The date source is `ac-outstanding-so.json.gz` — the fresher cut, and the one
   the reconcile grades against. `PDate` is read as `UDF_PDate`, proven equal on
   all 14,041 rows before the swap, so the processing date cannot regress.
2. Line dates key on AutoCount's own `DtlKey`, which is unique across all 14,041
   book lines (measured: 14041 rows, 14041 distinct). `linked_ac_dtlkey` is on
   the ERP line since migration `0273`. The old DocNo+item-code key is kept ONLY
   for ERP rows carrying no key, and is now documented as the lossy fallback it
   is rather than the rule.
3. A document this cut does not carry is SKIPPED, not blanked, and the count is
   printed beside the refusals.
4. 空白不覆盖 is enforced on the header fields too: where the book states nothing
   and the ERP holds a value, the ERP's value stands. It already held on the
   line side (`want === null` skips); the header path wrote the `null` through.
5. PLAN mode prints the cause split — ERP blank vs ERP holds another date,
   matched on DtlKey vs on item code — because "614 differ" and "142 blank" are
   two defects with two different stories and one total hides which a re-run
   actually closes.

Unchanged on purpose: the refusal guard — any document whose audit trail shows a
person touched a synced field is skipped.

**Lesson.** The unsafe half of this was invisible in the source and obvious in
the plan. A tool whose PLAN mode prints only totals would have been run.

**Ref.** fix/so-po-align-0908, 2026-09-08.
