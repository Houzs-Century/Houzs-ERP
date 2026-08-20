## A Delivery Order line could still be created with no link to the SO line it ships [high]

<!-- area: Delivery, DO, returns -->

**Symptom.** Owner 2026-08-14: MRP told purchasing to buy goods that had already
shipped. 24 delivery-order lines across 11 sales orders carried
`so_item_id = NULL`, so a delivered order read as entirely undelivered.

**Root cause (traced).** The rows were repaired by #2185; the hole that wrote
them was left open. `buildItemRow` takes `so_item_id` straight off the request
body and defaults it to null, and both body-driven insert paths go through it —
`POST /` and `POST /:id/items`. Confirmed still present on `main` at
2026-08-16 before this PR was revived: `so_item_id: (it.soItemId as string |
undefined) ?? null`, twice, in `delivery-orders-mfg.ts`. The remaining-qty
guard, the sofa batch guard, the SO header's status flip and MRP's
delivered-netting all resolve on that column, so a null turns each of them into
a silent no-op. `POST /from-sos` never had the defect because it derives the
link itself; PR #1395 fixed the DO-create *page* on 2026-07-29 and lines written
a week later were still unlinked, because a client fix cannot close a hole that
lives in the server accepting the omission.

**Fix.** `scm/lib/derive-do-so-item-id.ts`, called on both paths BEFORE anything
downstream consults the field. Code on the SO and resolvable -> link it; code on
the SO but ambiguous -> **400**, because only the client knows which line it
meant and a wrong link credits one line's shipment against another and cannot be
told from a fact afterwards; code not on the SO -> the null stands, which is the
ad-hoc line the delivery paths already document. A failed read of the sales
order REFUSES rather than defaulting to the null it exists to prevent. The
pairing is imported from `scripts/lib/do-so-item-pairing.mjs` rather than
mirrored, so the repair script and the runtime guard cannot drift.

**A second swallowed read, found while reviving this.** The add path's own
"which SO lines has this DO already claimed" query destructured `data` only. On
a failed read `claimed` became empty, the exclusion silently emptied, and the
guard reintroduced the very double-link it exists to prevent — one level up from
the defect being fixed. It now binds `error` and refuses
(`claimedSoItemIdsOnDo`), which is why `audit:swallowed-reads` reports no gain.

**Test.** `backend/tests/deriveDoSoItemId.test.ts` — the ad-hoc pass-through, the
never-second-guess-a-stated-link rule, the fail-closed read, the colour-resolved
pair, and the refusal on ambiguity.

**Ref.** PR #2225, fix/do-line-derive-so-item-id-0814, 2026-08-16. Part one was
#2185.
