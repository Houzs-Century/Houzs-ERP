## The host only rebuilt when a line happened to be keyless [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner opened `SO-013361` in AutoCount and photographed it: nine
lines, the `JAGER BEDFRAME` he had DELETED in the ERP still sitting there at
`Qty 0` with `[ERP-CANCELLED]` in Desc2, and the line order still AutoCount's own
rather than the ERP's.

> 「为什么还有 cancel 呢？」

The document had been rebuilt — the workflow queued it, the queue reported it
`sent`, and I told him so. **The send was real and the rebuild never happened.**

**Root cause (traced, and it is mine).** `/edit` walks the payload once as a
pre-flight, refusing any line that carries no `DtlKey` and does not declare
`IsNewLine`. The rebuild escape was written INSIDE that walk:

```csharp
for (var i = 0; i < lines.Count; i++) {
  var it = lines[i];
  if (hasKey) continue;                    // <- every keyed line leaves here
  if (Bool(it, "IsNewLine")) continue;
  if (Bool(p, "Rebuild")) { ...; rebuild = true; break; }   // never reached
  throw ...;
}
```

Every line with a key hits `continue`. **A document whose lines all carry keys
never reaches the `Rebuild` check at all**, so `rebuild` stays `false`,
`ClearDetails()` never runs, and an explicit `Rebuild: true` is silently
downgraded to an ordinary keyed edit. The deleted line is never removed and the
order is never re-laid.

**Why it looked like a working feature.** The one document it was first proven on
— `HC-SO-013394` — had a keyless line, which is the only reason the walk ever
reached the escape. Both of that document's rebuilds worked, were verified
against the book, and taught me the wrong lesson. `SO-013361` had every line
keyed, so all three of its rebuilds were no-ops that reported success.

**What made it invisible.** The outbox records what the HOST answered, and the
host answered 200: it had applied a keyed edit exactly as asked. Nothing in the
queue, the health report or the drain could have said otherwise. Only the account
book knew, and only a person looking at it noticed.

**Fix.** The rebuild is decided ONCE, before the pre-flight walk, and the walk is
skipped entirely when one was asked for — a rebuild destroys every key a moment
later, so the key pre-flight has nothing left to protect. `AnyLineTransferred`
still refuses first, unchanged.

**Verified.** `backend/tests/acRebuildDetails.test.ts` gains three assertions:
the `Rebuild` check must appear BEFORE the loop, the loop must carry
`&& !rebuild`, and exactly one place may set `rebuild = true`. Proven against the
old file rather than by argument — on `origin/main` the loop is at line 3191 and
the check at 3217, so the ordering assertion fails there; after the fix the check
is at 3204 and the loop at 3213. 36 tests pass across the rebuild suites.
`build-local.ps1` — `COMPILES CLEAN - 110592 bytes`.

**INERT UNTIL THE HOST IS REBUILT.** This is host code. The office machine is
running the 2026-09-02T15:59 binary, which carries the defect, so every rebuild
of a fully-keyed document keeps being a no-op until `deploy-on-host.ps1` runs
there again. **UNTESTED against the account book** at the time of writing: no
rebuild has been performed since the change.

**The lesson.** A feature proven on ONE document was proven on the only shape
that could reach it. The keyless line was not incidental to that test — it was
the precondition, and nothing said so.

**Ref.** fix/the-host-only-rebuilt-when-a-line-was-keyless, 2026-09-03.
