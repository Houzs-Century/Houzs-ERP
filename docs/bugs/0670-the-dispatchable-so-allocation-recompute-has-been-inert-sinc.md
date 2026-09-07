## The dispatchable SO allocation recompute has been inert since 2026-08-16 and exited 0 [high]

**Symptom.** `Recompute SO stock allocation (DRY-RUN gated)` run 34127825188
(2026-09-07, prod, GLOBAL scope) concluded **success** and printed
`(no line changed — the projection already matches the allocator's own answer;
idempotent re-run lands here)` and `(no header changed)`. Read as written, that
says a recompute would change nothing — which is the answer the go-live needed
about the 308 orders whose stock status disagrees with AutoCount, and 92 of them
where the ERP is blank. It is not what happened. Nine lines earlier the same run
says:

```
[so-allocation] recompute failed: Error: allocation DO-line load failed: pgrest-shim: unsafe identifier "so.status"
canonical result: ok=false linesFlipped=0 ordersAdvanced=0 ordersRegressed=0 reason=allocation DO-line load failed: pgrest-shim: unsafe identifier "so.status"
```

The function never ran. The two "nothing changed" sections were comparing a
snapshot with itself.

**Root cause (traced).** Two things, and only together do they produce a green
run over a dead check.

1. `backend/scripts/lib/pgrest-shim.mjs` is documented as NOT a general client —
   "no embedded selects (`a, rel(b)`)" — and `q()` rejects any identifier that is
   not `^[a-z_][a-z0-9_]*$`. `recomputeSoStockAllocation` filters on an EMBED:
   `.not('so.status', 'in', SO_TERMINAL_STATES_PGREST)` over
   `.select('id, so:mfg_sales_orders!inner(status), do_items:delivery_order_items!inner(...)')`
   (`backend/src/scm/lib/so-stock-allocation.ts`, two call sites). That filter
   arrived with `24b379034` (#2298, 2026-08-16, *"the SO sweep asked for 83 rows
   with 71 requests — invert the read"*) — verified with
   `git log -S".not('so.status', 'in', SO_TERMINAL_STATES_PGREST)" --reverse`,
   which returns that commit and no earlier one. The shim was built 2026-08-10
   for the pre-inversion shape; nothing tied the two together, so the
   dispatchable recompute has been unable to run the canonical function since
   that merge.
2. The script's only non-zero exit was `sb.__gaps.length > 0`, and `__gaps` is
   appended by the shim's own `gap()` path. `q()` THROWS directly, so the gap
   list stayed empty and the run exited 0 with `ok=false`.

**Fix.** `recompute-so-allocation.mjs` now exits 1 when `result.ok === false`,
printing the refusal reason and the sentence that the per-line section is not
evidence. That does not make the recompute work — the shim still cannot serve an
embedded read, and growing it to do so is a separate, tested change — but a
refusal can no longer be read as "nothing to do", which is what it was being
read as during the go-live tally.

This is a STOPGAP and is labelled one. The root fix is either (a) grow the shim
to translate one-level `!inner` embeds and dotted filter columns into SQL joins,
with tests in `backend/tests/pgrestShim.node.mjs`, or (b) drive the recompute
through the Worker, which holds real PostgREST credentials, instead of through
Actions. (a) keeps the workflow; (b) deletes it. Neither is done here.

**Ref.** chore/golive-last-gaps-2026-09-07, 2026-09-07.
