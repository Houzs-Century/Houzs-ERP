## SO-to-PO succeeded, and the purchase order took AutoCount's number [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `/so-to-po` worked for the first time on 2026-08-17. Host log,
verbatim:

```
10:15:13 /so-to-po   HC-SO-2608-001
10:15:13 so-to-po: typed AddPartialTransferDetail("SO") refused (FromDocType must be RQ.)
         - falling back to AddSOToPOTransferDetail, which leaves FromDocType null
10:15:14   so-to-po PO-009968: 2 transferred, 2 line(s) costed in phase two
```

The purchase order is in `AED_HOUZS` as **`PO-009968`**. The ERP calls it
`HC-PO-2608-001`. Owner: 「那 Numbering 你要处理掉啊，怎么可以不一样 Numbering
呢？」

**Root cause (traced, not guessed).** `composeSoToPo` returned
`{ DtlKeys, Details }` and no `DocNo`. `composeCreatePo` has always sent one and
`enqueueConvert` closed divergence **D5** for the four conversions, so the
transfer arm of `enqueuePoCreate` was the only path in the system still letting
AutoCount number a document — the same throw-away that lost `CreditorCode` two
entries down. It was left open deliberately ("one variable at a time on a route
that has never succeeded"); that reason expired at 10:15.

**Fix — three places, because the first alone fixes nothing already queued.**

| | |
|---|---|
| `composeSoToPo` | takes `docNo` as its FIRST, REQUIRED argument and returns `DocNo`. Required rather than optional on the standing rule: an optional one means every caller that says nothing silently keeps AutoCount's counter, with no compile error |
| `dispatchOne` | backfills `body.DocNo` from `row.doc_no` for rows composed before today. The drain REPLAYS and never recomposes. Cheaper than the creditor backfill beside it — the outbox row is already KEYED by the ERP number, so there is no join |
| `AcSyncService.SoToPo` | the same `RequireDocNo` the two create routes carry, and `po.DocNo` assigned DIRECTLY rather than through `PurchaseHeader`'s `Set()`, which logs and swallows. It also re-reads the saved `DocNo` and logs a disagreement |

Deploy the backend FIRST — also the automatic order, since `main` deploys the
Worker and the host binary is a manual `deploy-on-host.ps1`. `RequireDocNo`
refuses a payload without a number and the backfill that guarantees one is
backend-side.

**`PO-009968` is not repaired by this and must not be read as if it were.**
Nothing here renames a document already in a live account book; the SDK offers no
rename and `DocNo` is the document's identity. The owner chooses between
cancelling it and letting the ERP re-raise `HC-PO-2608-001` (clear
`linked_ac_docno` first or `enqueuePoCreate` skips the row), or leaving one
purchase order reconciled through `linked_ac_docno`. Written up in guide §7c3b.

**Test.** Five in `autocount-writeback.contract.test.ts`, and each half was
verified to FAIL when reverted: dropping `DocNo` from `composeSoToPo` gives
`expected undefined to be 'PO-2608-004'` on the enqueue test, dropping the drain
line gives the same on the backfill test, and removing the C# guard fails layer 1
plus the refusal test. D5 leaves the divergence register; the count assertion
moves 12 → 11 and `not.toContain('D5')` keeps the id from being reused.

**Ref.** this PR, 2026-08-17. Follows #2340, #2341 and the `/so-to-po` creditor
fix.
