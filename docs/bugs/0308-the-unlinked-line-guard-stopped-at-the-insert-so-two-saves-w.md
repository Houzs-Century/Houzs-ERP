## The unlinked-line guard stopped at the INSERT, so two saves walked around it on four chains [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** None reported yet — this is the preventative half of a defect whose
corrective half is already in the file. Five chains refuse an unlinked line whose
code is on the parent the document names. All five refuse it only on the way IN.

**Root cause.** The refusal is two saves away from being pointless:

1. add a line whose code is NOT on the named parent — correctly allowed, because
   that is the service / freight / ad-hoc carve-out the nullable link exists for;
2. PATCH that line's code to one that IS on the parent — nothing looked.

The stored link is still NULL after step 2, and NULL is what every cap and every
recount on these chains keys on, so all three of them skip:

- `grns.ts` — `if (poItemId && qtyReceived > prevQty)` skips the cap, and
  `recomputePoReceived(sb, [purchase_order_item_id])` sums by the link, so the PO
  line still reads fully outstanding and the delivery is received again.
- `purchase-returns.ts` — `if (grnItemId && delta !== 0)` skips the cap and
  `adjustGrnReturnedQty` is never called, so `grn_items.returned_qty` never moves.
- `sales-invoices.ts` — `if (it.qty !== undefined && prev.do_item_id && …)` skips
  the over-invoice cap, and the resync re-posts the revenue and re-enqueues the
  invoice to AutoCount.

Two further findings while verifying it:

- **The purchase-return ADD-LINE path had no insert guard at all.** The other
  four chains guard theirs; `addPurchaseReturnItemHandler` never did, so its
  create-path refusal could be walked around in ONE save by adding the line
  afterwards. Same N-1 shape, one file over.
- **All four parent-set readers failed OPEN.** `soItemCodesOf`,
  `poMaterialCodesOf`, `doItemCodesOf` and `grnMaterialCodesOf` each read
  `const { data } = await sb…` with the error discarded. A failed read produced an
  EMPTY set, and an empty set is exactly what the shared predicate treats as "the
  parent orders nothing" — so a transient blip did not degrade the guard, it
  DISABLED it, on the write it exists to refuse. Third occurrence of the class
  after `piLocked` and `findServiceLineCodes`.

**Why the delivery-return chain is in scope despite "no DO, no Return".** Both DR
write paths refuse a null `do_item_id` outright (bug #16), so an unlinked DR line
cannot be typed — but it can still ARRIVE: every one of these link columns is
`ON DELETE SET NULL` (`2990s-full-schema.sql:1656, 1662, 1739, 1754`), so deleting
a parent line orphans its children.

**Fix.** `backend/src/scm/lib/unlinked-line-edit-guard.ts` — the rule ONCE, with
the four chains' differences (which parent column, which reader, which vocabulary)
declared as arguments in one `CHAINS` table. Each handler's change is a single
`unlinkedEditRefusal(...)` call. The rule runs on the POST-edit code
(`patch.code ?? stored.code`), only while the stored link is NULL, and only on the
TRANSITION not-on-parent -> on-parent: a line that was ALREADY on the parent is
left alone, because `ON DELETE SET NULL` means that state arrives through no act
of the operator's and a check must only fail on what its actor could have done.
The four readers now return `ParentCodes` and `ok: false` is refused, never read
as "nothing on the parent"; `readParentCodes` is the one implementation.

Not a boolean already-converted flag (owner ruling): nothing here counts
conversions, so batch receiving and batch shipping are untouched. Nothing added on
SO -> PO. Two DRAFT GRNs on one PO line still coexist.

**Proof it is not vacuous.** Five wiring assertions slice each router's source per
handler and require the guard symbol inside that handler's own body; all five were
observed RED before the call sites existed and green after. `audit:swallowed-reads`
caught two fail-open header reads in the fix itself — a discarded error there
yields a null parent, which reads as "names no parent", which returns "allowed" —
and both now bind `error` and refuse. The four guard libs left the swallowed-read
baseline entirely (1/1/2 -> 0) and `sales-invoices.ts` went 30 -> 29.

**One extraction, forced by the file-size ratchet and worth it anyway.** Three of
the touched routers are already over their ceilings, so a touched file may not
grow. The per-handler prose moved into the lib (which is where a shared rule's
reasoning belongs — restating it four times is how it drifts), the two-step
"refuse on unreadable, refuse on offenders" collapsed into one
`unlinkedScanRefusal`, and `computeGrnFlags` left `routes/grns.ts` for
`lib/grn-consumption-flags.ts`. That last one is the CANONICAL definition four
other routers and migration 0267 defer to in prose — "mirrors computeGrnFlags in
routes/grns.ts" — so it had no business being a private function halfway down a
3,600-line router. Its body is byte-identical to the one it replaces, the four
ROUTER pointers are updated, and it now has its own tests.

Migration 0267's two mentions are deliberately NOT updated. They name the
function, not its path, so they are still true — and 0267 is already applied.
The working-agreement gate refused a comment-only edit to it, correctly: an
applied migration that no longer matches what ran is a worse artefact than a
prose pointer one directory stale, and pg-migrate tracks by full filename.

**Residual, deliberately not smuggled in.** An orphaned line's QTY can still be
raised without the guard firing (it fires on the code transition only), and
`doLineRemaining` — which the SI chain's pending-code reader calls — is fail-open
throughout and shared by many callers. Both are their own units.
