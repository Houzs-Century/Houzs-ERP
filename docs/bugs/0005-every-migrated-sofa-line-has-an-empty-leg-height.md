## Every migrated sofa line has an EMPTY Leg Height [medium]

**Symptom** — Open any sofa line that came in from AutoCount and the Leg Height
picker reads "Select...". Seat depth, fabric and compartment are all filled; the
leg alone is blank, on every single migrated line.

**Root cause** — Nothing ever writes `variants.legHeight` for a sofa.
`parse-sofa.mjs` (lines 52-55) deliberately lifts a leg PHRASE out of Desc2 and
pushes it into `specials` — "leg text never sets a size, it rides as a special
so the factory sheet still shows the request" — and neither
`import-ac-outstanding-so.mjs` nor the PO importers put a leg key in the
variants object they build. So the axis is absent, not empty-because-unknown.
The gap went unseen because the sofa Leg Height axis is `required: false` in
`so-variant-rule.ts`, and it is `required: false` for exactly the opposite
reason — the comment there says the axis "always defaults to the Default option
(RM 0.00) at create/edit time, so it is never empty". That premise held for
POS/coordinator-created lines and was never true for imported ones, so the one
gate that would have caught it had been told to look away.

**Fix** — `backfill-sofa-leg-default.mjs` + `backfill-sofa-leg-default.yml`
(dry-run default, `apply=1` writes) fills `variants.legHeight` with the master
config pool's own "Default" entry across `scm.mfg_sales_order_items` and
`scm.purchase_order_items`, for company 1 sofa lines whose parent carries
`linked_ac_docno`. Owner's ruling, `docs/sofa-import-handoff.md` section 2.5:
"脚全部找不到就直接选 default". Two refusals are built in: a line that already
carries `legHeight` or `sofaLegHeight` is never overwritten, and a line whose
own text names a leg ("Leg Change 101Middle Leg(8')", "FULLY COVER NO LEG",
`6” wooden leg`) is left alone and reported by phrase with its document numbers,
because the source said something specific and a default would erase it. An inch
height counts as a leg only INSIDE the leg phrase — a bare `28"` in a sofa Desc2
is the seat depth.

**The class, for next time** — an axis marked not-required "because it is always
pre-filled" is a claim about a write path, and it only covers the write paths
that existed when it was written. An importer is a new write path.

**Ref** — 2026-08-10, PR fix/sofa-leg-default.
