## The change log's truncation warning could never fire, so a partial window read as complete [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**白话.** 「Change Log」那一页会告诉老板这段时间谁改了哪几张单，底下还有一句警告：
「这个时间范围内的改动比一次能读回来的多，上面的数字只是下限」。那句警告**从来不会
出现**——判断的写法是「读回来的行数 >= 4000」，可是资料库一次最多只回 1000 行，两张
表加起来最多 2000，永远到不了 4000。所以只要那段时间的改动超过一次读的量，页面就会
把**读不完的数字当成完整的**报给老板。现在改成拿资料库自己给的总数来比。

**Symptom.** `GET /api/scm/change-log` always answered `totals.truncated:
false`. The banner it drives — `clTruncationNote` in
`frontend/src/lib/changeLog.ts`, whose own comment calls it *"the warning that
must never be silent"* — was silent on every request ever made, so the page's
counts of changes, people and documents were presented as totals over a window
the server had not finished reading.

**Root cause (traced, and it is arithmetic — no production reading needed).**
`backend/src/scm/routes/change-log.ts` computed

```ts
truncated: rows.length >= ROW_CAP,   // ROW_CAP = 4000
```

`rows` is the CONCATENATION of two independent reads — `mfg_so_audit_log` and
`entity_audit_log` — each asking `.limit(ROW_CAP)`. PostgREST caps a response at
`db-max-rows` whatever `.limit()` asks for and reports nothing about the
remainder (`lib/paginate-all.ts`). At the 1,000 this repo assumes (still
UNMEASURED — `docs/bugs/0447`) the two reads sum to at most 2,000, against a
threshold of 4,000. The comparison could not be true.

It was wrong in the OTHER direction too, for any ceiling above 2,000, and that
half needs no assumption at all: a two-read SUM was being compared against a
ONE-read cap, so 3,000 + 1,500 untruncated rows would have reported truncated.

The module guide asserted the protection as fact — *"`totals.truncated` is true
when the database read hit its own ceiling (`ROW_CAP`, 4000 rows)"* — which is
how it survived. The route's existing test asserted only the NEGATIVE case
(`truncated` false on an ordinary read), so nothing was red.

**Fix.** Both reads take `{ count: 'exact' }` and the flag is computed per read
from the server's own total against what arrived, OR'd across the two. That is
correct for ANY ceiling and needs the number to be known for nothing — the same
device `backend/src/scm/routes/so-handover.ts` `/preview` has always used
correctly. `ROW_CAP` stays as what it always really was, a bound on our
appetite, and its comment now says so.

**Proof.** `backend/src/scm/routes/changeLogRoute.test.ts` gains the positive
cases the suite never had, driven through `lib/fake-postgrest.ts`, which now
takes an optional server row ceiling (`maxRows`) — a fake with no ceiling cannot
reproduce a silent truncation at all, which is why the case was never written.
Both new cases go RED on the unfixed expression (`expected false to be true`),
observed by putting `rows.length >= ROW_CAP` back. A third case pins the
boundary the old comparison also got wrong: a read that returns every matching
row is complete even when that count equals the ceiling.

**Two faithfulness bugs in the shared fake, found on the way.** `{ count:
'exact' }` WITHOUT `head: true` was answered as if it were head-only — `data:
null` — so under this fake every SCM paginated list read came back with no rows.
And a count computed after the window would have agreed with the truncated read
by construction; it is now taken before the window, which is what Content-Range
does.

**Ref.** audit/rowcap-sweep, 2026-09-10.
