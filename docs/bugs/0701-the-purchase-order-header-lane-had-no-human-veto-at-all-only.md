## The purchase-order header lane had no human veto at all, only a set it could never match [high]

**Symptom.** A buyer corrects a migrated purchase order's date in the ERP. The
next `sync-ac-delta LANES=hdr` writes AutoCount's `DocDate` back over it. The
plan output reports the field under `differ`, never under `human`, and no
refusal is printed — so the run looks like a clean success and the buyer's date
is gone.

**Root cause (traced).** `backend/scripts/sync-ac-delta.mjs` section 6 built ONE
veto set, `humanField`, from `scm.mfg_so_audit_log`, keyed
`` `${so_doc_no}|${fieldKey}` ``. It then ran the same `tally()` twice — once for
sales orders with `pk = "doc_no"`, once for purchase orders with
`pk = "po_number"` — and both looked themselves up in that one set:

```
if ((c.verdict === "differ" || c.verdict === "erpBlank") && humanField.has(`${row[pk]}|${f.key}`)) { st.human++; continue; }
```

`humanField.has('PO-010163|po_date')` is structurally incapable of being true:
nothing ever puts a purchase-order number in that set. So the purchase-order
header lane had no human veto of any kind, and every `kind: "copy"` field in
`PO_HEADER_FIELDS` with a live ERP column was planned and written regardless of
who had touched it — `po_date`, `attention`, `display_term`.

`po_date` is staff-editable: `backend/src/scm/routes/mfg-purchase-orders.ts`
`PATCH /:id` ("PATCH header (po_date, expected_at, currency, notes)") updates it
and records the change into `scm.entity_audit_log` with
`entity_type = 'PURCHASE_ORDER'` and `field_changes` naming `poDate`. That trail
existed the whole time and the lane never read it. The script does read
`scm.entity_audit_log` elsewhere — `poTouched`, for the `recv` and `dedi` lanes —
but its needles are `received_qty` / `so_item_id` only, and it is not consulted
in section 6 at all.

**Fix.** Section 6 now builds a second index, `poHumanField`, from
`scm.entity_audit_log` (`entity_type = 'PURCHASE_ORDER'`) using
`headerAuditNeedles(PO_HEADER_FIELDS)` and the shared authorship rule in
`backend/scripts/lib/ac-human-edit.mjs`. `tally()` takes the index as a
REQUIRED parameter and throws if it is not given one, so a third document type
cannot be added later and silently inherit the wrong set — the
`optional-param-noop` rule applied to the exact shape that caused this. Refused
fields are listed by document, field, both values and who, not counted.

Pinned by `backend/tests/acHumanEdit.test.mjs` ("the PO header tally is handed
its own veto index, not the sales-order one"), PROVED RED on the unfixed tree.

**Not measured.** How many purchase orders this has already cost is UNKNOWN
here: it needs a production count of `scm.entity_audit_log` rows naming a header
field against a migrated PO, and no such query has been run.

**Ref.** fix/sync-human-edit-guard, 2026-09-08.
