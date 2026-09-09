## A new diagnostic shipped unrun and died half way through its answer [low]

<!-- area: Sales orders + pricing -->

**Symptom.** `check-so-status-truth` was written to answer two owner questions
about the sales-order board, merged, and dispatched against production for the
first time (run 33849502977). It printed its first section — real board counts —
and then died:

```
function upper(scm.mfg_so_status) does not exist
```

**Root cause.** `scm.mfg_sales_orders.status` is an ENUM type, not text, so
`upper(status)` has no overload. Section 1 grouped by `status` without comparing
it and worked; every later section compares, and the first one to do so threw.
The delivery-order status is the same shape and had the same fault.

**Why it is worth an entry despite being a one-line cast.** This repo already
has the rule that would have caught it, added 2026-08-14 after the identical
class: **"a `workflow_dispatch` workflow is not shipped until it has been
dispatched once and reported success"** (CLAUDE.md). PR #2947 merged without a
single dispatch. The rule is prose, nothing enforces it, and it was broken by
somebody who had read the file that morning.

**And the half that makes it worse than a syntax error.** The check dies AFTER
printing a section of correct-looking numbers. A partial answer reads like an
answer — a reader skimming the log sees board counts and takes them for the
verdict, when the four sections that say what those counts MEAN never ran. That
is the same species as `docs/bugs/0632`: an output that asserts more than it
knows.

**Fix.** Every status comparison casts to text (`upper(status::text)`), including
the delivery-order one, and the script header names the trap so the next reader
does not re-find it.

**Verified.** Dispatched from the BRANCH before merging — the entry's own remedy —
run 33850492738, `success`, all five sections printed:

```
IN PRODUCTION WITH NO PROCESSING DATE: 1        (company 1, HC-SO-013361)
CONFIRMED BUT CARRYING A PROCESSING DATE: company 1 = 5, company 2 = 1
DELIVERY ORDERS THAT EXIST AT ALL: company 1 = 71, company 2 = 58
SHIPPED BUT NOT MARKED DELIVERED: 61
```

`node --check` parses the script.

**AND THE CHECK IMMEDIATELY EARNED ITSELF, by refuting the person who wrote it.**
Before running it I told the owner that Houzs Century's empty DELIVERED tile was
probably a tile over an empty table — no delivery orders had been migrated, so
the count could not be anything but zero. **Company 1 has 71 delivery orders.**
The tile is empty for a different reason, and 61 sales orders carry a live
delivery order while still sitting earlier on the board. That is a real finding
and it needs its own entry once the shape is measured; recorded here because the
refutation is the strongest argument for building the check rather than
reasoning.

**The lesson, and it is not "be careful".** A diagnostic is code, and code that
has never executed is not shipped.

**CORRECTED 2026-09-04, hours later, by trying it.** This entry first said the
guard is to dispatch it from the branch before merging. That works only for a
workflow whose FILE IS ALREADY ON THE DEFAULT BRANCH — GitHub answers
`HTTP 404: workflow <name>.yml not found on the default branch` for a brand-new
one, whatever `--ref` says. So a NEW workflow cannot be proven before its first
merge, by anyone, and the honest procedure is: merge it, dispatch it immediately,
and treat the first run as part of shipping rather than as a later step. Editing
an EXISTING workflow's script is the case the branch dispatch does cover, and
that is what it should be used for.

**Ref.** fix/status-truth-enum-cast, 2026-09-04. Follows #2947, which added the
check.
