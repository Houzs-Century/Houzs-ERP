# Vocabulary unification — programme progress

Owner ask (2026-08-18): read the whole system once, find every place the same
thing has more than one spelling and every place the docs disagree with the
code, fix the drift, bring the docs current, and **put something in place so it
cannot come back** — so this never has to be done by hand again.

This file is the single status page. Update it every time a stage moves. It
tracks WORKTREES and STAGES, not individual edits.

---

## Stages

| # | Stage | State |
| --- | --- | --- |
| 0 | **Screening** — read all 1,360 source files (BE/FE/DB) | **DONE** 2026-08-18 |
| 1 | **Batch 1 — stop the bleeding** — register every concept, generate the glossary, fix the doc-drift, fix the low-risk defects | **IN PROGRESS** |
| 2 | **Batch 2 — pay the debt** — retire each drifted spelling, one concept per PR, with its migration | NOT STARTED |

Screening output lives in [`system-screening-2026-08-18.md`](./system-screening-2026-08-18.md):
**33 true-drift concepts, 21 defects (0 high), 1 doc-drift.**

---

## Worktrees

| Worktree | Branch | PR | Carries | State |
| --- | --- | --- | --- | --- |
| `branding-backfill` | `feat/one-vocabulary` | #2420 | the registry, the glossary, the drift catalogue, this progress file, the doc-drift fix | **open, extending** |
| `screening` | `chore/system-screening` | — | scratch tree the screening read from | disposable |

Earlier, already-landed work in this programme:
- #2402 Branding display rule unified · #2410 2990 branding backfill · #2415 HC sofa SCOPE=catalog — all **merged**.

---

## Batch 1 checklist

- [x] Screening report saved as the batch-2 worklist
- [x] `drift-catalogue.mjs` — the 33 concepts as reference data
- [x] Glossary prints the worklist (target spelling per concept)
- [ ] Doc-drift fixed — `sales-order.md:101` still says `proceeded_at` is stamped by a path that no longer exists
- [ ] Low-risk defects fixed (the tenant-predicate and silent-mutation class), each with a `BUG-HISTORY.md` entry
- [ ] CI green, PR updated

## Money — decided, not deferred

Owner: exports show too many zeros; use RM (`35.00`). This is a **display** rule
— format the stored integer as RM at the edge. **Storage stays an integer minor
unit**; storing decimals reintroduces the float-rounding money bugs `money.ts`
exists to prevent. The drift to fix in batch 2 is the NAME (`_centi` / `_sen` /
`_cents` → one word), not the type.

## Batch 2 order (highest confusion first)

Money name · Salesperson · Delivery date · Customer ref · Item code · Warehouse ·
Debtor/Customer · Supplier/Creditor — then the med/low concepts. One concept =
one PR = one migration + the registry entry that retires the old spelling, so the
guard starts enforcing it the moment it lands.
