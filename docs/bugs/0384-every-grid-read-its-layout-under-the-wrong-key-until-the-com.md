## Every grid read its layout under the wrong key until the company arrived [medium]

**Symptom.** Owner, 2026-08-19: *"Delivery planning 一直会自动 reset layout"* — a
saved column arrangement gone on every open.

**Root cause (traced, not guessed).** `DataGrid` seeds its layout with

```ts
const [storedLayout, setLayoutRaw] = useState<Layout>(
  () => readDataGridLayout(scopedStorageKey, legacyStorageKey));
```

`useState`'s initialiser runs ONCE, at mount, with whatever `scopedStorageKey`
was at first paint — and that key is company-scoped:
`activeCompany != null ? \`${storageKey}::c${activeCompany}\` : storageKey`
(the per-tenant bucketing added 2026-07-24 for "在 2990 改 column 会影响 Houzs").

**The company is not known at first paint.** `adoptActiveCompanyForUser` runs
when `/auth/me` returns; on a tab with no `?company=` seed it flips the value
from null to the user's durable pick and `emit()`s. So the grid READ the
unscoped `dg-<key>` — usually empty, i.e. default columns — while every later
WRITE went to `dg-<key>::c<company>`, because `scopedStorageKey` was current by
then. Nothing was ever lost: the arrangement sat in the scoped key that nothing
read back.

**Fix.** Re-read when the key moves, guarded by the key it was last read for so
it fires only on a genuine change (company resolving, or a tenant switch) and
never re-reads over an edit made under the same key.

**Why it looked like a Delivery Planning bug.** That page lists both tenants and
is the one the owner arranges most, but the defect is in `DataGrid` — every grid
in the app had it.

**Proven, not assumed.** Removing the effect turns 2 of the 3 new tests red
(`DataGridLayoutCompanyKey.test.tsx`); restoring it makes them green. The third
pins the guard: a same-key re-render must NOT re-read, or an edit on screen
would be clobbered.

**Ref.** PR (branch `fix/datagrid-layout-company-key`), 2026-08-19.
