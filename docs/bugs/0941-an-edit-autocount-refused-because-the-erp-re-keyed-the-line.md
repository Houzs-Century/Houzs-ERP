## An edit AutoCount refused because the ERP re-keyed the line never cleared itself [high]

<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**Symptom.** A Sales Order sits on the AutoCount Sync page under **Not accepted**
with its own words *"line 803474 not found on SO-011654"*. The document is in the
ERP with the current sizes; the book still holds the old ones. It never clears on
its own — a hand re-send is the only thing that moves it. HC-SO-011654,
2026-09-15: a line was deleted at 10:21:01Z and the save was a `Rebuild` that
re-keyed the book's lines (new DtlKeys 931973–931978); five edits composed a
second later still named the OLD keys 803471–803477, were refused six times each,
and ended `failed`.

**Root cause (traced).** The drain replays a stored payload and never recomposes
(`dispatchOne`, `autocount-outbox.ts`). A `Rebuild` deletes the book's lines and
re-adds them with fresh DtlKeys, and the ERP stores the new keys — so an edit
composed against the old keys names lines that no longer exist, and every retry
replays the same dead keys. AcSyncService.cs:3729 throws
`line <DtlKey> not found on <docNo>`; the outbox retried it to the attempt cap
and left it `failed`. The mirror image of 0924, where the key had not arrived
YET; here it is already GONE.

**Fix.** `autocount-stale-key-recompose.ts`, wired into `dispatchOne`'s failure
path. A keyed `edit` refused as line-not-found is decided at the first such
refusal instead of burning six attempts: `recomposeStaleKeyedEdit` reads the
document's live line keys (`mfg_sales_order_items` by `doc_no`,
`purchase_order_items` by `purchase_order_id`); if the refused key is GONE the
ERP re-keyed it, so it composes one fresh edit through the ordinary `enqueueEdit`
(all save-route guards still apply) and folds the refused row as Replaced; if the
key is STILL live the account book lost the line, so the row stays `failed` for a
person. Does NOT carry a size (item-code) change — an edit sends no per-line
`ItemCode`; that is a separate defect. `autocount-stale-key-recompose.test.ts`
covers the parse, the re-keyed / office-changed / duplicate-guard decisions, and
the HC-SO-011654 sequence end to end through the drain; the end-to-end case was
proved RED on the unwired tree (the refused row kept its plain error) and GREEN
after wiring.

**Ref.** fix/ac-stale-key-recompose, 2026-09-15.
