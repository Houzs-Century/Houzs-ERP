## "FromDocType is null on the PO" was measured on the wrong columns [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The same run refused the typed primitive:

```
so-to-po: typed AddPartialTransferDetail("SO") refused (FromDocType must be RQ.)
```

so `PODTL.FromDocType` is null and the purchase order was reported — here, in the
module guide and in `#2300` — as recording its sales source on one side only.
Owner: 「他的 documentation convert from 的那个有做到没有?」

**What the evidence actually says.** Three findings, and the third contradicts
the symptom rather than explaining it.

1. **PROVEN, host log.** Into a `PurchaseOrder` the general
   `AddPartialTransferDetail(fromDocType, keys, bool)` accepts **`RQ` and nothing
   else** — that message is `PurchaseOrderPartialTransferDetail`'s own validation
   and it enumerates exactly one type. `#2302`'s sales-side fix has no purchase
   equivalent.
2. **`AutoCount.Invoicing.Purchase.TransferFrom` carrying `SalesOrder = 5` does
   NOT contradict that.** The enum is the NAMESPACE's vocabulary, shared by every
   purchase target and taken by `TransferHelper.Create` /
   `LoadWantToFullTransferData`; which subset a target accepts is validated in
   that target's own `*PartialTransferDetail` constructor. The SDK's surface says
   the same structurally — `SO → PO` ships as a PARALLEL mechanism in five
   separate places (`AddSOToPOTransferDetail`, `CheckAndGetValidSOTransferItem`,
   `GetOverTransferTableForSOToPO`, `GetPendingTransferredPOQtyFromSOSQL`,
   `IsSODtlPartialTransferedToPO`), never as a member of the general family, and
   `AO → PO` ships the same way.
3. **A purchase order keeps its sales link in `FromSODtlKey` / `FromSODocList`,
   which nobody had looked at.** Measured in the committed live-book extract
   `backend/scripts/data/ac-fidelity-po-lines.json.gz` (`AED_HOUZS` read-only
   2026-08-11, query at `export-ac-fidelity-truth.py:144`): **10,338 of 18,148**
   non-cancelled `PODTL` rows, over **7,467 of 9,080** purchase orders, carry a
   `FromSODtlKey`, and 10,314 also carry a `FromSODocList` — all written by
   AutoCount's own UI, none by this service. The ERP has depended on it since the
   cutover (`backfill-po-ac-dtlkey.mjs`, `repair-dedication-from-autocount.mjs`:
   "the one line-to-line link AutoCount populates"). It is the OPPOSITE shape
   from the downstream tables, where `FromDocDtlKey` is NULL on every row and
   only the document-level pair is real.

So `FromDocType` is the wrong column to judge a purchase order by, and it is the
only one anyone has measured. **This entry does not claim the link is fine.**

**STILL UNKNOWN, and said so rather than bridged.** Whether
`AddSOToPOTransferDetail` populates those two columns the way AutoCount's UI
does. No credential in this repository reaches the AutoCount host, so the
question is answered where the answer lives instead of being guessed at or handed
to the owner as a query:

- `LogPoSourceLink` reads all six lineage fields off the purchase order the route
  has just saved and writes them to `ac-sync-service.log`.
- `FromSODtlKey` / `FromSODocList` joined `DetailWanted`, so `/doc-read` returns
  them too — the service has been answering "is the convert-from link there" from
  a column list that could not contain the answer.
- `LogPurchaseTransferVocabulary` dumps the `TransferFrom` enum, each member's
  `TransferFromToDocumentType`, and `DocumentTypeToTransferFrom("SO")`, once per
  process, so finding 2 stops being a claim and becomes a log line.

**The next `/so-to-po` on the host settles it.** If the columns come back empty
the link really is missing, and the remedy is NOT a payload change:
`sdk-api-reference.txt:467` shows `PurchaseOrderDetail` exposes no settable
`From*` at all.

**The typed call and the fallback both stay.** The refusal is one throw from a
constructor before anything reaches the document — which is why the 10:15 run
still produced a correct two-line purchase order — and re-making it every time is
what keeps "must be RQ" a measurement rather than a comment. Worst case remains
today's behaviour, which works.

**Ref.** this PR, 2026-08-17. Corrects the `#2300` entry below, which read
`FromDocType` NULL as a one-sided link on the strength of the SALES side's shape.
