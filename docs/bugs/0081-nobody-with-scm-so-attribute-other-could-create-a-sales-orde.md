## Nobody with `scm.so.attribute_other` could create a Sales Order, and the picker they were told to use was empty [high]

**Symptom** - the owner (IT Admin) fills in a new Sales Order, the Salesperson
field reads "Lim (me)", and **Create Sales Order** returns
`422 A salesperson must be assigned before this order can be confirmed`. The
Salesperson dropdown contains exactly one option - that same "Lim (me)" - so
there is nothing else to pick and no way out of the refusal.

**Root cause (traced, not guessed)** - two independent faults that happen to
alias each other, both measured against PRODUCTION on 2026-08-12.

**(1) The roster is joined on a column that is almost always empty.**
`filteredStaffList` cross-referenced `scm.staff.email` against the emails of
Houzs users in the Sales / Management departments. On production:

```
scm.staff: 140 rows · 18 with an email · 102 with user_id
active rows: 102 · 98 of them have NO email at all
Houzs users in Sales/Management: 47
staff rows whose email matches one of them: 0
```

Zero. The filter's "falls open" guard only fires when the ALLOWED set is empty,
and it was not empty (47 users have emails) - so the filter ran, matched nothing,
and emptied the picker. `staff.user_id` is the link that does exist, and
`staff.ts` has always exposed it as `userId`; the frontend's `StaffRow` interface
simply never declared it.

**(2) An omitted salespersonId stamped NULL instead of the caller.**
`selfStaffMatch` looked the caller up by staff id, then email, then name - all
three against that now-empty list - so it missed, and the page rendered the
UI-only `__self__` sentinel. `SalesOrderNew.tsx:1555` drops that sentinel on
submit, *"so the backend keeps its own caller-based resolution rather than
choking on a fake id"*. But `mfg-sales-orders.ts:3427` read
`canAttributeOther ? (body.salespersonId ?? null) : callerStaffId` - the
caller-based resolution existed only on the self-scoped branch. An omitted id
therefore stamped NULL, and `collectSoConfirmProblems` refused the order.

**The cohort is inverted, which is why it went unreported:** a self-scoped
salesperson hits `: callerStaffId` and is fine. Only a caller holding
`scm.so.attribute_other` - owner and IT Admin, via `*` - could not create a
confirmed order at all.

**The IT Admin DOES have a staff row.** `Lim`, `user_id = 4`, active, `email`
NULL. The backend's `resolveOwnerStaffId` joins on `staff.user_id` and finds it;
only the frontend's three lookups missed it. The page was telling the user they
had no sales identity while the backend could see one.

**Fix** - match on `user_id` on both sides. `StaffRow` declares `userId`;
`selfStaffMatch` tries it FIRST (the same key the backend resolves by, so the two
can no longer disagree about whether the caller has a staff row); the roster
filter admits a staff row whose `userId` is in the Sales/Management cohort, with
email kept as the fallback for the 18 rows that carry one. And the create path
falls back to `callerStaffId` when `salespersonId` is ABSENT - an explicit null
still means null. That is not the phantom risk the surrounding comment guards
against: `resolveOwnerStaffId` returns the caller's REAL staff row, never the
bridge's pinned SYSTEM uuid.

**Correction 2026-08-13 (audit) - "an explicit null still means null" is not what
the code does.** The stamp is
`canAttributeOther ? ((body.salespersonId as string) ?? callerStaffId ?? null) : callerStaffId`
(`mfg-sales-orders.ts:3537`). `??` is nullish coalescing: it falls back on `null`
AND on `undefined`, and `body` is a raw `c.req.json()` bag (`:3299`) with no zod
step that could distinguish the two. So an explicit `null` falls back to the
caller as well. That is load-bearing rather than academic - MOBILE sends an
explicit null. `MobileNewSO.tsx:1090` maps its `__self__` sentinel to `null`,
while desktop `SalesOrderNew.tsx:1619` sends `undefined` (dropped by
JSON.stringify). Both work; only one of them works for the reason this entry
gives. The same wrong distinction is written into the route comment at `:3535`.

**Only the DESKTOP surface got the user_id key.** `MobileNewSO.tsx:1179`'s
`selfStaffMatch` still matches by email, then name - no `userId`, no staff id -
so the IT Admin (email NULL) still misses there and the page still seeds the
`__self__` sentinel. Mobile never had the roster filter (no `filteredStaffList`),
so its picker is not empty and the admin can pick themselves by hand; and the
backend fallback above means a submitted null is stamped correctly. But the
mobile confirm gate `!outgoingSalespersonId && !selfStaffMatch`
(`MobileNewSO.tsx:1772`) fires on exactly that state, so an attribute_other
caller who does not re-pick is still refused - client-side now, with a clearer
sentence. Desktop and mobile are one product (CLAUDE.md); this pair is still
split.

**Lesson** - **joining two systems on a human-typed field is a join that will
silently return nothing.** Both halves of this were the same mistake: email was
chosen as the key because it reads like an identity, while `user_id` - the
actual foreign key, present on 102 of 140 rows and already on the wire - went
unused. When a filter can empty a required picker, it needs to be keyed on
something the data is guaranteed to carry.

**Ref** - `fix/salesperson-roster-and-self`, 2026-08-12

---
