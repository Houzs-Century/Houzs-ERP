## Two delivery orders the book links and the ERP cannot — the shop delivered a SUBSTITUTE item, so there is no sales-order line to point at [medium]

<!-- area: Cutover + migrated data -->
<!-- status: owner-decision -->

**Symptom.** `check-ac-convert-symmetry` run `34198847720` (2026-09-08 15:20
Malaysia), section 5, DO <- SO:

```
FORWARD  book -> ERP : 171 of 173 held by the ERP | 2 MISSING
  missing: DO-001800 <- SO-002281
  missing: DO-005583 <- SO-007435
```

These are **the only two forward gaps on any of the five non-SO->PO edges**;
IV <- DO, GR <- PO and PI <- GR all read N of N, and every edge reads 0 in the
BACKWARD direction. They are also the reason two sales-order lines still read as
undeliverable-again: *"the sales order still reads as undelivered, so it can be
delivered again"* (`probe-convert-link-gaps` run `34200144669`).

**Root cause (traced, not guessed).** Read straight out of the committed book
snapshot `backend/scripts/data/ac-convert-edges.json.gz`
(exported 2026-09-07T08:39:50Z), no inference:

```
LINE DO DO-001800 key=223063 item=HB109NL              qty=3 tq=3 from=SO/SO-002281
LINE DO DO-001800 key=223065 item=HB109M-CC            qty=3 tq=3 from=SO/SO-002281
LINE SO SO-002281 key=150024 item=AK- LTX CLS PIL      qty=3 tq=3
LINE SO SO-002281 key=150025 item=NTYR-CS LTX PIL + CSC qty=3 tq=3
LINE SO SO-002281 key=150023 item=AK-ARMOUR MATT (Q)   qty=1 tq=0
LINE SO SO-002281 key=150026 item=AK-SK + MICROFIL PIL qty=1 tq=0

LINE DO DO-005583 key=506367 item=AK-SK FX AIRLOFT PIL qty=2 tq=2 from=SO/SO-007435
LINE SO SO-007435 key=506114 item=AK-SK + MICROFIL PIL qty=2 tq=2
   (the other 8 lines of SO-007435 all carry tq=0)
```

**The book links these documents and the quantities balance EXACTLY. Only the
item codes differ.** The book stamps the edge at DOCUMENT grain
(`DODTL.FromDocType='SO'` + `FromDocNo`) and `FromDocDtlKey` is NULL on all
220,723 lines of all six detail tables, so AutoCount never records WHICH source
line a delivery line drew from. The ERP's link is `delivery_order_items.so_item_id`
— LINE grain. There is no sales-order line carrying `HB109NL`, `HB109M-CC` or
`AK-SK FX AIRLOFT PIL` to point at, so the importer correctly wrote nothing
rather than guessing. `probe-convert-link-gaps` run `34200144669` confirms the
ERP side: `HC-DO-001800`, 2 of 2 lines carry no link.

**This is a product SUBSTITUTION at delivery, not a data fault.** The shop
shipped a different item against the ordered line and AutoCount's own transfer
counter records it as satisfied.

**Why it is NOT repaired here, and why that is the correct call.** Writing
`so_item_id` would create a link whose two ends name a DIFFERENT product.
`docs/bugs/0671` (class `0672`) is the entry that exists because skipping that
identity comparison **put nine sales-order lines on a different bed**, and the
symmetry check's section 6 currently reports `0 name a DIFFERENT product` on
every one of the six edges. A repair here turns a proven-clean column into one
with a deliberate exception in it, on the strength of an inference the book does
not state.

The two documents are also not equally decidable, and the difference matters:

| document | can the book name the source line? |
| --- | --- |
| `DO-005583` | **Yes, by elimination.** Exactly one line on `SO-007435` carries `tq > 0` (`AK-SK + MICROFIL PIL`, qty 2) and the delivery has exactly one line, qty 2. The pairing is unique. |
| `DO-001800` | **No.** Two source lines carry `tq = 3` and the delivery carries two lines of qty 3. `{3,3}` matches `{3,3}` as a multiset and the book cannot say which answers which. |

`DO-001800`'s shape has already been ruled on by the owner —
`docs/cutover-so-do-remainder-2026-09-08.md` §F records `DO-001953` as
*"Identical in shape to HC-DO-001800, already ruled on"*, accepted as 一模一样.

**What the owner has to decide, in one question.** *Is `AK-SK FX AIRLOFT PIL`
the substitute the shop delivered against the order for `AK-SK + MICROFIL PIL`
on `SO-007435`?* If yes, one link is written, and `SO-007435`'s pillow line
stops reading as still-deliverable — which is the point: today it can be
delivered a second time. If no, nothing is written and the two documents stay
the book's own item-code drift.

**What the reconcile's headline number cannot see.** Neither of these two
documents is among the **40**. The reconcile compares line COUNT, item code,
quantity and money per document; a LINK is none of those. Both delivery orders
pass every one of its axes and are invisible to it by construction.

**The ERP side, proved on a fresh connection.** `ac-transfer-counter-check` run
[`34203192972`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34203192972),
section 5, with `docs=DO-001800,DO-005583`:

```
    --- DO-001800
        ERP delivery order HC-DO-001800 (linked_ac_docno = DO-001800) - 2 row(s)
          row 579ed745... HB109NL    qty 3 | so_item_id NULL | key 223063
          row c6b3b0d8... HB109M-CC  qty 3 | so_item_id NULL | key 223065
          its lines resolve to sales order(s): NONE

    --- DO-005583
        ERP delivery order HC-DO-005583 (linked_ac_docno = DO-005583) - 1 row(s)
          row 4152d5a3... AK-SK FX AIRLOFT PIL qty 2 | so_item_id NULL | key 506367
          its lines resolve to sales order(s): NONE
```

Both delivery orders DO carry AutoCount's own line keys — `223063`, `223065`,
`506367`, matching the book exactly — so this is not a keying gap. The line key
is present and the sales-order link is absent, which is precisely the shape that
proves the importer stopped where it should have: it knew which book line each
row is, and still had no sales-order line to point at.

**Ref.** PR pending, 2026-09-08.

Module guide: `docs/modules/document-conversion.md` §10.4 G2.
