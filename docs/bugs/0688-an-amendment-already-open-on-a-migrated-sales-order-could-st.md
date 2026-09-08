## An amendment already open on a migrated sales order could still be approved, and approving it rewrites the order [high]

**Symptom.** The migrated-sales-order lock shipped on 2026-09-08 (#3151, #3158)
and holds on the Sales Order screen: a `HC-SO-…` order carried across from
AutoCount shows the orange view-only banner, Edit and Submit SO Amendment are
greyed, Cancel SO is disabled and Collect payment is gone. Nothing on that
screen can change the document.

A second door was open. **Amendment approval does not live on the Sales Order
router.** `PATCH /api/scm/so-amendments/:id/approve-so` sits on its own prefix,
and it is not a status flip — it runs `applySoAmendment`, which deletes, inserts
and updates the bound order's LINES and rewrites its HEADER
(`backend/src/scm/lib/so-revision.ts`, seven write statements between lines 487
and 868). So an amendment that was already open when the lock shipped could be
driven straight through it, and the order it rewrote was one the same staff
member had just been told was view-only.

Nothing was corrupted. No NEW amendment can be raised on a migrated order —
`POST /mfg-sales-orders/:docNo/amendments` is on the guarded prefix — so the
exposure is exactly the amendments that were already open, and the population
was measured before the guard was written (see *Population*, below).

**Root cause (traced, not guessed).** The guard is mounted at a PREFIX, which is
the right shape and the reason the twenty-odd writers inside
`mfg-sales-orders.ts` are all covered by one line. What was never checked is
whether the prefix is the only door onto the document. Two routers write one
sales order:

```
scm.use("/mfg-sales-orders/*", migratedSoReadonly());   // guarded 2026-09-08
scm.use("/so-amendments/*",    scmAreaGuard(...));      // NOT guarded
```

`docs/migrated-so-lock.md` §7 recorded this in the same PR that shipped the
lock — *"An amendment already open on a migrated order when this shipped can
still be approved. If that matters, find them before lifting the freeze."* — so
it was known and written down, and then left. Writing a hole down is not
closing it, and the freeze lift that makes it reachable was the very next
operational step.

It is the same lesson as `docs/bugs/0687-two-buttons-…`, one level up. That one
was *"the file consults the gate" is not "every write on the file is behind
it"*. This one is **"the router is guarded" is not "the document is guarded"** —
a document-level rule has to be mounted on every prefix that can reach the
document, and the way to find those is to enumerate the writers, not to reason
about them.

**Fix.** A second mount of the same rule, on the amendment prefix:

```
scm.use("/so-amendments/*", migratedSoAmendmentReadonly());
```

Both middlewares are now one factory in
`backend/src/scm/lib/migrated-so-readonly.ts`, so they cannot drift apart: same
`409 so_migrated_readonly`, same `reason` + `message` pair, same `*` /
`scm.admin` bypass, same fail-closed answer when a read does not run. The only
difference is how a request names its document — a doc number in the path, or an
amendment id resolved to one through `so_amendments.so_doc_no`.

Three answers, not two, on that resolution, and it is the part worth reading:
an amendment that is simply absent answers `null` and the write proceeds (the
handler will 404 and write nothing), while a row that IS there but whose
`so_doc_no` could not be read THROWS — "could not tell" LOCKS, because *not
migrated* is the permissive answer and a read that did not run must never be
able to look like it.

**Proved RED on the unfixed tree.** `backend/tests/migratedSoReadonlyMiddleware.test.ts`
(25 assertions, the production mount shape, no `vi.mock`). With
`migratedSoAmendmentReadonly()` replaced by a pass-through: **4 failed, 21
passed** — approve-so 200 instead of 409, all six gates 200, and both
read-failure cases 200. With the guard restored: **25 passed**. The suite keeps a
`describe('the hole, reproduced')` block that asserts the OLD behaviour with only
the sales-order guard mounted, so unmounting the new line fails a test rather
than passing silently.

**Population.** `backend/scripts/check-migrated-so-amendments.mjs` +
*Migrated-SO open amendments — status (read-only)* count the amendments that are
open (`REQUESTED` / `SUPPLIER_PENDING` / `SO_APPROVED` / `PO_APPROVED`) on an
order whose `linked_ac_docno` is not null. It reports zero as an answer, not as a
failure — the guard is worth shipping either way, because it stops the next one.

**Ref** — fix/so-amend-migrated-lock, 2026-09-08. Follows #3151 and #3158.
