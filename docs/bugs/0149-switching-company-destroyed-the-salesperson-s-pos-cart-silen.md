## Switching company destroyed the salesperson's POS cart, silently [high]

**Symptom** - a salesperson who works both companies builds a Houzs POS cart,
switches to 2990, saves anything there, switches back — the Houzs cart is empty.
No error at any step. Indistinguishable from "I never saved it", which is why it
was never reported as a bug.

**Root cause - the KEY, not the scoping.** `scm.pos_carts` came from the 2990
import keyed `staff_id uuid PRIMARY KEY`
(`scripts/scm-schema/2990s-full-schema.sql:930`). Migration 0100 added
`company_id` so the merged backend could scope carts per company — its own header
says carts "must be company-scoped ... like every other per-company module" — and
left the PRIMARY KEY untouched. A column was added; the key was not. The table
therefore still held exactly ONE row per salesperson across both companies, while
`routes/pos-cart.ts` read it with `scopeToCompany` and wrote it with
`onConflict: 'staff_id'`. The 2990 save upserted onto the Houzs row: `lines`
replaced, `company_id` restamped to 2. The scoped Houzs GET then matched nothing.

**Why it looked handled** - `company_id` is present on the table, stamped on every
write, and filtered on every read. Everything you can see in the route file is
correct. Only the DDL says otherwise.

**Fix** - migration `0284_scm_pos_cart_company_key.sql` [renumbered]: backfill NULL
`company_id` to HOUZS, `SET NOT NULL`, then drop the single-column PK and add
`PRIMARY KEY (staff_id, company_id)`. `pos-cart.ts` upserts
`onConflict: 'staff_id,company_id'` **in the same change** — per the
`special_addons` lesson below, a constraint that no longer matches the caller's
`onConflict` turns every save into a `42P10` 500, so the two must move together.
The route now refuses a save with a plain-language 409 when the active company is
unresolved, instead of writing a company-less row it can no longer key.

**Verification** - `tests-pg/posCartCompanyKey.pg.test.ts`, 9 cases against real
Postgres: the pre-migration key is asserted to be the single column FIRST (so the
fixture cannot drift into already-fixed and pass vacuously), then the re-key, the
existing cart surviving it, two companies holding a cart for the same staff, the
route's exact `ON CONFLICT` statement leaving the other company's cart
byte-identical, re-run idempotency, the NULL backfill, and NOT NULL. **These ran
SKIPPED locally — this machine has no Docker and no `TEST_DATABASE_URL`. They
execute on CI's postgres:16 service container. Nothing here has been observed
green yet.**

**Ref** - `fix/company-scope-sweep`, 2026-08-13.
