## A list with a saved column funnel re-rendered forever [high]

**Symptom.** Found 2026-09-15 while testing the Purchase Orders export: the page
test with a saved column funnel never finished and the vitest worker died
("Worker exited unexpectedly"). Nobody reported it from a browser; how often it
reached staff is UNKNOWN. What it does in a browser is LIKELY a list that keeps
re-rendering and uses the CPU (the loop below does not stop by itself).

**Root cause (traced).** `DataTable` reports the rows it shows to the parent from
an effect keyed on the rows array (`onFilteredRowsChange`), and list pages store
that report in state (`useVisibleRows`). With a funnel active, the filtered array
is built by `rows.filter(...)` inside a memo whose dependencies include the
column objects — and every list page builds its column array inline, so it is
new on every render. Each render therefore produced a NEW filtered array, the
effect fired, the parent stored it, re-rendered, rebuilt its columns, and the
cycle repeated. Without a funnel the memo returned the same `rows` array and
nothing looped, which is why it only showed with a saved funnel.
PROVEN on the unfixed tree by
`frontend/src/components/DataTable.test.tsx` "settles when a funnel is saved and
the parent stores the report and rebuilds its columns": worker exited
unexpectedly. The same probe against main at 352df7dce crashed the same way, so
the loop predates the line-export work (#3935 moved the filter into
`dataTableRows.ts` unchanged in this respect).

**Fix.** The effect publishes only when the rows actually changed (length and
each row by identity), not when the array object is new. The regression test
above passes on the fix; the existing DataTable, layout and line-export suites
pass (76 tests).

**Ref.** fix/datatable-report-loop, 2026-09-15.
