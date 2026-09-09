## The variant repair had no leg-height axis, so two purchase orders could not take the book's leg [low]

**Symptom.** The PO tally reports two documents differing on `leg height`, and
the tool that exists to copy a book value onto a migrated line cannot address
them. Measured, run 34336722458:

```
HC-PO-009652  leg height: DtlKey 877019 (ERP 5535-1A(RHF)): AutoCount "1"" vs ERP "(blank)"
              book Desc2: ...After push back align to seat/add 1inch leg
HC-PO-010146  leg height: DtlKey 924289 (ERP 5535-2A(LHF)): AutoCount "2"" vs ERP "(blank)"
              book Desc2: Size:30"/Col:CHINO-01/Bottom wrap nylon/+2" leg
```

**Root cause (traced, not guessed).** `repair-so-variant-from-book.mjs` knows two
axes, `colour` and seat, and its header says so: *"Correct a migrated line's
COLOUR or SEAT SIZE"*. `scripts/lib/variant-reconcile.mjs:278` compares a THIRD:

```js
{ key: "leg", label: "leg height", groups: ["bedframe", "sofa"], erpKeys: ["legHeight", "sofaLegHeight"] }
```

So the checker reports an axis the repair cannot write. Not a defect in either
file on its own — a gap between them.

**A live trap found while closing it.** The repair had **no validation of
`axis`**: anything that was not `"colour"` fell through to the scalar branch and
wrote `seatHeight`. An entry typed `"leg"` before this change would have stamped
a LEG measurement into the SEAT field, silently, and the tally would have gone on
reporting the leg difference while a new seat difference appeared. The axis is
now named and refused: `colour`, `seat`, `leg`, anything else skipped and
printed.

**Fix.** A `leg` axis: `pickAxisLeg()` reading `legHeight` then `sofaLegHeight` —
the same keys, in the same order, that `variant-reconcile.mjs` compares, taken
from that file rather than guessed, because **a repair that reads a different key
from the checker "fixes" a row the report goes on calling wrong**. The patch
writes `{ legHeight: '<n>"' }`, and the fresh-connection verification reads the
same picker back and names the axis it checked.

**What is NOT relaxed.** Every existing gate still applies to a `leg` entry: the
stale-list refusal (`erp_now` must still be what the row holds), the
build-disagreement refusal, the jsonb-shape refusal, and the downstream report.
All four entries added here carry `erp_now: ""` — the ERP is BLANK, so nothing of
ours is overwritten; the book states a value we never carried.

**Ref.** PR for `fix/variant-book-leg-axis`, 2026-09-09. Owner rule 2026-09-08:
「一律跟账本。除了sofa compartment而已啊」.
