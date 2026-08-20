## Eight coercers decided what reaches the fleet tables, with no test and a duplicated clock [medium]

<!-- area: Fleet, trips, TMS -->

**Symptom.** None reported. Found while paying file-size debt on
`scm/routes/fleet-maintenance.ts`, 27 lines over its ceiling.

**What was there.** Eight private functions — `dateOrNull`, `intOrNull`,
`numOrNull`, `floatOrNull`, `tsOrNull`, `refsOrNull`, `iso`, `normPlate` — used
103 times across the router, with no test of any kind. Each returns
`{ ok: true, value } | { ok: false }`, and that shape exists for ONE reason:

```
{ ok: true, value: null }   the caller sent nothing        -> write NULL
{ ok: false }               the caller sent something bad  -> refuse, 400
```

Collapse those two and a typo'd mileage becomes a silent NULL on a compliance
row instead of a refusal the operator can see. Nothing pinned the distinction.
That is precisely the combination `CLAUDE.md`'s coverage section names as the
one worth attacking: a file that decides what reaches the database, with no test.

**Also found: a second `todayMyt`.** The router carried its own copy —
`new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)` — beside the
canonical `scm/lib/my-time.ts`, which documents itself as the backend mirror of
the frontend's. The two are numerically identical today (`8 * 3_600_000` ===
`8 * 60 * 60 * 1000`), so this was not a live bug — it was a second place the
Malaysia-offset rule could drift, and that rule already has a BUG-HISTORY entry
for stamping every document a day early before 08:00 MYT.

**Fix.** The eight moved verbatim into `scm/lib/fleet-coerce.ts` with 22 tests,
and the private clock is gone in favour of the library one. The tests assert the
distinction as a PROPERTY over all six `*OrNull` coercers at once, so a new one
cannot quietly disagree, plus the individual rules that actually differ:
`intOrNull` refuses a fraction (12.5 km is a typo, not a reading), `numOrNull`
refuses a negative because it is money, `floatOrNull` ACCEPTS one because it is
a GPS coordinate, and `refsOrNull` stores NULL rather than `[]` so "no
attachments" has one representation.

Proven red before being trusted: making `intOrNull` swallow bad input fails 4;
making `refsOrNull` accept a non-array fails 2.

`fleet-maintenance.ts` 2144 -> 2096 lines, ceiling follows to 2096 — the
numbers `npm run check:file-size` prints. It counts newlines
(`split(String.fromCharCode(10)).length - 1`); a hand-count that includes the
trailing line is one higher, and a ceiling written in the wrong unit leaves a
phantom line of slack in a file whose neighbours were measured the other way.

**Ref.** 2026-08-15, file-size debt paydown.
