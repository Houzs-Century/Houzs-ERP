## The transfer-counter check crashed on min(uuid) — two of the three axes never ran on its first dispatch [low]

<!-- area: Repo tooling: tests, ratchets, generators -->
<!-- status: fixed -->

**Symptom.** First dispatch of `ac-transfer-counter-check`, run
[`34201730668`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34201730668)
(2026-09-08 15:54 Malaysia). The SO -> PO axis printed in full, then:

```
PostgresError: function min(uuid) does not exist
    at Object.groups (backend/scripts/check-ac-transfer-counters.mjs:183:21)
```

PO -> GR and GR -> PI never ran, and neither did sections 3, 4, 5 or the verdict.

**Root cause (traced, not guessed).** The grouping query carries a purely
cosmetic `erp_doc` column so an offender can be printed with something
identifying beside it. On the SO axis that is `min(doc_no)` — text, fine. On the
other two the natural key is the parent id, and both are `uuid`:

```
min(purchase_order_id)::text      -- casts the RESULT of min()
min(grn_id)::text                 -- same
```

Postgres has no `min(uuid)` aggregate, so the cast on the outside never gets a
chance to help. The cast belongs on the ARGUMENT: `min(purchase_order_id::text)`.

**Why the local smoke test did not catch it.** The script's offline path refuses
at `DATABASE_URL is not set` — by design, there is no offline mode — so every
query below that point is unexercised until the first real dispatch. That is the
CLAUDE.md rule *"a workflow_dispatch workflow is not shipped until it has been
dispatched once and reported success"* doing exactly its job: the first dispatch
is the test, and this is what it found.

**Fix.** `min(purchase_order_id::text)` / `min(grn_id::text)`.

**Ref.** PR pending, 2026-09-08. Follows `docs/bugs/0705`.
