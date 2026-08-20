## The SO renumber guard used a substring scan, so a cached response body blocked the delete [low]

<!-- area: Sales orders + pricing -->

**Symptom.** The first APPLY run of `renumber-sales-orders.mjs`
(run `31895385393`, 2026-08-15) aborted on the first pair:

```
RENUMBER_FAIL: after repointing, 2990-SO-2608-037 is STILL referenced by
public.idempotency_keys(1) — deleting now would CASCADE-DESTROY those rows.
Rolled back, nothing changed.
```

Nothing was written — the guard did its job of refusing rather than half-doing
the rename, and all three pairs were left untouched.

**Root cause, traced from the script's own dry-run output, not guessed.** The
rename is copy -> repoint -> delete, and before the delete it re-scans for the
old doc number, because five of the seven FK'd child tables are
`ON DELETE CASCADE` and a missed reference would be destroyed rather than
orphaned. That guard reused `tablesMentioning()`, which matches with
`to_jsonb(t.*)::text LIKE '%docno%'` — a SUBSTRING test. The dry-run had already
reported the one row it tripped on as a MENTION, not an EXACT match:
`public.idempotency_keys.response_body` holds the cached API response of the
original create call, with the doc number quoted inside a longer JSON string.
The script deliberately does not rewrite free text, so that row was always going
to survive the repoint, and the guard was always going to abort.

**The distinction the guard was missing:** a cascade fires through a FOREIGN
KEY, and an FK column holds the doc number as the WHOLE value of the column. A
number quoted inside a longer string has no constraint behind it and cannot
delete anything. So the discovery scan and the delete guard need different
tests, and sharing one function silently gave them the same one.

**Fix.** Added `tablesWithExactRef()` — one query per table, `col = $1` OR'd
over that table's text columns, skipping the tables that have none. The
pre-delete guard and the fresh-connection verification both use it; the
substring scan stays where it belongs, in the DRY-RUN report, where showing a
mention is the entire point.

**Ref:** this PR, 2026-08-15.
