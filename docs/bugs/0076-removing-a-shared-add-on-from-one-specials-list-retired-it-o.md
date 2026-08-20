## Removing a shared add-on from one Specials list retired it on the other [high]

**Symptom** - the owner opened Products -> Maintenance -> BEDFRAME -> Specials and
found SOFA add-ons in it (`5537 Backrest`, `Separate Backrest Packing`,
`Seat Add On 4"`). The only control the panel offers for that is **Remove**, and
using it would have retired those add-ons on the SOFA list too - silently, on Save,
with no warning naming the other category.

**Root cause (traced, not guessed)** - `special_addons.categories` is an ARRAY, so
one code can carry `['SOFA','BEDFRAME']` and appear in BOTH panels. The panel edits
only its own slice and rebuilds the whole-table snapshot as
`otherRows + draft` (`Products.tsx:4530-4534`), where
`otherRows = allRows.filter(r => !inCat(r) && !draftByCode.has(r.code))`. A shared
row is `inCat`, so it is excluded from `otherRows`; `removeRow` takes it out of the
draft; it therefore appears in NEITHER arm and vanishes from the snapshot. The
`/save` handler then deactivates every live code the snapshot omits (by design -
"retire, don't delete"), so the row goes `active = false` for every category at once.
`categories` has no editing control anywhere in the file - it is only read
(`inCat`), copied (`rowToSpecialInput`) and stamped on new rows
(`categories: [category]`) - so there was no non-destructive way to do what the
owner wanted.

**Fix** - Remove now branches on membership. A row carrying other categories is
DETACHED from this one (kept in new `detached` state with the category filtered out,
carried explicitly into the snapshot alongside `otherRows`) and the confirm names
where it survives; only a row belonging to this category ALONE is a real retire and
keeps the danger styling. No order is touched either way - the code stays live, so
every SO line naming it still resolves.

**Lesson** - **a delete control over a many-to-many membership must say which
relationship it is deleting.** The snapshot-and-retire mechanism was correct on its
own terms; the defect was a button labelled "Remove" that meant "remove everywhere"
on rows the panel itself only half-owned.

**Ref** - `fix/special-addons-save-sort-categories`, 2026-08-12

---
