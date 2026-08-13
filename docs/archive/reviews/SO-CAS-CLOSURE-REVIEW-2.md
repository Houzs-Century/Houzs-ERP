> **ARCHIVED 2026-08-13.** Point-in-time review of `fix/so-cas-mandatory@8baa8226` (**2026-07-21**), whose verdict was "never publish this commit". A later head was published; SO version-CAS and the edit lease are live in `backend/src/scm/routes/mfg-sales-orders.ts`. Kept as the review record — the verdict applies to that commit, not to `main`. Kept for history; do not follow it as a current instruction.

# SO Concurrency Closure — Independent Review 2

Reviewed commit: `fix/so-cas-mandatory@8baa8226`  
Review date: 2026-07-21  
Verdict: **P0=1, P1=7 — never publish this commit.**

The worktree later contained an uncommitted correction for the P0. That does not change the verdict for `8baa8226`; every item below must be re-reviewed on a new committed head.

## P0 — amendment claim code is in the wrong handler

`approve-so` references undefined `soVersion`, `applyToken` and `applyVersion`; the acquire block was inserted into `supplier-confirm`. Backend typecheck produced nine errors. Move the claim to `approve-so`, restore supplier-confirm semantics, and add route-level tests that compile and execute both handlers.

## P1 release blockers

1. **All amendment transitions need version CAS.** In `8baa8226`, supplier-confirm takes amendment+SO ten-minute leases, performs a non-CAS final write and does not release them. Reject/withdraw/send/approve-po also have no version CAS and can interleave/overwrite. Each transition must produce one winner and one 409 with no leaked lease.
2. **Amendment apply is not failure-atomic.** `so-revision.ts` performs separate snapshot/delete/insert/header/total/PWP operations, then tries the SO CAS bump. Any middle failure or final conflict leaves partial live state. Move the complete command into one PostgreSQL transaction/RPC with failure injection at every write boundary.
3. **Mobile bulk status omits version.** `MobileSalesOrders.tsx` sends only `{status}` while the backend requires version, making every bulk confirm return 428. Pass the loaded version and preserve/report per-row conflicts.
4. **Mobile staged photos omit the lease.** `MobileNewSO.tsx` raw photo POST does not send `X-SO-Edit-Lease`; create/edit staged photos therefore return 409. Route all photo sends through the versioned coordinator or explicitly pass the active lease.
5. **TBC commands are serialized but not atomic.** TBC update/swap/sofa use a read-only lease preflight followed by multi-table writes. The lease may expire during a long operation and a later error/best-effort PWP failure leaves partial state. Each command needs one database transaction/RPC; a preflight is insufficient.
6. **Payment domain is incomplete.** Payment PATCH returns 400 instead of 428 when version is missing. Per-row CAS prevents same-row loss but two concurrent changes to different rows can both pass their old total reads and overpay. Serialize the SO payment domain while preserving POST idempotency.
7. **Real PostgreSQL proof is missing.** Current migration/header/special tests are source-string or fake-query checks. Before release, execute 0161 in a disposable PostgreSQL database and run two-connection concurrency plus middle-statement failure injection for the SECURITY DEFINER RPCs.

## P2 follow-ups

- Status CAS may be followed by allocation generation bump, but the handler returns the earlier version. Return the final generation or force a detail refetch.
- Photo DELETE can leave an orphaned R2 blob after the DB key is removed; data/UI stays consistent, so a reaper is acceptable.

## Acceptance before review 3

- backend and frontend typechecks pass on the committed head;
- every amendment transition is versioned and releases claims;
- amendment and TBC command failures roll back all DB state;
- mobile bulk status and staged-photo requests carry the required version/lease;
- payment missing-version is 428 and different-row concurrent corrections cannot overpay;
- disposable-PG migration execution, two-connection concurrency and failure injection pass;
- a new independent review reports P0=0/P1=0.
