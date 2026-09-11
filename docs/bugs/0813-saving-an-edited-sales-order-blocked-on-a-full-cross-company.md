## Saving an edited Sales Order blocked on a full cross-company stock-allocation recompute per line, so a multi-line save took tens of seconds and had to be retried [high]

<!-- area: Sales orders + pricing -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-11: *"sales order after edit when saving need
continue save few time and wait very long."* Editing an existing Sales Order and
pressing Save spun for a long time, often failed, and the operator had to press
Save several times before it went through.

**Root cause (traced).** A single "save edited SO" fans out to one HTTP write per
changed row — the frontend chain is reserve-header -> deletes -> line edits -> add
-> header (`frontend/src/pages/scm-v2/SalesOrderDetail.tsx:913`). Every SO LINE
write then `await`ed a GLOBAL stock-allocation recompute before returning its
response:

- add, sofa branch — `backend/src/scm/routes/mfg-sales-orders.ts:8156`
- add, non-sofa branch — `:8213`
- edit — `:8647`
- delete — `:8757`

`recomputeSoStockAllocation` is deliberately NOT scoped to the one order: it
pages the whole active-SO corpus + all their lines + all ~1,100 products + DO /
DR / inventory / PO links (`backend/src/scm/lib/so-stock-allocation.ts:109`
onward). The module's own note measures the cost: *"~25-30 sequential round trips
at roughly 300ms each"* (`backend/src/scm/lib/stock-allocation-job.ts`), i.e.
~8 seconds, and it states plainly that `scopeToDocNo` narrows the WRITES only —
the expensive reads run regardless. So even a one-line edit paid ~8s; a
multi-line save paid it once per phase (deletes / edits / add each trigger a
sweep; the single-flight lock in `so-stock-allocation.ts:80` lets one run per
parallel batch and the rest skip), stacking into tens of seconds — long enough
for a request to time out, reject the whole `Promise.all`, and leave the operator
pressing Save again (each retry re-takes the edit lease / header version, so a
slow attempt still in flight also 409s the next one). The SO header PATCH had
already been moved off this blocking path to `deferAllocationRecompute` on
2026-08-10 (`:7315`); the three line routes were the half of the edit-save flow
still awaiting inline.

**Fix.** The four SO line call sites now call `deferAllocationRecompute(c, sb,
...)` — the same best-effort sweep under `ctx.waitUntil`, returning the response
before it settles — exactly as the header PATCH already does. The write is
committed first, so the deferred sweep sees the new state; the only cost is that
READY / PENDING badges can lag one sweep and self-correct on the next read.
Durability is unchanged (still best-effort, no queue row) — only latency drops,
so this is a DEFERRED move, not a DURABLE one.

Pinned by `backend/tests/stockAllocationDurabilityScope.test.ts`, the durability
ratchet: `mfg-sales-orders.ts` moves 7 -> 3 inline and 1 -> 5 deferred, totals
31 -> 27 inline and 1 -> 5 deferred (inline + deferred still 32 of 38, durable
still 6 — the four sites changed columns, they were not removed). The ratchet
asserts exact per-module counts, so the source change alone turns it red until
the ledger is updated; green (16/16) after. The remaining 3 inline SO sites
(status / proceed / cancel) and the broader inline population are tracked for
DURABLE conversion in `docs/ALLOCATION-DURABILITY-PLAN.md`.

**Ref.** `worktree-fix-so-edit-defer-allocation`, 2026-09-11.
