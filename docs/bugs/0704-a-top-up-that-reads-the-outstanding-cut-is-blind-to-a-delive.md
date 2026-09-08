## A top-up that reads the outstanding cut is blind to a delivered document's missing line [high]

**Symptom.** On the go-live reconcile (run `34199308084`, 2026-09-08 15:26 +08)
eleven sales orders and two delivery notes still differed from the account book
on the LINE-COUNT axis, and five sales orders plus one delivery note on the
MONEY axis. Nine of those sales orders are the same shape: the shop added a line
to the book after the import, and our document never got it —
`AK-HAPPY SLEEP EASY` x2 "Compensate", a `DISPOSE`, three `STORAGE` /
`TRANSPORTATION CHARGES` lines at RM 150.00 each, a `Miscellaneous` at
RM 300.00, and five bedframe lines. `HC-DO-001604` reads RM 6,538.00 against
the book's RM 6,688.00 because the book's third line —
`* DISPOSE 3S L SHAPE SOFA + CONSOLE TABLE`, no item code, quantity 1,
**RM 150.00** — is not on our delivery note.

`topup-ac-so-lines.mjs` is the tool for exactly this and it could not see six of
them. Dispatched, it reported them nowhere: not as writable, not as refused, not
as unjudgeable.

**Root cause (traced).** `topup-ac-so-lines.mjs:124` reads
`data/ac-outstanding-so.json.gz`. That file is the OUTSTANDING cut, and a
document delivered since the import is not in it — so `bookByDoc` holds **zero**
lines for it, the `for (const l of ls)` loop over its book lines never runs, and
a document with no book lines can contribute no missing line. The silence is
structural: there is no counter anywhere in that run that goes down when a
document is invisible to it. Traced by reading the book directly —
`decodeSnapshot(ac-reconcile-truth.json.gz)` holds all 12 lines of `SO-013181`
and 7 of `SO-003945`, including the two DtlKeys the reconcile lists as having no
ERP row (924663, 915889), while the outstanding cut names neither document.
The population half of this was already written down as `docs/bugs/0694`;
what was not, until now, is that the same file choice makes the top-up blind
rather than merely narrow.

Two further causes, one per remaining shape:

- A **priced** missing line was refused by design even where the tool COULD see
  it (`topup-ac-so-lines.mjs:229`) — "adding one moves the header total and
  breaks the payment reconcile". True of a tool that does not re-sum the header.
  `repair-so-line-discount.mjs:236` already re-sums it.
- On a **delivery** note nothing can be matched at all:
  `delivery_order_items.linked_ac_dtlkey` is null on all 173 migrated delivery
  orders, so every line verdict there is the reconcile's value-then-order
  fallback, and a general rule would be writing on a guess.

**Fix.** `backend/scripts/topup-ac-lines-from-truth.mjs` +
`.github/workflows/topup-ac-lines-from-truth.yml`, plan by default,
`MODE=apply` armed by `CONFIRM="I HAVE REVIEWED THE BOOK LINE TOP-UP PLAN"` and
the workflow passes that phrase through (the failure `docs/bugs/0700` records).

- The SO lane is the same DtlKey comparison over
  `data/ac-reconcile-truth.json.gz` — the whole book, unfiltered — with the
  population taken from every ERP sales order carrying `linked_ac_docno`, not
  from the outstanding scope.
- It writes a priced line and re-sums `local_total_sen`, `line_count` and the
  five category buckets from the lines, using the same BUCKET map and the same
  recompute as `repair-so-line-discount.mjs`. `paid_sen` and the header
  `balance_sen` are not touched; a document a corrected total leaves
  inconsistent is NAMED, the treatment that script gives `HC-SO-000021`.
- The DO lane is a NAMED list (`DO_TARGETS`), not a rule, and each entry is
  asserted against the book and against the ERP before anything is written. Why
  it cannot be general, and the two declared choices in that write
  (`item_code`, and `linked_ac_dtlkey` deliberately left NULL), are in
  `docs/modules/delivery-order.md`.
- Bedframe lines are decoded by IMPORTING `lib/parse-bedframe.mjs`. The
  ten-key variants block that `import-ac-outstanding-so.mjs`,
  `import-ac-outstanding-po.mjs` and `topup-ac-po-lines.mjs` each spelled out —
  byte-for-byte identical in all three — is now `bedframeVariants` in that
  module and all four callers read it. `parseBedframe` itself was in exactly
  that state once and drifted TWICE (a808bf36, 60125216) before anyone noticed.
- Verification re-reads on a FRESH connection and asserts the SHAPE, in the
  database's own vocabulary: `jsonb_typeof(variants) = 'object'` and
  `variants->>'colourId'` reading back the value that was written, because a
  pre-serialized bind leaves a jsonb STRING that JavaScript parses happily while
  every SQL consumer sees NULL — the 2026-08-13 recurrence
  (`docs/jsonb-double-encoding-coe.md`), whose row count read 7 of 7.

Pinned by `backend/tests/bedframeVariantsBlock.test.ts` — 12 assertions that the
shared block equals the expression the three writers carried, transcribed
verbatim into the test so it is not verified against itself. Proved RED on the
unfixed tree by transcribing the literal with `size` in place of `specials`
(the shape `lib/po-arm-own-text.mjs`'s `blockFor` has): 7 of 12 failed on
`specials`/`size`, which is the drift this pins.

**What is deliberately NOT repaired**, all recorded in
`docs/cutover-so-do-remainder-2026-09-08.md`: `SO-012128` / `DO-011465` (blocked
on sofa line keys — refused as UNJUDGEABLE, correctly); `SO-013160` (an ERP row
claiming a DtlKey on no document — that is a line DELETION on a live order and
this repo cancels, never deletes; REPORTED); `SO-012571` (which sofa
compartment carries RM 88.00 is a decision); `SO-011384` (a book row with no
item code and quantity 4 — refused, because inventing a product is forbidden);
`DO-001953` / `DO-004903` (the gap is in the book itself, and the owner has
accepted them).

**Ref.** fix/book-line-remainder, 2026-09-08. The plan and apply run ids, the
before/after reconcile and the four control checks are in the PR; this entry
records the defect and the tool, not a claim that the repair has run.
