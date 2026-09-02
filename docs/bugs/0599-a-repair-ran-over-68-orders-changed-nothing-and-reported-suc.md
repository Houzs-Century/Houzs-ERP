## A repair ran over 68 orders, changed nothing, and reported success [high]

<!-- area: Sales orders + pricing -->

**Symptom.** `resync-so-delivered-status` was written to re-offer sales orders
whose goods are all out to the existing auto-advance. Its first APPLY against
production printed:

```
offered 68 order(s) to the auto-advance.
VERIFY (fresh connection, values not counts): 68 of 68 re-read
   ADVANCED to DELIVERED: 0
   RELEASED out of DELIVERED: 0
```

Exit code 0. Read plainly, that says *nothing needed fixing*. It is not what
happened: **not one of the 68 was ever judged.**

**Root cause (traced).** Three correct pieces composing into a silent no-op:

1. `syncSoDeliveredFromDo` reads coverage with a PostgREST **embedded select** —
   `delivery_order_items … delivery_orders!inner(status)`;
2. `scripts/lib/pgrest-shim.mjs` says in its own header that it implements **no
   embedded selects**, and throws `pgrest-shim GAP: embedded/aliased select … is
   not implemented`;
3. `syncSoDeliveredFromDo` wraps **each document in its own try/catch**, so a
   throw is swallowed and that document is quietly skipped.

68 throws, 68 skips, exit 0. Each piece is defensible alone: the function's
per-document catch stops one bad order killing a batch, and the shim is honest
about its gap. The composition is what lies.

**This is the CLAUDE.md shape verbatim** — *a verdict computed over nothing must
never read as a pass* — and it very nearly reached the owner as "checked, nothing
to fix". The only reason it did not is that the 0/0 CONTRADICTED an earlier
measurement (14 orders with every line dispatched), and a contradiction is a
finding rather than something to reconcile away.

**Fix.** The script now PRE-FLIGHTS that exact read outside the swallow and
`exit 3`s with the reason when it cannot execute:

```
REFUSED: the coverage read cannot execute through this client — pgrest-shim GAP: …
syncSoDeliveredFromDo swallows a throw per document, so running on would
silently change nothing and report success.
```

A repair that cannot do its work must say so, not finish quietly.

**What is STILL OPEN, and must not be read as closed.** The 7 orders are
unmoved and whether they *should* advance is unmeasured. Two candidate answers,
not yet separated:

* delivery RETURNS net against coverage inside `isSoFullyCovered`, and
  `probe-so-delivered-not-advanced` does not subtract them — so the probe may be
  OVERSTATING and the orders are genuinely short; or
* they are fully covered and only the swallowed read hid it.

The next step is a coverage read that RUNS — not another repair.

**Wider than this script.** Any script reaching a real service function through
`pgrest-shim` inherits this: the shim's gaps become silent skips wherever the
callee catches per item. `recompute-so-allocation.mjs` is the precedent that
works; it does not mean the pattern is safe for functions that swallow.

**Ref.** fix/delivered-status-probe, 2026-09-02.
