## Nobody could cancel a purchase order — the guard runs before the caller is known [high]
<!-- area: Purchase orders + GRN + PI -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-10, relaying purchasing: the Cancel button on a
purchase order answers

```
Could not cancel this PO
Could not identify who is cancelling this document.
```

Reported on `HC-PO-2609-0xx` (raised from `HC-SO-013346`) by **Sim, purchasing**.

**Two explanations ruled out first, both with evidence rather than reasoning.**

- **Not her session.** Sim (`public.users` id 84) is `active` and had written
  successfully the SAME DAY — three `scm.mfg_so_audit_log` rows under her name,
  latest `2026-09-10 00:46`. A context that resolves her on the sales-order
  routes is not an expired session.
- **Not her permissions.** The 403 is raised before any permission is read:
  `reasonOnlyCancel` refuses on `actorOf(c).id == null` and returns, so the
  approval / area gates below it never run.

**Root cause (traced).** `houzsUser` is set by each SUB-ROUTER's own
`supabaseAuth` (`scm/middleware/auth.ts`), not globally — `scm/index.ts:150`
states it: the area guards run *"before each sub-router's own supabaseAuth"*.
`cancelApprovalGuard` is mounted at the SCM level, ahead of the router:

```ts
scm.use("/mfg-purchase-orders/:id/cancel", cancelApprovalGuard("PO"));   // index.ts
scm.use("/mfg-purchase-orders/*", scmAreaGuard("scm.procurement.po", …));
scm.route("/mfg-purchase-orders", mfgPurchaseOrders);   // supabaseAuth lives in here
```

So when the guard runs, `houzsUser` does not exist yet and the real Houzs user is
still sitting in `user`. `actorOf` read only `houzsUser`, got `undefined`, and
answered `caller_unknown` — **to every caller, not just Sim.**

**THIS EXACT TRAP WAS PAID FOR ONCE ALREADY, on 2026-08-11.**
`lib/write-freeze.ts`'s `callerBypasses` carries the lesson in its own comment —
*"mounted at `scm.use('/*')`, which runs BEFORE each sub-router's own
`supabaseAuth` … Checking both makes the bypass correct at either point instead
of silently granting nobody if the mount order ever changes again — which is
exactly the bug this replaces"* — and reads both identities. `hasHouzsPerm`
(`lib/houzs-perms.ts:509` in this module's call path) dual-reads too, which is
why the PERMISSION half of this module worked. `actorOf` was the one function
that did not, and it was written after the lesson.

**Swept for the same shape rather than assumed unique.** Every middleware mounted
at the SCM level in `scm/index.ts`, and whether it reads `houzsUser`:

| middleware | reads `houzsUser` | verdict |
| --- | ---: | --- |
| `scmAreaGuard` (nearly every prefix) | 0 | safe — reads `user` |
| `migratedSoReadonly`, `migratedSoAmendmentReadonly` | 0 | safe — reads neither |
| `scmWriteFreeze` (mounted on `/*`) | 3 | safe — already dual-reads since 2026-08-11 |
| **`cancelApprovalGuard` / `cancelExecutionBypass`** | 8 | **this bug** |

So one module, and the two exports that share `actorOf` / `signerOf`.

**Fix.** One helper, `houzsIdentityOf`, used by both `actorOf` and `signerOf`:
`houzsUser` first, then `user` — **but `user` only while it is still the Houzs
shape (a numeric `public.users.id`).**

That gate is load-bearing and is why this is not a one-word change. This module's
header forbids `c.get('user').id` outright, for a real reason: AFTER the bridge
`user` is the pinned `scm.staff` identity — one uuid for everybody — and using it
as an actor id is how `mfg_so_audit_log` came to name the same person on every
row. Before the bridge it is the real integer id; after, it is a uuid that fails
`Number.isInteger`. So the same expression is correct at both points and cannot
resurrect the one-actor-for-everybody bug.

**Verification.**

- **Two tests written RED first**, in the mount-order block of
  `document-cancel-routes.test.ts`. On the unfixed tree the first fails with
  exactly the reported error (`expected 'caller_unknown' not to be
  'caller_unknown'`); after the fix the file is **23/23**.
- The second test is the guard on the fix: a context carrying ONLY the pinned
  `staff-uuid` identity must STILL answer 403 `caller_unknown`. It passes before
  and after, so a later "simplification" to a plain `?? c.get('user')` fails it.
- **Why the suite never caught this**: every existing test builds its app with
  `c.set('houzsUser', …)` AND `c.set('user', …)`. Production sets only the second
  at this mount point, so the harness encoded the assumption the bug violates.
  The new block builds the production shape instead.
- Backend light suite and `tsc --noEmit`: see the PR body for the run output.

**Not fixed here, and named so it is not lost:** whether the SO cancel path
(`scm.use("/mfg-sales-orders/:docNo/status", cancelApprovalGuard("SO"))`, mounted
the same way) was failing the same way in practice. It shares `actorOf`, so this
fix covers it; what is UNVERIFIED is whether anyone had hit it — no report exists.

**Ref.** `fix/cancel-guard-actor-identity`, 2026-09-10.
