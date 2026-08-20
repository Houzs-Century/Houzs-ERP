## A repair that writes four production columns needed one environment variable, and checked its own work on the session that did the writing [high]

**Symptom** — `backend/scripts/repair-migrated-po-lines.mjs` writes
`so_item_id`, `delivery_date` and `linked_ac_dtlkey` on
`scm.purchase_order_items` and `expected_at` on `scm.purchase_orders`. Its
entire apply gate was `APPLY=1`. No confirmation phrase, and no verification
that re-read the rows afterwards.

**Root cause** — two habits this repo already pays for:

1. **One variable is the same keystroke whether it is meant or mistyped.** Every
   other gated repair here requires `CONFIRM="I HAVE REVIEWED THE DRY-RUN"`;
   this one predates that shape and was never brought forward.
2. **The writing session is the worst witness that a write landed.** The script
   reported the counts its own UPDATEs returned and stopped there. On
   2026-08-13 that exact reasoning reported "written: 7 of 7" over seven rows
   that had been turned into jsonb STRINGS — the count was right and the data
   was wrong. A count is not a shape.

**Found by** — `scripts/check-release-discipline.mjs`, the gate added in this
PR, on its first run against the tree. It was not reported by a person.

**Fix** — the apply path now requires the spelled-out CONFIRM phrase and exits
2 without it; the workflow gained a matching `confirm` input wired to both the
staging and prod jobs. After the write the script opens a SECOND connection,
reads the rows back, and asserts the VALUES it intended are the values present
(and that no header it filled is still blank), failing the run when they are
not.

**Class** — *a gate that only counts*, docs/bug-classes.md. The check that
caught it is now in CI, so a new write script cannot land without both halves.

**Ref** - `release-discipline`, PR #2138, 2026-08-14
