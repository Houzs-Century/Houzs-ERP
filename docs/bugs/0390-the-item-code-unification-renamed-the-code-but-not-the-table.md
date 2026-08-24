## The item_code unification renamed the code but not the table, and the tests were renamed with the code [high]

**Symptom.** Owner, 2026-08-19, three times: approving SO amendment
`2990-SO-2608-006/A2` (a PRODUCT-lane price restore, 0 → RM 1,557.50) bounced
with the generic "The operation was rolled back." Nothing in the Postgres error
log — the throw happened before any constraint was reached.

**Found by capturing it live, not by reading code.** `wrangler tail` on the
prod Worker while re-driving the click:

    [scm-command] transaction rolled back:
      Error: column "new_item_code" of relation "po_amendment_lines" does not exist

**Root cause.** #2447 (mig 0307, 2026-08-18 18:03Z) unified
material_code/product_code → item_code: it rewrote every CODE reference —
including 42 to `po_amendment_lines.new_item_code` across po-revision.ts,
po-amendments.ts and amendment-po-followup.ts — but 0307 carries **no ALTER for
po_amendment_lines**, so the table kept `new_material_code`. From that deploy,
every statement naming the column died: the PRODUCT-lane SO approve (its
`raisePoFollowUps` INSERTs follow-up PO-amendment lines), the PO-amendment
list/detail reads, and the PO-amendment create path. **The whole PO-amendment
surface, for a day.** The DELIVERY-lane A1 on 2026-08-11 predates it, which is
why "it worked before".

**Why every test stayed green.** The fixtures were renamed WITH the code —
`po-revision.applyPoAmendment.test.ts` exercises `new_item_code` against a fake
PostgREST that accepts whatever shape it is given. The suite validated the
code's agreement with itself, not with production's schema. (The timing also
overlapped the 2990-mirror money-rename breakage — same day, same rename
family — which sent the first hour of diagnosis at the wrong suspect.)

**Fix.** Migration 0308: rename `po_amendment_lines.new_material_code` →
`new_item_code`. The table side is the right side to move: item_code is the
unification's direction (vocabulary-enforced), the 42 references already say
so, and the sibling `so_amendment_lines` has carried `new_item_code` all along
— the two amendment tables now agree. `new_material_name` stays: *_name was
deliberately outside 0307's scope, and code and table agree on it.

**Ref.** PR (branch `fix/po-amendment-lines-item-code`), 2026-08-19.
