# Module-guide verification ledger

Which of the module guides have had their **behavioural claims** checked against
the source, by whom, and what was found.

**This file is the handover.** The work it tracks is a long grind that will
outlive any one session, so the state lives here rather than in someone's head.
If you are picking this up cold: read the method, take the top unverified guide,
and update its row in the SAME PR that fixes the guide.

---

## Why this exists, and what it is NOT

`check-docs-drift` resolves every **mechanically checkable** claim a doc makes —
a path, a `mig NNNN`, a permission key, an `npm run`. It gates PRs on the CERTAIN
half and it is good at that job.

It cannot check a sentence like *"the confirm gate requires a venue"*. That is
most of what a module guide says, and **no script will ever settle it**. Measured
2026-08-15: 2,138 mechanically checkable claims across 154 markdown files, against
roughly 60,000 lines of documentation. The gap is not a tooling gap that better
tooling closes — it is prose about behaviour, and it needs a reader.

A guide that lies is worse than no guide. `CLAUDE.md` makes reading the guide
MANDATORY before touching a module, so a wrong sentence in one is a wrong belief
installed in whoever reads it, right before they change the code it describes.

**Not verified is the honest default.** A row that says `not verified` is not a
failure; it is the truth, and it is the only thing that makes a `verified` row
mean anything.

---

## Method — what "verified" has to mean

A guide is `verified` when someone has done all four:

1. **Read the guide's behavioural claims** — the sentences a reader would ACT on:
   what is required, what is refused, what a status transition allows, who is
   allowed, what happens on cancel, which surface owns a rule.
2. **Read the source that decides each one**, and named it in the ledger row.
   The route handler, the guard module, the migration's own words. Not the file's
   comments — `CLAUDE.md` is explicit that comments describe intent and the code
   is the fact.
3. **Corrected what was wrong, in the same PR**, with a dated note saying what
   the guide used to say. Deleting an error silently leaves the next reader
   unable to tell which version they are remembering.
4. **Recorded the verdict here**, including what was found. A verification that
   found nothing wrong still says so — "checked, nothing wrong" is a result, and
   the next person needs to know it was checked.

**Not verified by:** re-reading the guide and finding it plausible; a green
`check-docs-drift`; the fact that the module works. None of those look at whether
the sentence matches the code.

**If a claim cannot be settled from source** — it depends on production data, or
on a decision only the owner can state — write it in the row as UNKNOWN and leave
the guide's sentence alone. Do not guess, and do not delete a claim because it is
hard to check.

---

## Ledger

<!-- Keep this table sorted by status then name. One PR per guide. -->

| guide | status | verified by / PR | what was found |
|---|---|---|---|
| `address-cascade.md` | not verified | — | — |
| `announcements.md` | not verified | — | — |
| `autocount-writeback.md` | not verified | — | — |
| `combo-pricing.md` | not verified | — | — |
| `delivery-order.md` | not verified | — | — |
| `delivery-rate-card.md` | not verified | — | — |
| `delivery-return.md` | not verified | — | — |
| `delivery-tms.md` | not verified | — | — |
| `document-traceability.md` | not verified | — | — |
| `fleet-maintenance.md` | not verified | — | — |
| `global-search.md` | not verified | — | — |
| `grn.md` | not verified | — | — |
| `mail-center.md` | not verified | — | — |
| `mrp.md` | not verified | — | — |
| `payment-voucher.md` | not verified | — | — |
| `projects-pms.md` | not verified | — | — |
| `purchase-consignment-order.md` | not verified | — | — |
| `purchase-order-amendment.md` | not verified | — | — |
| `purchase-order.md` | not verified | — | — |
| `purchase-return.md` | not verified | — | — |
| `quote.md` | not verified | — | — |
| `sales-invoice.md` | not verified | — | — |
| `sales-order.md` | partial (5 of ~24 sections) | Claude, #2231 | 4 sections correct in full; 1 finding. FINDING: the guide claimed the AutoCount create-enqueue invariant was held at "exactly two places, both gated" and cited a test that "fails if a THIRD callsite appears" — there were three, and the test counted inside ONE imported file so it could never see the others. The third (`autocount-requeue.ts`) is safe by a DIFFERENT mechanism: `enqueueSoCreate` catches MissingLocationError and writes a `skipped` outbox row. Guide + test header corrected, guard now walks the tree. CORRECT IN FULL: discard locks (fails closed), cancel + PWP vouchers (all 4 outcomes, no void/restore collision), downstream lock (9 sites, all mutation/cancel; DO router uses its own sibling lock), warehouse resolution (`salesLocation ?? fromState`; 0173 rebinds NULL lines only, so-revision every non-cancelled line). NOT READ: dates, pricing, address block, list handler, amendments. |
| `scan-to-so.md` | not verified | — | — |
| `service-case.md` | not verified | — | — |
| `stock-take.md` | not verified | — | — |
| `team-members.md` | not verified | — | — |
| `warehouses.md` | not verified | — | — |

**28 guides, 0 verified, 1 partial** as of 2026-08-15 — `address-cascade.md` landed on `main` while this PR was in flight, and the guard below is what noticed. Do not type this pair either; the commands under it are the answer. Re-count rather than trust that line:

```bash
grep -c '| not verified |' docs/MODULE-GUIDE-VERIFICATION.md
ls docs/modules/*.md | wc -l
```

---

## Order of work, and why

Money and stock first, because a wrong sentence there is the expensive kind, and
because those modules are the ones people actually open:

1. `sales-order.md` — the largest surface, and the guide `CLAUDE.md` names as the
   shape to copy
2. `delivery-order.md`, `grn.md` — stock movement
3. `sales-invoice.md`, `payment-voucher.md`, `purchase-order.md` — money
4. everything else

---

## The gap this ledger does NOT cover

**70 of 135 route modules are named in no guide at all** (re-measure: the loop is
in `docs/HANDOFF-2026-08-15.md`). Verifying the 27 that exist does not touch
those 70. Writing a guide for a module is a bigger job than checking one, and it
is a separate line of work — do not let a verified-27 count read as "the modules
are documented".
