# Module: Roles and the flat permission catalogue

Per-module technical doc for the **flat permission** system — the `x.y` strings
like `projects.read` that `requirePermission()` gates on, where they are
declared, how a role grant becomes a session capability, and the one failure
mode this system keeps producing.

Written 2026-08-20 because it did not exist. `docs/modules/team-members.md`
covers System > Team > **Members** and says explicitly that the Roles tab is a
separate concern; nothing covered that concern, which is part of how the defect
below survived. `docs/PERMISSION-MATRIX.md` is a different system again — it is
the PAGE catalogue (`services/pageAccess.ts` `PAGES[]`, granted per POSITION),
not this one.

> **Line numbers here are INDICATIVE, not authoritative.** Resolve a route to
> its current line with the generated artifact, which cannot go stale:
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

---

## 1. The two systems, and which is which

| | flat permissions (THIS doc) | page access |
|---|---|---|
| looks like | `projects.read`, `scm.access` | `orders.balance` at level `V`/`E`/`F` |
| declared in | `backend/src/services/permissions.ts` `PERMISSIONS[]` | `backend/src/services/pageAccess.ts` `PAGES[]` |
| granted per | **ROLE** (`roles.permissions`, a JSON array) | **POSITION** (`position_page_access`) |
| gates | API capability — `requirePermission("x")` | which MENUS and pages exist |
| admin UI | Team > **Roles** (`frontend/src/pages/Roles.tsx`) | Team > **Positions** |
| spec doc | this file | `docs/PERMISSION-MATRIX.md` |

Positions gate menus, roles gate permissions. A position grant is **not**
backfilled into a flat key, which is why several routes carry an
`OrSalesDirector` / `OrSalesView` carve-out — see `team-members.md`.

## 2. `PERMISSIONS[]` is the only thing that makes a key real

`backend/src/services/permissions.ts`:

```
PERMISSIONS[]  ->  PERMISSION_KEYS (a Set)  ->  isValidPermission(key)
```

`isValidPermission` returns true for `"*"` (the Owner wildcard) or a member of
that Set. **Three separate things depend on it, and all three fail silently for
a key that is not declared:**

| where | what it does with an undeclared key |
|---|---|
| `parsePermissions()` (session hydration, `services/auth.ts::hydrateAuthUser`) | filters it OUT of the user's capability set |
| `POST /api/roles` `:86` and `PATCH /api/roles/:id` `:169` | `.filter(isValidPermission)` — refuses to store it |
| `GET /api/roles/permissions` -> `Roles.tsx` | never renders a checkbox for it |

So an undeclared key cannot be granted through the UI, cannot be stored through
the API, and is thrown away if it is already in the row. **None of those three
produces a log, an error, or anything a human sees.**

**`scm.payment_voucher.check`** (the owner's four layers, 2026-09-02) is the
FIRST of the two yeses — checking a prepared voucher locks it and reserves it
against Daily Bank's available money; a checker may also reject back to
draft (docs/modules/payment-voucher.md §0b). Separate key from approve on
purpose (可以同一个人，可以不同人): the owner may hand the first yes to the
finance manager and keep the second. Granted to **no** seed role.

**`scm.payment_voucher.approve`** (phase 3, 2026-08-28; re-scoped by the four
layers 2026-09-02) is the SECOND yes — and since the four layers it POSTS the
GL in the same request, so this key also opens the standalone post door
(docs/modules/payment-voucher.md §0b). Declared like every key, deliberately granted to **no** seed role: only
`*` (Owner / IT Admin) can approve until the owner assigns it to a position.

**`announcements.approve`** (approval workflow, owner 2026-09-06, mig
`20260906T1509`) is the announcements approval desk: every notice — the MD's
own included — is published by this holder's Approve click (`POST
/api/announcements/:id/approve` / `:id/reject`), which also mints the
`[DEPT]-ANN-[YYMM]-[NNNN]` reference number. The verb value is `approve` (the
catalogue's `verb` union gained it). Conferred by `*` like any other key, but
the approval-needed bell notice goes only to roles that LIST the key
(`usersHoldingPermission` excludes the wildcard) — so give it to the MD's role
rather than relying on Owner. Granted to **no** seed role. Contract:
docs/modules/announcements.md §3 "Approval workflow".

`EXPLICIT_APPROVAL_KEYS` is a separate rule on top: the four checklist-approval
keys are NOT conferred by `*`. `holdsChecklistApproval()` is the reader; the
Owner role carries them explicitly instead.

## 3. The failure mode this system produces

**A key with a live gate but no catalogue entry is a permission nobody can
grant, and nothing says so.**

That is not hypothetical. `routes/assr.ts` gated `POST /api/assr/:id/approve` on
`service_cases.approve` while the key was absent from `PERMISSIONS[]`. Result:
cost approval was accidentally Owner/IT-only (only `*` got through), and no
amount of clicking in Team > Positions could change it. Declared 2026-08-13;
the comment above that entry is the trace.

**The inverse also happens:** a key granted in a stored role row that gates
nothing. Twenty-two of those existed as of 2026-08-20.

## 4. `UNDECLARED_ROLE_KEYS` — the ledger, and the two ways to be undeclared

Every key granted by a role in this repo but absent from `PERMISSIONS[]` is
listed in `UNDECLARED_ROLE_KEYS` with a `status` and a `why`.

**It is a ledger, not an allow-list. Nothing reads it to decide access** — a key
listed there is still dropped exactly as before. It exists so the drop is a
written decision rather than silence, and so a gate can fail on an unclassified
key.

| status | meaning | count at 2026-08-20 |
|---|---|---|
| `legacy-closed` | a REAL gate exists and the key is left ungrantable ON PURPOSE. **Declaring one OPENS access that is currently shut.** | 5 |
| `retired` | the key gates nothing anywhere; the module it belonged to is gone. Declaring one adds a checkbox that grants nothing. | 17 |

The five `legacy-closed` keys are the AutoCount UDF read keys — `sales_orders.read`,
`delivery_orders.read`, `purchase_orders.read`, `balance.read`, `overdue.read` —
each a live `requirePermission` in `backend/src/routes/udf.ts:26-32`, whose header
states the closure is deliberate.

The 17 `retired` keys come from the dead D1 role seeds (`db/schema.sql`,
`db/migrations/009_roles_fleet.sql`, `db/migrations/014_qms_roles.sql`) and belong
to modules that no longer exist: there is no `/api/trips`, no `/api/planner` and no
top-level `/api/reports` mount in `src/index.ts`, `public.trips` was dropped by
mig 0055, and the customer/supplier portals that DO exist are gated by CAPABILITY
TOKENS (`middleware/supplierTrack.ts`), never by a session permission.

### Deciding a NEW undeclared key

```bash
grep -rF '"<key>"' backend/src frontend/src --include=*.ts --include=*.tsx
```

- **Any `requirePermission` / `requireAnyPermission` / `can()` hit** -> the key
  has a live gate. It belongs in `PERMISSIONS[]`. Adding it to the ledger instead
  leaves the gate ungrantable, which is the `service_cases.approve` bug.
- **Hits only in a role-seed `INSERT` or a comment** -> it gates nothing. Ledger,
  with the evidence in its `why`.

Two keys need extra care: `sales_orders.write` and `delivery_orders.write`. Their
`.read` twins are `legacy-closed`, so declaring a `.write` would create a grantable
write key whose read counterpart is deliberately shut.

## 5. How the drop is made visible

Three layers, because the silence had three places to hide.

| layer | mechanism | catches |
|---|---|---|
| **build** | `backend/tests/permissionCatalogueDrift.test.ts` re-derives the dropped set from every role grant in the tree and fails when a key is in neither `PERMISSIONS[]` nor the ledger | a new grant landing in a seed. LIGHT project, so it runs in `test:light` under `backend-typecheck` — a REQUIRED context, so it blocks the merge and not just the deploy |
| **API** | `droppedPermissions()` is the complement of `parsePermissions()`; `GET /api/roles` returns it as `unknown_permissions` per role | a key present in the LIVE DB that is in no file — the case the build gate structurally cannot see |
| **UI** | `frontend/src/pages/Roles.tsx` renders that array under the role's permission count | an admin reading Team > Roles, who previously saw a clean row |

`unknown_permissions` is **optional** on the `Role` type: absent means "this
server did not say", never "there are none".

## 6. Surface

| method | path | gate |
|---|---|---|
| GET | `/api/roles/permissions` | `roles.read` — returns `PERMISSIONS[]`, the checkbox source |
| GET | `/api/roles` | `roles.read` or Sales Director — returns `permissions` + **`unknown_permissions`** + `member_count` |
| POST | `/api/roles` | `roles.manage` — body permissions are `.filter(isValidPermission)`d |
| PATCH | `/api/roles/:id` | `roles.manage` — same filter |
| DELETE | `/api/roles/:id` | `roles.manage` |

Tables: `roles` (`permissions` is a JSON string array), `users.role_id`,
`role_page_access` (the OTHER system, page level per role).

## 7. Traps

1. **There is NO frontend permission registry, and there must not be one.**
   `frontend/src/auth/capabilities.ts` states the rule: the client holds
   booleans the server already decided. `permissions.ts`'s header pointed at a
   "frontend permission registry" until 2026-08-20 — a pointer at something that
   has never existed, which invites exactly the second copy the ruling forbids.
2. **Two scripts parse role permissions with their OWN parser and therefore SEE
   what the app drops.** `census-service-case-visibility.mjs:78-90` deliberately
   omits the `isValidPermission` filter, so its model of a user's permissions is
   WIDER than the running system's — do not read its output as what a user
   actually holds. `backfill-role-page-access.mjs` (`parsePerms`) does the same,
   and it is the reason "dropped" must not be read as "never had an effect": mig
   073's `role_page_access` rows were DERIVED from these keys, so `trips.manage`
   / `planner.run` handed a role FULL logistics, `sales_orders.write` FULL
   orders and `delivery_orders.write` FULL delivery orders. That script is
   one-shot and has already run, so those page grants are now stored rows
   standing on keys nothing else honours.
3. **A `*` holder is not a normal user.** `hasPermission` short-circuits on `*`,
   so a wildcard caller passes every gate and can never reproduce a
   missing-catalogue-entry bug. `service_cases.approve` went unnoticed for weeks
   for exactly this reason.
4. **The ledger is a ratchet.** A key that later gains a real gate must be
   DECLARED and REMOVED from the ledger in the same change; the drift test fails
   on a ledger entry that is also in `PERMISSIONS[]`.
