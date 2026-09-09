## The stale-SO check died on an enum status, and its own preflight could not have caught it [low]

**Symptom.** `check-stale-so-holding-stock.mjs`, first dispatch against
production (run 34313156425):

```
PostgresError: function upper(scm.mfg_so_status) does not exist
##[error]Process completed with exit code 2.
```

**Root cause (traced, not guessed).** `scm.mfg_sales_orders.status` is the ENUM
type `scm.mfg_so_status`, not `text`, and Postgres has no `upper()` overload for
an enum. Both statements in the script wrote `upper(h.status)`. Fixed by casting:
`upper(h.status::text)`.

**The part worth keeping is why the guard did not fire.** The script ships a
PREFLIGHT that names every column it reads and refuses if one is absent — written
the same day, deliberately, after the goods-receipt money apply died `42703` on
`scm.grn_items.updated_at` (`docs/bugs/0740`). It ran, it passed, and it was
right to: **the column exists.** A preflight over `information_schema.columns`
proves EXISTENCE and says nothing about TYPE. So a guard aimed at exactly this
class of failure let exactly this class of failure through, one rung down.

There is no honest way to call that a near miss. It is the ordinary limit of the
check, and it is written here rather than "fixed" by widening the preflight into
a type-checker, which would be a second schema model to keep in step with the
first. **When a column-shaped error survives the preflight, the next thing to
look at is the column's TYPE.**

**A second, sharper trap in the same fix.** The first attempt put the explanation
in a `/* ... */` comment inside the SQL — and that SQL lives in a **tagged
template literal**, so the backticks around `` `status` `` closed the template.
`node --check` caught it (`SyntaxError: Unexpected identifier 'status'`), which is
why `node --check` is worth running on a script whose only other gate is a
production dispatch. **No backticks in a comment inside a tagged template.**

**Fix.** `upper(h.status::text)` in both statements, with the reason recorded at
the site as a `--` SQL comment.

**Ref.** PR for `fix/stale-so-status-enum-cast`, 2026-09-09.
