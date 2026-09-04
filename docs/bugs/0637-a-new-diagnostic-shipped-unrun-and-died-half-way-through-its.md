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

**Verified.** PENDING — being dispatched from the BRANCH before this merges,
which is the entry's own remedy. `node --check` parses the script.

**The lesson, and it is not "be careful".** A diagnostic is code, and code that
has never executed is not shipped. The cheapest guard is to dispatch it BEFORE
merging — a `workflow_dispatch` can be run from a branch — which costs one click
and would have turned this into an edit rather than a second PR.

**Ref.** fix/status-truth-enum-cast, 2026-09-04. Follows #2947, which added the
check.
