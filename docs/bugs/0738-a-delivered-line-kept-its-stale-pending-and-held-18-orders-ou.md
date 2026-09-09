## A delivered line kept its stale PENDING and held 18 orders out of the ship queue [high]

<!-- area: Sales orders + pricing -->
<!-- status: fixed -->

**Symptom.** An order whose remaining lines are all allocated does not advance to
`READY_TO_SHIP`. It sits at `IN_PRODUCTION` with nothing left to wait for,
because a line whose goods are **already at the customer** is being counted as
short.

**Root cause (traced), and the comment said the opposite of the code.**
`recomputeSoStockAllocation` computes `remaining = qty − delivered + returned`
and skips the line at `remaining <= 0` — correct, there is nothing left to
allocate. The consequence is that `stock_status` on a delivered line is FROZEN
at whatever it last was, and for goods that shipped straight off a purchase
order that is usually `PENDING`.

The header rollup in the same file then read that frozen value:

```ts
/* ... lines that weren't in needs are already shipped → treat as READY */
stock_status: targetStatusById.get(l.id) ?? l.stock_status,
```

A shipped line is skipped **before** `needs` is built, so `targetStatusById` has
no entry for it and the `??` falls through to the stale stored value. The
comment promised READY; the code delivered PENDING. `summariseReadiness` then
counted it as a short MAIN line and `isShipReady` stayed false.

**Measured on prod 2026-09-09** (company 1, read-only): **60** live orders carry
at least one delivered line whose stored status is not READY — **190 lines** —
and on **18** of those orders EVERY still-outstanding line is already READY, so
18 orders are held out of the ship queue by goods that have shipped. Examples:
`HC-SO-000013` (TAY HAN HONG, 8 lines, 7 delivered), `HC-SO-000822` (TEH MAT
LING, 7 lines, 6 delivered), `HC-SO-009730` (John, 13 lines, 12 delivered).

**AND WHY THE STAMP IS MISSING IN THE FIRST PLACE — the second half, traced.**
`so-delivery-sync.ts:345` is the sole writer that lands a shipped line on READY,
and its own comment says why it lives there rather than in the allocator
(*"recompute deliberately SKIPS fully-shipped lines … This reconciler is the sole
writer"*). It runs on every DO / DR mutation — so it should have covered these.
It did not, because **they never went through a DO mutation**: of the 190,
**187 sit on a MIGRATED delivery order** (`linked_ac_docno IS NOT NULL`, DOs
created during the August cutover), which the import wrote straight into the
database. The reconciler was never invoked for them.

That makes the roll-up's dependence on the stored value a real fragility rather
than a theoretical one: any path that creates a shipped line without going
through the mutation — an import, a repair script — leaves the flag unset, and
before this fix that silently held the order back.

**Fix.** `ReadinessLine.fulfilled` — the line has nothing left to deliver — is
counted the way a SERVICE line is counted and gates nothing.

- **Counted, not `continue`-d past.** Dropping it entirely would make an order
  whose every line has shipped byte-identical to an order with NO LINES, and the
  empty-husk gate (`soShipGate.test.ts`, the 16 POS husks of 2026-08-13) would
  then refuse a finished order. `liveCount` includes it; the ready tallies do
  not.
- **Modelled honestly rather than by writing `'READY'`** onto a line that is not
  ready but DONE. Asking whether delivered goods are "in stock" is the wrong
  question of the wrong line.
- **The flag is OPTIONAL, and that is the one shape CLAUDE.md's
  required-parameter rule permits: its absence is the STRICTER direction.** A
  caller that cannot say whether the line shipped leaves it undefined and the
  line keeps gating exactly as before — never over-promising. Making it required
  would have forced eight call sites, several of which load no delivery
  quantities at all, to invent an answer.
- The allocator supplies it from `qty − delivered + returned`, **the same
  arithmetic its needs walk already uses**, so the two can only ever agree about
  which lines are finished.

**The DATA repair is a separate, offered piece of work.** This fix makes the
roll-up stop depending on the stamp; it does not backfill the 190 lines, whose
`stock_status` still reads PENDING for any consumer reading the raw column. That
backfill is a production write and belongs in a plan/apply script under the
release-discipline rules, with the owner's word before it runs.

**What this does NOT change.** The per-line PILL was already correct on both
surfaces — `soLineStockPill` (desktop) and `soStockPillMobile` (mobile) both
render `DELIVERED` from `delivered_qty > 0 && remaining_qty === 0`. Only the
ROLL-UP was wrong. The list's `stock_remark` still reads the ungated rollup
through `readinessLinesByDoc`, which loads no delivery quantities; that half is
named in `docs/mrp-po-gr-ready-chain-2026-09-09.md` and is not closed here.

**Verified.** `soReadinessDeliveredLine.test.ts` — five cases, three of them
proved RED on the old code first (the two "absence is stricter" cases pass
before and after, which is the point). `soShipGate` and `soReadinessRemark`
unaffected: 114 passed across the three files. Typecheck clean.

**Ref.** Found while answering the owner's 「要」 to fixing delivered lines that
look stuck — the premise reported to him was that the SCREEN showed PENDING,
which was inferred from the database column and was WRONG. Reading the pill
first would have found the real defect one layer up, and reading it is what
found it.
