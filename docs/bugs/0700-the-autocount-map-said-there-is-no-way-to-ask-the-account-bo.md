## The AutoCount map said there is no way to ask the account book a question [medium]

<!-- area: AutoCount sync + write-back -->

**白话.** 「AutoCount 那本账里有没有『签收』这一栏？」—— 这种问题本来一条唯读的查询
就能回答，而且系统里早就有这条路。可是那份 AutoCount 总览文件写着「那个服务只会写，
一条读的路都没有」。谁看了都会以为问不到，于是要么就不问了、猜一个答案，要么去动那
条要密码的 SQL 直连。文件已改正：那个服务有 **六条唯读的路**，其中一条正好就是回答
这种问题用的。

**Symptom.** `docs/autocount-integration-map.md` — the file whose own first line
says *"Read this first if you are touching anything that talks to AutoCount"* —
opened §6 with:

> There is **no read route on the write service**. All nine of its routes are
> writes; `/health` is the only thing that answers anything, and it answers from
> constants.

and described channel 1 in its table as *"Nine routes, all POST, **all writes**"*.

Both are false. On 2026-09-08 a session needed one fact out of the account book
— does AutoCount's delivery order carry a signed / received column? — and this
paragraph is what it read. The two things a reader does next are the two things
the paragraph makes them do: answer from a reflected SDK dump whose own header
warns it cannot see inherited members, or reach for the ZeroTier `sa2` SQL
credential the same document says nobody should be pasting around.

**Root cause (traced).** The sentence was TRUE when it was written and stopped
being true on 2026-08-31, when `6f72561fb` (#2832) added `/table-columns` — a
read whose entire purpose is to answer *"does this table carry a `UDF_` column"*,
which is this exact class of question. Five more read routes exist beside it.
Counted from the dispatch switch rather than from memory:

```
$ grep -n 'case "/\|path == "' backend/scripts/autocount-service/AcSyncService.cs
```

17 routes. Ten write (`/create-so`, `/create-po`, `/so-to-do`, `/po-to-gr`,
`/so-to-po`, `/do-to-iv`, `/gr-to-pi`, `/cancel`, `/edit`, `/ensure-masters`),
**six read** (`/doc-read`, `/table-columns`, `/further-description`,
`/line-fingerprints`, `/picture-census`, `/last-errors`), plus `/health`.

**Why it went stale rather than being caught.** Nothing could catch it. The
repo's `check-docs-drift` resolves paths, migration numbers, permission keys and
`npm run` names — every mechanically checkable reference — and this claim is none
of those: it is a COUNT of a thing and an assertion about its nature, in prose.
That is the class CLAUDE.md already names, *"a number in a comment is a fact with
an expiry date"*, and the mitigation it prescribes is the one applied here: the
correction ships with the command that recounts it, inline, so the next reader
re-runs instead of believing.

The four read routes the ERP itself reaches were also not in the map at all, so
a reader could not find `GET /api/scm/autocount-outbox/table-columns` from the
document that exists to tell them what the connection can do.

**Fix.** §6 rewritten: a CORRECTED box quoting the old sentence (so a reader who
half-remembers it is not left wondering which version is right), the six read
routes in a table with what each answers and the ERP endpoint that reaches it,
`/further-description` and `/picture-census` marked **service only — no ERP
route**, and the channel-1 row corrected to "17 routes: ten write, six READ, plus
`/health`". The §7 trap about `/health` answering from constants is untouched and
still stands.

The correction also records the separation the code already enforces and the map
never mentioned: reads live in `AC_READ_ROUTE`
(`backend/src/services/autocount-host-read.ts`), not in `AC_ROUTE`, because a
read takes no outbox row, no attempts and no retry policy. That file's header
argues it at length; the map now points at it.

**No test pins this one, and that is stated rather than hidden.** The claim is
prose about a C# file CI cannot compile, so there is nothing to assert in a
runner that would not be a second copy of the same count going stale in a second
place. What ships instead is the recount command in the text.

**Found while answering a different question**, and that answer is the durable
half: `docs/modules/delivery-order.md` §"Does a sign-off reach AutoCount?", with
`backend/tests/doSignOffReachesAutoCount.test.ts` behind it — nine assertions,
proved RED first by injecting a sign-off write-back into the DELIVERED branch
(2 of 9 failed; the first draft of the pin missed it entirely because the route
calls its own `queueAcDoEdit` wrapper rather than `enqueue*`).

**Ref.** `feat/do-signoff-ac-writeback`, 2026-09-08.
