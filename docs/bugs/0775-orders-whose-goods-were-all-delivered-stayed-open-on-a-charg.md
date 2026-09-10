## Orders whose goods were all delivered stayed open on a charge line [low]
<!-- area: Sales orders + pricing -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-10, working through the open-order list: 「那些剩下
transportation、disposal 这些全部东西都可以关掉，货已经送完了的就可以关掉了」.

Measured on production, company 1: **29 sales orders** whose real goods are all
delivered are still open, held there by a single charge line — transport,
storage, dispose, repair or misc. One of them (`HC-SO-012828`) has nothing open
at all: it is finished and its status never caught up.

**Root cause (traced).** The header only flips to DELIVERED once EVERY line is
fully covered (`so-stock-allocation.ts` / the delivery sync). A charge line is
never "delivered" in the goods sense, so it holds the flip open for ever. There
is no defect in that rule — a fee genuinely is outstanding until it is billed —
but the consequence is that a finished order reads as work.

**NOT an MRP problem, and the first write-up of this said it was.** The owner
corrected it: 「因为 Service 我们都不会进 MRP 里面去计算的」. He is right, and the
code agrees — `routes/mrp.ts` skips `isServiceLine` BEFORE the category filter,
so a service line never reaches the plan and `?category=SERVICE` cannot surface
one either. `others`-group lines cannot reach a tab either. These 29 were never
distorting MRP; they distort the OPEN-ORDER list. The correction matters because
the wrong reason would have sent the next reader to fix the wrong engine.

**The trap this nearly walked into.** A naive "only a non-goods line is left"
filter also matches **five** orders whose open line is `AN-TABLE TOP`,
`AN-DINING LEG`, `AN-DINING CHAIR`, `CH-DT ROD` or `CH-DL ROD` — dining furniture
that sits in item_group `others` and looks exactly like a fee. Those customers
have not received their table. The predicate treats `^(AN-|CH-)` as GOODS so they
are excluded, and they are listed separately for the owner rather than silently
dropped.

**Fix.** `backend/scripts/close-fee-only-sales-orders.mjs` +
`.github/workflows/close-fee-only-sales-orders.yml`. Header status only:
DELIVERED where something shipped (23), CLOSED where nothing ever did (6).

No line, no quantity and no money is touched — deliberately. The document's
CONTENT stays byte-identical to the account book, so the AutoCount tally cannot
begin reporting a difference we invented. And the AutoCount write-back is
enqueued by the ROUTE layer, never by a database trigger (`scm.mfg_sales_orders`
carries three triggers, none of them the outbox), so a direct write reaches
Postgres and stops there.

**Verification.** Plan run against production, read-only:

```
mode=plan company=1
orders whose GOODS are all delivered and only a charge line is open: 29
  -> DELIVERED (something shipped): 23
  -> CLOSED    (nothing ever shipped): 6
```

`npm --prefix backend run audit:release-discipline` — no new violations. The
script carries all four required properties: MODE defaults to plan, apply needs
`CONFIRM=CLOSE-FEE-ONLY-SO`, the verification re-reads on a FRESH connection and
asserts the SHAPE (status AND that every order still carries its lines and
quantities — a row count would have said "29 updated" while the lines were
gone), and the header states what a second run does.

**The apply run is NOT yet done** — it is the owner's to dispatch. This entry
will carry its run id when it lands; until then that half is UNTESTED.

**Ref.** `fix/close-fee-only-sales-orders`, 2026-09-10.
