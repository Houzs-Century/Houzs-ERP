> **ARCHIVED 2026-08-13.** Point-in-time review of `fix/so-cas-mandatory@92167619` (**2026-07-20**). That branch merged; SO version-CAS and the edit lease are live in `backend/src/scm/routes/mfg-sales-orders.ts` and `so-amendments.ts`. Kept as the review record. Kept for history; do not follow it as a current instruction.

# SO CAS / Lease Coverage Review

Reviewed branch: `fix/so-cas-mandatory@92167619`  
Review date: 2026-07-20  
Verdict: P0=0, P1=6 — not publish-ready as mandatory A–Z concurrency protection.

## Correctly protected foundation

- General SO header `PATCH` requires expected version CAS.
- Ordinary line add/update/delete require the active SO edit lease.
- Desktop and mobile composite-save paths acquire and release that lease.
- Focused backend tests 13/13, frontend tests 4/4, both typechecks and diff-check passed.

## P1 closure list

### 1. Special line mutation routes bypass the lease

Routes: price override, TBC update, TBC product swap, TBC sofa swap, photo upload/delete and stock-status. Require one central lease guard before any DB, R2 or audit write. Multi-row TBC/sofa/photo operations need transaction/RPC-safe mutation, not just a preflight read.

Acceptance: table-driven test per route; missing/wrong/expired token returns 409 with zero DB/R2/audit writes, correct token succeeds, a concurrent second token makes no write.

### 2. Frontend callers cannot satisfy the guard

Price override, stock-status and photo hooks do not accept/pass a lease. Use one shared versioned-mutation helper that acquires by loaded header version, performs the action, releases, advances the version ref and preserves user input on conflict. Lease token must be required in composite-only hook types.

Acceptance: request-spy coverage for override/stock/photo/TBC; action requests carry the acquired token, conflict performs no action and retains UI input.

### 3. Header/status/delete/system writers bypass the generation

Manual status, draft delete, manual/automatic allocation, delivery mirror and delivery-planning writers can change canonical SO state without the header version domain. Status must CAS expected status+version and bump version. Delete must require expected version and no active lease. Automatic/mirror writers need expected-state predicates and must bump the same generation when canonical header state changes.

Acceptance: concurrent status/status, delete/save, mirror/save and allocation/manual tests produce exactly one winner, one 409 and one set of side effects/audits.

### 4. Header CAS and followers are not atomic

The header commits before `apply_so_header_followers`; follower failure can return 409/500 after the header/version already changed. Move header CAS, lease acquisition and required followers into one PostgreSQL function/transaction with D1-equivalent atomic behavior.

Acceptance: failure injection at every follower leaves header, lines, vouchers/customer and version unchanged; every 409/428 is a zero-mutation result.

### 5. Amendment approval is an alternate non-transactional writer

Amendment approval independently snapshots, deletes/inserts/updates lines and headers, then bumps revision without SO lease/version CAS or one transaction. Lock amendment+SO, CAS amendment state and SO version/revision, snapshot/apply/recompute, bump both generations and advance amendment state in one transaction/RPC.

Acceptance: injected failure at each write rolls back all state; two approvals yield one commit and one 409 with one snapshot/revision.

### 6. Payment edit/delete needs row CAS

Payment POST idempotency is separate and should remain. Payment PATCH/DELETE require a per-payment version/updated-at CAS rather than the SO lease, because the payment ledger remains independently operable.

Acceptance: concurrent payment edit/edit and edit/delete yield one success and one 409; additive POST replay remains one row.

## P2 test debt

- Existing focused tests do not exercise actual line routes or bypass routes.
- The fake query `.or()` is a no-op and does not prove the PostgREST lease-acquire filter.
- Ordinary line hook lease parameters remain optional despite the backend requirement.
- Derived total recompute is safe only after every caller participates in the same serialization domain.

## Publish condition

Do not publish this branch as “mandatory CAS” until all six P1 sections pass their acceptance tests and a new independent review reports P0=0/P1=0. Narrow publication as an explicitly incomplete foundation is also disallowed because the currently protected paths can be invalidated by alternate writers.
