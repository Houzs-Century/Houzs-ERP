## An order with no delivery State saved happily, then AutoCount refused it for having no stock location [high]

**Symptom** - the owner's second AutoCount write-back test, `HC-SO-2608-002`,
was accepted by the ERP and then sat in `scm.autocount_outbox` as `skipped`:

```
refused, nothing sent (MissingLocationError): 2 line(s) carry no stock location
and none can be inherited from the document ... AutoCount rejects a document
line whose Location is not in dbo.Location
```

The salesperson had already been told the order was saved. Both of the first
two test orders died this way.

**Root cause** - the SO's warehouse is the header's free-text `sales_location`,
and that value is DERIVED from the customer's State:
`deriveSalesLocationFromState` (`mfg-sales-orders.ts`) looks the State up in
`state_warehouse_mappings` and returns **null when the State is unmapped or
absent**. Create then wrote `sales_location: derivedSalesLocation ?? null`
without ever asking whether the result was usable. Both test orders had no
delivery address, so no State, so no warehouse, so no `Location` - and
`composeCreateSo` runs with `requireLocation`, because AutoCount's
`FK_SODTL_Location` rejects the empty string. The ERP was accepting a class of
order it already knew the account book would refuse, and only saying so
afterwards, in a queue nobody watches.

**Fix** - a create-time gate, company 1 only (owner 2026-08-13: *"Company 1
(Houzs Century) 开单必须有 State。Company 2 (2990) 不需要。其他公司也不必填"*).
`backend/src/scm/lib/so-location-gate.ts` holds the rule; the company list is
one array of `companies.code` values, so adding a company is a one-line change.
It gates on the DERIVED warehouse rather than on the State being present - an
unmapped State derives nothing either - and reports the two causes with
DIFFERENT messages, because they have different owners: a missing State is the
salesperson's to fix, an unmapped State is an administrator's. Wired at the two
and only two places that enqueue an AutoCount create: the create path
(`asDraft !== true`) and the `DRAFT -> live` status transition. Drafts stay
freely saveable - the scan pipeline's guess is not an order yet. Mirrored on
the four create surfaces through the shared `so-form-validate.ts` so the
operator hears it before losing their typing.

**Lesson** - **a gate the downstream system enforces must be enforced at the
point of entry, not discovered at the point of transmission.** The refusal was
correct, well-worded and completely useless where it landed: hours later, in an
outbox row, addressed to nobody, about an order the salesperson believes is
done. The same shape is waiting behind every other `requireLocation`-style
precondition in `autocount-writeback.ts` - each one is a rule the ERP can check
while the human is still on the screen.

**Ref** - PR #2099, 2026-08-13.

---
