## main went red again on the same file, and the frontend stopped deploying a second time [high]

**Symptom** — hours after the last one, `main` fails `tsc -b`:

```
src/pages/Projects.tsx(4563,9): error TS2451: Cannot redeclare block-scoped variable 'q'.
src/pages/Projects.tsx(4765,9): error TS2451: Cannot redeclare block-scoped variable 'q'.
src/pages/Projects.tsx(4770,25): error TS2339: Property 'data' does not exist on type 'string'.
src/pages/Projects.tsx(4771,22): error TS2339: Property 'data' does not exist on type 'string'.
```

Every open PR inherited it — `frontend`, `frontend-build`, `frontend-checks`,
`frontend-typecheck` red on six of them at once — and the frontend deploy was
blocked for the second time in one day.

**Root cause** — the projects calendar declares two different `q` in one
function scope. `:4563` is the SEARCH STRING (`params.get("q")`, read at `:4785`,
`:4799`, `:4949`, `:4955`); `:4765` is the QUERY OBJECT from `useQuery`, read at
`:4770`, `:4771`, `:5079`, `:5080`, `:5082`. Two features, added separately,
each reaching for the shortest name in a 15,000-line file. The second
declaration wins for the type checker, so `q.data` resolves against a `string`.

**Fix** — landed as #2198, which renamed the SEARCH variable `q -> search` and
left the query object as `q`. I had prepared the opposite rename (query object
to `eventsQ`) and dropped it when theirs merged first: both are correct, and
re-naming it a second time would be churn in a file that is already the most
collided-on in the repo. This entry is the write-up that fix did not carry.

**A near miss worth recording.** I first read `:4765` through a 120-column
truncation, concluded the call was missing a comma before its fetcher, and wrote
a patch to insert one. The comma was there — the display had cut it. The patch
did not land only because the script asserted the line matched the shape it
believed before editing, and refused when it did not. Read the bytes
(`JSON.stringify` the line), not the pretty-printed excerpt, before repairing
something you have only seen truncated.

**Class** — *a semantic merge conflict*, the second in a day in this same file
after the `"upload" | "remove"` union. Both PRs were green alone; the failure is
the pair, which a per-PR gate cannot see. `Projects.tsx` is 15,003 lines and 128
over its size ceiling — the collision surface IS the file's length, and every
such fix has to be net-zero lines to get past the ratchet, which is its own
argument for splitting it.

**Ref** - `fix/calendar-query-shadows-search`, 2026-08-14
