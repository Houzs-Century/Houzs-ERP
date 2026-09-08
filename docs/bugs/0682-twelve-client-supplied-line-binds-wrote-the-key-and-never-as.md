## Twelve client-supplied line binds wrote the key and never asked whether the two rows were the same product [high]

**Symptom.** `probe-link-identity.mjs` run 34172468269 (2026-09-08 08:13 local)
counted, against production: **2 sales-invoice lines and 3 purchase-invoice
lines whose link names a DIFFERENT PRODUCT than the line itself**, on 5
separate documents. Every one of the five is FILLED, none DANGLES, none
violates a constraint, and none is a positional permutation — the parent is a
product the document does not even order. Nothing in the ERP could report them,
because the only instrument that looked at these columns counted links FILLED
and DANGLING, and a valid foreign key pointing at the wrong bed is neither.

**Root cause, traced.** Site 15 of the bug class
[`0672`](0672-bug-class-key-without-identity-a-link-written-on-the-key-alo.md) —
*key-without-identity*. Twelve write paths take a source-line uuid straight out
of the request body and put it in a link column. Each one proves the source
line's COMPANY (`assertSourceLinesInCompany`), most prove the parent document's
STATUS, and most cap the QUANTITY against that line's remaining. **Not one
compared the ITEM.** So a line ordering product B may name a source line for
product A and every existing check passes.

That is not a labelling error, because the quantity ledgers are addressed BY
THE LINK:

| writer | column it moves | addressed by |
|---|---|---|
| `recomputePoReceived` | `purchase_order_items.received_qty` | `.eq('id', purchase_order_item_id)` |
| `recomputeGrnInvoiced` | `grn_items.invoiced_qty` | `.eq('id', grn_item_id)` |
| `adjustGrnReturnedQty` | `grn_items.returned_qty` | `.eq('id', grn_item_id)` |
| `doLineRemaining` | what is still invoiceable | `sum(qty) by do_item_id` |

A wrong link therefore draws down the WRONG source line's remaining quantity,
so the right one stays open and the same goods can be received, invoiced or
returned a second time. On the sales side `so_item_id` is worse still: a
bedframe or sofa line is HARD-BOUND (`isHardBoundLine`,
`src/scm/lib/so-stock-allocation.ts`) and reads READY only through its own
dedicated purchase order, which is how 0671 told the floor a customer's REGAL
was ready when a TRION arrived.

**Fix.** One rule, `backend/src/scm/lib/line-link-item-identity.ts`, applied at
all twelve binds. It normalises both codes the way a person reads them (trim,
upper-case, collapse inner whitespace — identical to `soLinkItemMismatch` and
to `normItemCode`, so the rule means one thing system-wide) and refuses with
409 `link_material_mismatch`, naming both products and the source document type
in a sentence an operator can act on.

Two refusals in it are the point of the whole class, and both are pinned by
tests:

- **A source row that cannot be read back is REFUSED, not skipped.** An id that
  resolved to nothing cannot be asserted equal to anything. Treating "not
  found" as "nothing to compare" is exactly the false negative 0672 is about.
- **A failed READ is a 503, never a pass.** "We could not check" must not be
  spelled the same way as "we checked and it was fine" — the same stance
  `remainingUnavailableResponse` takes, and for the reason its header records.

| # | path | column | source |
|---|---|---|---|
| 1 | `sales-invoices` POST `/` | `do_item_id`, `so_item_id` | DO / SO line |
| 2 | `sales-invoices` POST `/:id/items` | `do_item_id`, `so_item_id` | DO / SO line |
| 3 | `purchase-invoices` POST `/` | `grn_item_id` | GRN line |
| 4 | `purchase-invoices` POST `/:id/items` | `grn_item_id` | GRN line |
| 5 | `purchase-invoices` PATCH line | `grn_item_id` | GRN line |
| 6 | `grns` POST `/` | `purchase_order_item_id` | PO line |
| 7 | `grns` POST `/:id/items` | `purchase_order_item_id` | PO line |
| 8 | `purchase-returns` POST `/` | `grn_item_id` | GRN line |
| 9 | `purchase-returns` POST `/:id/items` | `grn_item_id` | GRN line |
| 10 | `delivery-returns` POST `/` | `do_item_id` | DO line |
| 11 | `delivery-returns` POST `/:id/items` | `do_item_id` | DO line |
| 12 | `delivery-orders-mfg` POST `/` and POST `/:id/items` | `so_item_id` | SO line |

Path 6 applies the PURE rule rather than the async helper: the create path
already reads the PO rows for its receivable-PO guard, so adding `item_code` to
that select makes the comparison cost no extra round trip — the shape PR #3087
used for `POST /purchase-orders`.

**Path 5 is not in 0672's list, and is added deliberately.** 0672's second
structural observation is that four EDIT paths let `item_code` be rewritten
UNDER a live link, so a line correctly bound at create time can be edited out of
identity afterwards; only the GRN edit path froze it
(`grnInheritedFieldChanges`). The purchase-invoice PATCH is one of the four, and
it is guarded here against the code that will actually be STORED — the body's
when it sends one, the previous value otherwise. The other three remain open and
are listed as such.

**Proved RED first.** `backend/tests/keyWithoutIdentityGuards.test.mjs` against
`9a23806a0`:

```
 ❯ tests/keyWithoutIdentityGuards.test.mjs (15 tests | 10 failed)
     × sales-invoices POST / — do_item_id from the create body
     × sales-invoices POST /:id/items — do_item_id on the add-line
     × purchase-invoices POST / — grn_item_id from the create body
     × purchase-invoices POST /:id/items — grn_item_id on the add-line
     × grns POST / — purchase_order_item_id from the create body
     × grns POST /:id/items — purchase_order_item_id on the add-line
     × purchase-returns POST / — grn_item_id from the create body
     × purchase-returns POST /:id/items — grn_item_id on the add-line
     × delivery-returns POST / — do_item_id from the create body
     × lib/do-item-row — so_item_id carried onto every DO line
 Test Files  1 failed (1)
      Tests  10 failed | 5 passed (15)
```

After: `Test Files 1 passed (1) / Tests 17 passed (17)`, plus 12 behavioural
assertions in `backend/tests/lineLinkItemIdentity.test.ts`. The structural file
reads SOURCE on purpose — the property being pinned is that the rule is APPLIED
AT EACH CALL SITE, and a call-site population is precisely what a unit test
cannot see (`0099`).

**UNTESTED as a remedy, and deliberately so.** These are REFUSALS. They cause a
future write to be rejected; **not one of them repairs an existing row, and
nothing in this PR touches the 5 live wrong links.** The counts above are what
the probe measured, not what this changed. Repairing those 5 needs a row-level
decision (is the LINK wrong, or is the ITEM CODE wrong?) that only the owner can
make, and it moves money — it is raised, not taken.

**No stock or readiness moves.** Every change is a read-then-refuse before an
insert; no recompute is triggered and no existing row is written.

**Ref.** fix/link-identity-14, 2026-09-08. Class: `0672` site 15.
