## The consignment salesperson was never filled in, and a non-admin was offered "null (null)" [high]

<!-- area: Staff, salesperson, attribution -->

**白话.** 开寄售单那张画面的 Salesperson，**从来不会自动带出开单的人** —— 那段自动
填的程式码判断的是一个**永远是 null 的东西**，所以一次都没执行过。更难看的是：没有
「改别人销售员」权限的人，那个下拉里只会出现**一个选项，字面上写着 `null (null)`**，
选了等于没选。销售单不会这样，因为它是走另一条备援链的。

**Symptom.** Found while checking, at the owner's instruction
（「你回去查过这个源代码吗？要不然我担心你做错、做歪了」）, whether the rules he
set actually hold everywhere. Not reported from the floor — which fits: the
field is only *visibly* broken for a user without `scm.so.attribute_other`, and
for everyone else it is merely always blank.

**Root cause (traced).** `frontend/src/vendor/scm/lib/auth.ts:60` — the vendored
2990 auth bridge — returns, for EVERY Houzs user:

```ts
return { staff: { id: null, role, name: null, staffCode: null, venueId: null } };
```

It exists so the MRP page can ask `isAdminLevel(staff?.role)` without mounting
2990's supabase-coupled AuthProvider. `role` is the only field it computes. The
file says so; it is still easy to read past, because `useAuth().staff` is never
null — only its fields are — so every truthiness check on the object passes and
every optional chain silently yields null.

`ConsignmentOrderNew.tsx` read past it twice:

- `:344` `if (!currentStaff?.id) return;` guarded the salesperson seed. Always
  true, so the seed never ran and Salesperson stayed empty on every consignment
  order.
- `:690` the non-admin branch of the picker built its single option from
  `currentStaff`, so it rendered `label: "null (null)"` with `value: ''`.
- `:355` `?? currentStaff?.venueId` sat in the venue fallback, where it could
  never contribute.

`SalesOrderNew` and `SalesOrderDetail` pass the same fields into
`resolveSelfStaff` as ONE RUNG of a ladder that also carries the real Houzs user
(`user_id` → bridge staff id → email → name). The nulls simply miss and the
ladder falls through — which is why those pages never showed this.

**Fix.** `ConsignmentOrderNew` now resolves its person through the same shared
`resolveSelfStaff` ladder, seeds from that, renders the single non-admin option
from that, and drops the venue term that could never fire.
`GET /staff/pickable` always carries the caller's own row whatever narrowing it
applied (`docs/bugs/0504-…`, the always-holds rule), so the ladder resolves on
every account.

**Guard.** `frontend/src/vendor/scm/lib/bridgeStaffIsNotAPerson.test.ts` pins
the bridge's contract (every field but `role` is a hard-coded null) and, for
each page that consumes it, that nothing is LABELLED from `currentStaff`, no
seed is GATED on `currentStaff?.id`, and the person is resolved through
`resolveSelfStaff`. Proved RED against `origin/main`'s page: 3 failed, naming
exactly the three reads above; 14 pass with the fix.

**A correction, recorded because it was told to the owner.** The agent that
opened #2635 reported this site as "seeds salesperson from the pinned 2990
system row — possible 'System' attribution on every consignment order", and that
was relayed to him. It is wrong: the bridge's id is a hard-coded null, not a
system row, so nothing was ever attributed to anyone — the field was simply
blank. Same class as the two false statements #2637 left in
`so-variant-cascade.ts`
(`docs/bugs/0508-the-consignment-order-ran-its-own-copy-of-the-variant-cascad.md`):
an agent's plausible reading, reported as a finding, believed because it sounded
specific.
