## The office machine answered which line AutoCount refused, and nobody could read it [med]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Ten delivery orders failed with `Invalid transfer item.` — eleven
words that name no line, no document and no reason. Six attempts each. The page,
the queue and the outbox row all carried those eleven words and nothing else.

**They were never the only answer available.** Since 2026-08-17 the AutoCount
service has asked the vendor's own validator which of the line keys it will
accept, before every partial transfer:

```csharp
TransferHelper.CheckAndGetValidPartialTransferItem(fromType, dtlKeys, dbSetting)
```

It answered every time — `valid-transfer-item check: 8 row(s) for 8 key(s)` — and
wrote that answer to `C:\Temp\ac-sync-service.log` **on the shop-floor PC**.
Sixty attempts, sixty answers, and reading one of them meant a remote-desktop
session onto that machine. Nobody did, for three weeks.

`GET /api/scm/autocount-outbox/host-log` had existed the whole time and **no
frontend file referenced it** — `grep -rn "host-log" frontend/src` returned
nothing.

**Root cause.** A diagnostic whose only output is a file on a machine the reader
cannot reach is not a diagnostic. Two separate gaps made that so: the verdict
never travelled with the error, and the route that could fetch the log had no
door on the screen that shows the failures.

**Fix — both gaps, because either one alone leaves it unreadable.**

* **The verdict travels with the error.** `PreflightValidItems` now stores what it
  learned on `Xfer.ItemCheck`, and `Convert_`'s catch appends it to the message
  the ERP stores. A failing row will read `... || AutoCount's own line check
  accepted 8 of the 8 key(s) sent`, and when it accepts fewer, it NAMES the keys
  it refused — read out of the validator's own DataTable by column name, never by
  position. Empty when the check did not run (a FULL transfer never calls it),
  which has to read differently from a check that found nothing wrong.
* **The log is on the page.** A collapsed panel on AutoCount Sync, fetched only
  when opened — this is a round trip through the tunnel to a desktop PC, and a
  panel that loaded with the page would put that machine on the critical path of
  a screen everybody opens. It lifts the answering lines out of the wall of text
  and says what each means, then shows the raw tail underneath.
* **An empty match says "nothing matched", never "nothing is wrong".** The tail is
  a tail; the failure being chased may simply be older than it.

**Verified.**

* `autocountHostLog.test.ts` — 10 tests. The shortfall line classifies as an
  ANSWER and not a note (RULES is ordered specific-first, and the bare
  `valid-transfer-item check:` needle is a substring of it); an unrecognised line
  produces no finding; the log line is carried verbatim.
* `autoCountSync.test.tsx` — **86 passed**, including four new ones: the panel does
  NOT call the office machine until opened, it lifts the answering line out, it
  says the tunnel is down instead of rendering empty, and an empty match reads as
  "nothing matched".
* `npm --prefix frontend run typecheck` clean; `npm --prefix frontend run lint`
  OK — 3194 warnings, all at or under ceiling.
* `build-local.ps1` — `COMPILES CLEAN - 114688 bytes`.

**A test that passed for the wrong reason, caught before it shipped.** The first
version of the panel tests armed the host-log mock BEFORE `mount`, and `mount`
ends with `apiGet.mockResolvedValue(body)` — which replaces any implementation set
before it. The host-log call therefore answered with the outbox payload, whose
`lines` is undefined, so the empty-match test passed while asserting nothing about
the panel. The mock is now armed AFTER mount, which is safe precisely because of
the property the first test asserts.

**UNTESTED against the live host.** No browser session has fetched the real log
through this panel; the evidence above is the unit and component suites.

**Ref.** fix/why-so-to-do-differs, 2026-09-08. The cause it made readable is
`docs/bugs/0716-every-so-to-do-transfer-used-an-undocumented-autocount-call.md`.
