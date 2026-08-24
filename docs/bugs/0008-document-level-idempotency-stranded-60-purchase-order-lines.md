## Document-level idempotency stranded 60 purchase-order lines, and the completeness check reported zero [high]

**Symptom** — `check-cutover-completeness.mjs` reported `PO 407 = 407 MISSING 0`
while 35 AutoCount purchase-order LINES had no ERP row at all — 60 rows once the
sofa lines are decomposed, on 31 purchase orders. 25 of those documents are the
MIXED ones (a sofa line riding alongside a non-sofa line); 6 more are
bedframe-only shortfalls on documents the SO-linked import created. The
documents were all present. The lines were not.

**Root cause (traced, not guessed)** — both PO importers are idempotent at
DOCUMENT level. `import-ac-outstanding-po.mjs:205-208`:

```js
const nums = built.map((o) => o.poNo);
const existing = new Set();          // SELECT po_number ... WHERE po_number = ANY(...)
const todo = built.filter((o) => !existing.has(o.poNo));
```

Two APPLY runs without `SOFA=1` created 123 documents (98 pure non-sofa + 25
mixed). The `SOFA=1` run then saw those 123 documents already present and skipped
them WHOLE: its own log reads `POs to import: 160; already imported: 123; to
insert: 37` / `inserted POs=37 items=76`. The sofa lines riding the 25 mixed
documents were never written, and re-running can never repair it — the next run
says `already imported: 160; to insert: 0`. `import-ac-so-linked-pos.mjs:132`
has the identical shape, which is where the 6 bedframe documents come from.

The check could not see any of it because it compared document-number SETS
(`:51-58`) and nothing else. A document-level guard and a document-level check
share one blind spot, so they agreed with each other and both were wrong.

**Fix** — `backend/scripts/topup-ac-po-lines.mjs` + workflow
`topup-ac-po-lines.yml` diff the AutoCount exports against
`scm.purchase_order_items` line by line and insert only what is missing (DRY-RUN
by default). It never creates a document, never changes a status, never posts an
inventory movement, and it reuses `lib/parse-sofa.mjs` rather than growing a
second decoder. `check-cutover-completeness.mjs` gains section 1b, which counts
lines per document and names the shortfall — built on the SAME
`lib/po-line-topup-core.mjs` the repair writes from, so the check and the repair
cannot drift apart.

**Two things the first prod DRY-RUN corrected, which is why it is DRY-RUN
first** — the strongest handle, `linked_ac_dtlkey`, arrived in migration 0273
(#1819) while this was being written and is not yet applied to production; it is
nullable by design and `backfill-ac-line-keys` matches on (DocNo + ERP code),
which cannot reach a sofa compartment whose code is `${model}-{piece}`. So it is
used where it exists, set on every row this repair writes, and never relied on
alone. Below it, lines are matched on `supplier_sku`. But 225 of the 862 migrated
PO lines carry NO `supplier_sku` at all, written by neither importer —
`apply-sofa-compartment-corrections.mjs:212-217` is one such writer, inserting a
corrected compartment by SELECTing from the source row without carrying the
column. Zero of those 225 duplicate a with-sku row's code on the same PO, so they
are real AutoCount lines, unlabelled: matching on `supplier_sku` alone called 183
of them missing, and applying that would have written 183 duplicates into
production. They are now claimed by `material_code` (sofa: by model prefix), and
the repair is ALL-OR-NOTHING per ItemCode — zero rows present is repaired, some
rows present is reported and left alone, because a half-written sofa build is
just as likely a build somebody corrected by hand.

The same DRY-RUN discipline caught the check's own first draft lying: counting
every AutoCount SO line called 243 lines missing on 65 orders, when production
deliberately holds only the OUTSTANDING lines of an order (SO-000013: 8 AutoCount
lines, 7 fully transferred, exactly the 1 untransfered line in the ERP). Against
the right denominator the SO side is short by 1 line, on SO-011384.

**The class, for next time** — **an idempotency key coarser than the thing it
protects will silently skip work, and a check written at the same altitude will
agree with it.** Two APPLY runs of one importer with different flags is not two
runs of the same import: the second one's unit of work was the LINE, and the
guard only knew about the DOCUMENT. Where a document is written in stages — a
flag, a later round, a re-export — the completeness check has to count what the
stages write, not what they are grouped into.

**Ref** — 2026-08-10, PR `fix/po-line-level-topup`.
