## The Project List date range did not survive opening a project [medium]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner 2026-08-24: *"once i filter here and click in project, then i
back to project list back all my filter gone, i want make it my filter didnt
close until i manually clear filter or close erp then filter will auto clear"*.

**Root cause (traced).** Two separate things, one per half of the request.

1. `useStickyFilters` mirrors the URL into storage through `pluck()`, which
   copies **only the keys named in the caller's allow-list**. The Project List
   allow-list, `PROJECTS_LIST_FILTER_KEYS`, still named `year` and `month` — the
   dropdowns replaced by the date-range picker on 2026-08-14 — and never gained
   `from` / `to`. Every other chip (Task/`section`, brand, status, search, page)
   round-tripped; the DATE RANGE was silently dropped on the way out and could
   not be restored on the way back. Enumerated from the source: the list reads
   `brand, from, mine, month, new, page, phase, search, section, status, task,
   to, year` and mirrored all but `from` and `to`.
2. The snapshot lived in `localStorage`, so what did persist persisted for ever
   — across a logout, across days. The owner asked for the opposite: hold the
   filter while the ERP is open, drop it when it is closed.

**Fix.** `from` and `to` join the allow-list, and the whole `filters:` family
moves to `sessionStorage`, which is exactly "until I close the ERP" — the same
storage `houzs.scmListReturn.v1` and `houzs.assrListFilter.v1` already use to
carry a filtered list across a detail round-trip. The pre-existing
`localStorage` snapshot is deleted on mount so yesterday's view cannot come
back. `browserStorageRegistry` gains a `list-filters` row (TRANSIENT) and
`filters:` leaves `IDENTITY_PREFERENCE_BASES`, keeping the one-owner-per-key
invariant its test asserts.

Clear-all is unchanged and still empties the snapshot immediately: an empty
pluck writes no key and removes the stored one.

**Ref.** `fix/project-list-filter-stickiness`, 2026-08-24.
