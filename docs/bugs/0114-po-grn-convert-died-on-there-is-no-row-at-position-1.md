## PO -> GRN convert died on `there is no row at position -1` [high]

**Symptom** - `/po-to-gr` returns 500 on the live book. `/so-to-do` on the same
service, same shape of call, succeeds - `DO-011260` and `DO-011262` are the
proof. So the transfer primitive itself works; only the purchase side of it
fails. The message says nothing about purchasing: `there is no row at position
-1`.

**Root cause (traced, not guessed)** - the third argument of
`AddPartialTransferDetail(fromDocType, fromDocDtlKeys, transferMaster)` was
`false` on all four conversions. That flag copies the SOURCE document's header
master - supplier, currency, terms - onto the target. With `false` the GRN is
constructed with no supplier, the purchase detail constructor looks that
supplier up in the master table, `IndexOf` returns `-1`, and the SDK indexes the
row collection at `-1`. The sales classes tolerate `false`, which is why DO and
IV never showed it and why the failure looked purchase-specific rather than
argument-specific.

**Two theories were tested first and both are wrong**, recorded so they are not
re-chased: (1) that a headless process was being refused an "edit transfer
detail" dialog - `DisableShowEditTransferDetailForm()` was added and the
exception did not change by one character; (2) that `PurchaseHeader` failed to
set the supplier - `SalesHeader` does not set one either, and it passes.

**Fix** - `transferMaster: true` on the two PURCHASE conversions (`GR`, `PI`).
The two sales conversions keep `false` deliberately: they are proven in the live
book with it, and this change is not the place to disturb them.

**Lesson** - a boolean whose name is a noun deserves the reflected signature
read before it is passed. The argument had been `false` since the file was
written, and every debugging theory pointed at purchasing because purchasing was
the only side that broke - the difference was in the call, not in the module.

**Ref** - `fix/ac-convert-headless`, 2026-08-12. Compiles clean locally (48,128
bytes); NOT yet exercised against the live book - the swap must run on the host.
