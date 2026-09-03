## The probe built to stop unevidenced claims made one [medium]

<!-- area: Auth, permissions, sessions -->

**Symptom.** The owner opened System Health minutes after `0604` deployed and
photographed a card that contradicted itself:

> **This request's authorization: Not reported** — *"The server did not say — do
> not read this as either answer"*
>
> …above the sentence: *"Authorization took the fast path. But presence keep(s)
> its cached copy for less time than the browser waits…"*

Both cannot be true. The card said it did not know; the sentence said what it
did. **The probe written to stop claims that outrun their evidence had made
one**, on its first live reading.

**Root cause (traced).** Branch order in `readingFor`
(`services/auth-fastpath-probe.ts`). The structurally-short-TTL arm sat ABOVE
the `unknown` arm:

```
if (!configured)                 -> OFF
if (thisRequest === 'session-db') -> configured but not taken
if (structural.length)            -> "Authorization took the fast path. But …"   <-- fires on unknown
if (thisRequest === 'unknown')    -> "cannot say"                                <-- unreachable here
```

With `unknown` AND a short TTL — the exact live combination, because presence
keeps 15s against a 60s poll — the third arm answered for the fourth.

**Why the tests missed it.** `authFastPathProbe.test.ts` exercised `unknown`
only beside a HEALTHY cache (`ok(300, 60)`), so the failing combination never
ran. **A branch covered on one arm only.** Same shape as the optional-parameter
class in CLAUDE.md: the case that keeps the old behaviour is the one nobody
writes a test for.

**Fix.**

1. `unknown` is checked BEFORE the caches. It still reports the cache finding,
   because that holds whatever authorization turns out to be doing — but as a
   separate clause that claims nothing about the path.
2. **`unknown` stops being a dead end.** It now carries `client_sent_pass`,
   observed off the request headers (presence only — never the value, never a
   prefix, never a length), because the two causes need opposite fixes:
   * no header → the browser has none to send: it expired, or was never stored;
   * header present but no record → we lost the record, a different bug.
3. Both arms of the branch are asserted. **Proved RED against the shipped code:
   the two new tests fail (2 of 11), pass on the fix.**

**What it does NOT fix.** Why `this_request` came back `unknown` at all is still
**UNKNOWN**. The middleware sets it on both paths (`middleware/auth.ts:162`,
`:196`), the route is behind `app.use("/api/*", auth)`, `/live` is not cached
server-side, and the client DOES absorb a re-issued pass
(`lib/requestCorrelation.ts:94`, one funnel for every authenticated call). Four
readings of the source have not explained it, which is precisely why the answer
is being measured instead of reasoned: the next reading of this card names its
own cause.

**A fifth wrong statement was nearly made here.** A first grep suggested
`absorbSessionPass` had no caller in the app — a finding that would have
explained everything. It was checked before being said: `git grep` without the
filter shows `requestCorrelation.ts:94`. The wiring is complete. Recorded
because the near-miss is the point — see the memory note
`grep-one-file-answered-wrong-question`.

**Verified.** 11 tests; the two new ones proved red against `origin/main`'s copy
of the source with the new test file kept in place. Backend + frontend typecheck
exit 0.

**Ref.** fix/probe-said-what-it-did-not-know, 2026-09-02.
