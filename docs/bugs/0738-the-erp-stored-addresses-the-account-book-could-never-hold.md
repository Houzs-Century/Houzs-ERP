## The ERP stored addresses the account book could never hold [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `docs/bugs/0728` fitted the address on its way OUT to AutoCount, and
that cleared `HC-SO-2609-006`. It left the ERP holding a 120-character street
line while the account book's column is 40, so the two systems disagreed about
where a customer lives and every future document repeated the fit.

**The owner named the real fix the same day (2026-09-09):**

> 「我们超过 40 个字的地址全部拆分成 address 1 和 address 2，解决了这个问题。
> 然后再 sync 进去，**把我们的 address lock成 40 个字**」

**Fix — the address is fitted on the way IN, on both write paths.**

* **Create** (`POST /mfg-sales-orders`) spreads `fitSoAddress` over the four
  body fields.
* **Edit** (`PATCH /:docNo`) fits them **together, after** the field map — and
  that is the part worth reading twice. A line cannot be fitted on its own,
  because an over-long first line spills into the second, so a PATCH carrying
  only `address1` needs the other three **as stored**: they are read, merged,
  fitted, and all four written back. Fitting inside the map loop would have
  blanked the lines the caller never mentioned.
* **A read failure leaves the address alone.** Without the stored lines the
  merge would blank what it cannot see. The value is still fitted on the way out
  by `soInvoiceAddress`, so nothing over-long reaches the book — the cost of
  that branch is a wide stored line, not a refused document. `audit:swallowed-reads`
  caught the first version discarding that error and was right to.
* **An address that already fits is stored exactly as typed.** Only an
  overflowing one is re-packed, so a save that had nothing to do with the
  address never re-flows one.

**The data was repaired too**, with `repair-address-to-forty.mjs` — company 1
had exactly ONE over-long sales order, and it now reads back at 34/27/0/0 on a
fresh connection, unchanged by a second packing.

**Two numbers that were wrong until they were scoped.** The census counted 72
sales orders with a line over 40 **across every company**; company 1 has one. And
the single document that could not fit four lines even re-packed —
`2990-SO-2608-069`, 120 + 95 characters — is **2990's**, which the owner ruled
does not go to AutoCount at all. A sweep with no company predicate would have
rewritten a 2990 customer's address for a book that will never see it.

**Verified.**

* `autocountWritebackAddress.test.ts` — **13 tests**, three new: a long line
  splits across `address1`/`address2` with every word kept in order; an address
  that fits is stored identically; a line the fitted address no longer needs
  comes back `null` rather than holding a ghost of what was there.
* Every `scm/routes` suite — **301 passed**.
* `typecheck` clean; `audit:swallowed-reads` at ceiling.

**UNTESTED in the browser** — no sales order has been saved through the UI under
this build.

**What is still open.** The frontend inputs do not yet carry a `maxLength`, so a
person can still type past forty and see it silently re-flowed on save rather
than being stopped as they type. And the width itself is known for the address
alone: whether another string the write-back sends can overrun its column is
**unmeasured**, not ruled out (`docs/bugs/0728`).

**Ref.** feat/lock-address-to-forty-on-save, 2026-09-09. Follows
`docs/bugs/0728`.
