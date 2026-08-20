## Nothing could say which build the AutoCount host was running [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Asked what still needed doing, the answer given was *"the exe on
that machine is three changes behind"*. It was stated as fact and it was not
one: it came from a handoff note dated three days earlier. The owner pushed
back — *"你确定？查看源代码了？？"* — and he was right. Source cannot answer the
question and neither could anything else.

**Root cause, traced by reading the service rather than a document.**
`/health` answered `{ok, book, service}` and nothing more
(`AcSyncService.cs`, the `Handle` prefix). No build identity, no timestamp, no
commit. The repository records nothing about what is deployed either: the exe
lives on the office machine, and `git grep` for a build stamp finds none.

So "does the running exe contain commit X" had **no answer anywhere**, and the
only material that looked like one was prose that goes stale. Three commits
touched `AcSyncService.cs` after the last recorded build — `#2043` (purchase-side
`transferMaster`), `#2200` (eight unsent fields), `#2218` (the blank line
delivery date the owner had reported) — and whether any of them are live is
UNKNOWN, which is exactly the answer that should have been given.

**This class has already been paid for once.** `docs/SECURITY-DX-ROADMAP.md`
records the nightly Staging E2E passing for a fortnight against a two-week-old
build: *"Staging carried no `GIT_SHA` stamp, so `/health` answered `sha:null`
and the staleness was invisible from outside."* Same shape, different host, and
the lesson had not been carried across.

**Fix.** `/health` now returns `builtAt` — the assembly's own file timestamp,
via `Assembly.GetExecutingAssembly().Location` + `File.GetLastWriteTimeUtc` —
and `mvid`, the module version id, unique per compilation. Comparing `builtAt`
against `git log -1 --date=short -- backend/scripts/autocount-service/AcSyncService.cs`
turns "is the host behind" from a guess into a comparison.

**Deliberately NOT a version constant, and not a git SHA injected at build
time.** Both are things a person has to remember, and this repo's own standing
rule is that a hand-maintained fact is a fact with an expiry date. A file
timestamp maintains itself: rebuilding the exe moves it and nothing else can.

Both reads are wrapped, and the keys are emitted as `null` on failure rather
than omitted — `/health` is the probe used to decide whether the host is up at
all, so it must degrade to a vague answer and never to a 500, and an ABSENT key
reads as an old build that never had them, which is the confusion being
removed.

Pinned in `src/services/autocount-writeback.contract.test.ts`, which already
reads `AcSyncService.cs` at build time for the payload contract and is the only
place that can see the service's source — there is no C# test harness. Both new
cases were observed RED against `origin/main`'s service.

**Ref.** 2026-08-15, PR #2241.
