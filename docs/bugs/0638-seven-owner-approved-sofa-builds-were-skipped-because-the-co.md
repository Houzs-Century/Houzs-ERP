## Seven owner-approved sofa builds were skipped because the corrections file writes a line break as backslash-n [high]

**Symptom.** Seven documents the owner had personally answered on 2026-08-10
were still showing a bare `-1S` placeholder — one row where the slip calls for
three, four or five compartments. Five of them are on orders already
`IN_PRODUCTION` or `READY_TO_SHIP` (`HC-SO-012107`, `HC-SO-012636`,
`HC-SO-012828`, `HC-SO-008942`, plus their POs), so the factory was building
them with no layout. Every run of `apply-sofa-compartment-corrections.mjs`
reported them the same way and nobody could see why:

```
HC-SO-012828: no line matches "28 inch per seat \nfully cover replace t"
              — skipped, the build is not on this document
```

The message was true about the comparison and false about the world: the build
*was* on the document, on the only sofa line it had.

**Root cause (traced).** `apply-sofa-compartment-corrections.mjs:108` narrowed a
document's sofa rows to one build with a plain substring test —
`String(r.description2).includes(c.desc2Match)`. Read off production on
2026-09-04 with the read-only role, the two strings were byte-for-byte
identical except for how they spell a line break:

| | what it holds, shown escaped |
|---|---|
| `data/sofa-compartment-corrections-2026-08.json` | `28 inch per seat \\nfully cover replace t` |
| `scm.mfg_sales_order_items.description2` | `28 inch per seat <LF>fully cover replace t` |

The file's `\n` is **two characters, a backslash and an n**: the Desc2 was
lifted out of a dump that had already escaped it and was then JSON-escaped a
second time. A backslash never equals a newline, so the needle could not be
found in a haystack that was otherwise the same text. Nothing rewrote the data
— the 2026-08-28 re-import was suspected and is RULED OUT; the escape is in the
file as originally written, and the same six needles fail against the rows as
they stand today.

That is 4 corrections / 7 documents. The other two suspects the symptom
suggested were also refuted by reading the rows: a curly quote is NOT the cause
(`HC-SO-012929`'s `Size:26”` matched exactly and that build applied on
2026-09-02), and the build had NOT moved to another line.

**Fix.** The narrowing moved into `backend/scripts/lib/sofa-desc2-match.mjs`
with its own test. It tries the plain substring first — unchanged behaviour for
every build that already applies — and only on a miss retries with both sides
normalised: a written `\n`/`\r`/`\t` becomes a space, whitespace runs collapse,
smart quotes/primes/dashes fold to ASCII, case is ignored. It removes no space
and drops no punctuation, because that is exactly what separates one build from
its neighbour.

The widening carries a brake: a match spanning **more than one distinct Desc2 on
the document is `ambiguous`, and the caller REFUSES the build** rather than
picking. `desc2Match` exists to tell two builds on one document apart, so a
looser needle that stops telling them apart must fail loudly. Measured against
prod first: all 16 documents that match exactly today match exactly one distinct
Desc2, so the guard cannot regress a build that already applies.

Proved RED on the unfixed tree: `sofa-desc2-match.test.mjs` asserts
`description2.includes(needle) === false` for the real prod string and the real
file needle — the old code path, failing — before asserting the new one finds
it. The two-build documents `HC-SO-012929` (a 26" three-piece beside a 28"
single-seater) and `HC-SO-013164` (`2+C+2NA+C TABLE (W)` beside `C TABLE(W)+2`)
are pinned in both directions: the right build is selected, a needle common to
both refuses, and a needle that genuinely differs still matches nothing.

Dry-run against prod, before vs after: **18 builds → 24, with zero documents
lost** (`comm` on the two run logs). `HC-PO-009597` now matches and is REFUSED
on the money assertion — its header carries `total_sen = 0` while the line
carries `unit_price_sen = 383200`, so writing the price onto the first piece
would move a document total. That refusal is the guard working, and it is
recorded in the migration record as outstanding.

**Ref.** `fix/sofa-desc2-matcher`, 2026-09-04. Prod dry-run and apply run ids in
the PR body; the skipped-build evidence is prod run `33657082664` (2026-09-02).
