## One date format, written by hand at thirty sites and left to the operating system at a hundred and seventy-five more [high]

<!-- area: Frontend + mobile -->

**Symptom.** The owner sent a screenshot of New Sales Order and asked why the
date format is not standardised across the system. The header read
`Aug 16, 2026` and `Sep 12, 2026`; the line rows under it read `12/09/2026`. One
screen, two spellings of the same kind of fact.

**`Aug 16, 2026` is not a format this codebase authors.** Grepping for it returns
nothing, because nothing writes it. `SalesOrderNew.tsx` Processing Date and
Delivery Date were native `<input type="date">`, and a native date input renders
its ISO value **in the operating system's locale**. On the owner's machine that
is `Aug 16, 2026`; on a colleague's it is `16/08/2026` or `08/16/2026`. That is
the same 「有时候 MMDDYYYY」 bug he reported on **2026-06-18**, for which
`DateField` was built the same day — and which had reached **14** of 189 date
inputs. 175 native ones remained, including both fields in the screenshot.

**Underneath it, the rule had been written down twice and re-derived thirty
times.** `frontend/src/lib/utils.ts` said *"House style is numeric DD/MM/YYYY
(owner requirement — no 'Jun'/'Jul' month names anywhere on the desktop app)"*.
`frontend/src/vendor/shared/format.ts` said *"System-wide canonical display
format (Commander 2026-06-18)"* under a header claiming to be the *"SOLE source
of truth — no inline duplicates anywhere in client OR server"*. Between and
around them:

- all **11** V2 LIST pages emitted `2026/08/16` from their own
  `iso.replace(/-/g,'/')`, while all **8** V2 DETAIL pages emitted `16/08/2026`
  from a copied regex reorder — so a list row and the page it opens spelled one
  date two ways;
- month-NAME arrays in the PO print template, the project run sheets and the POS
  period labels produced `16 Aug 2026`, contradicting the owner's own recorded
  instruction about month names;
- Fleet rendered the storage shape (`2026-08-16`) straight at the user;
- three screens called bare `.toLocaleString()` and got whatever the machine said;
- timestamps existed in three spellings, one of whose docstrings claimed an
  output (`"4 May 2026, 11:20 AM"`) the code has never produced.

The same files that hand-wrote `fmtDate` were **already importing `fmtCenti`
from the shared module on the line above**. Money had gone the other way; dates
had not.

**Two live defects in the shared formatter, invisible from Malaysia.** `fmtDate`
was `new Date(d).toLocaleDateString('en-GB', …)`. `new Date('2026-08-16')` is
parsed as UTC midnight, so under `TZ=America/Los_Angeles` it rendered
**`15/08/2026`** — the wrong day — while under `TZ=Asia/Kuala_Lumpur` it was
correct, which is why nobody in the office could ever reproduce it.
`fmtDate(null)` returned **`01/01/1970`** and `fmtDate('16/08/2026')` returned
**`Invalid Date`**. `SalesOrderDetail.tsx` documents dodging the first of these
by hand rather than fixing it.

**Fix.** One rule with one home. `fmtDate` / `fmtDateTime` / `fmtTimestamp` /
`fmtTime` in `frontend/src/vendor/shared/format.ts`, mirrored byte-identically
into `backend/src/scm/shared/format.ts` (`check-shared-mirrors.mjs` is the
referee), branching on the input's SHAPE: a value carrying no timezone is shown
verbatim, a real instant is converted once into GMT+8 by fixed offset
arithmetic rather than an ICU lookup. Null-safe, invalid-safe and idempotent.
~30 local helpers deleted and pointed at it; every one of the 175 native date
inputs now renders through `DateField`, five of them via the wrapper components
they sit behind. CSV export emits ISO independently of display, because
converging the list pages onto DD/MM/YYYY would otherwise have broken sorting in
every exported sheet.

**The class, for next time.** This is `docs/bug-classes.md` **class E**, and the
third instance in one week — the transfer-label vocabulary and the
both-dates-or-neither rule were each found written five times, each enforced
slightly differently, each missing from at least one path. The rule here was not
forgotten: it was written down, in the right words, in the file most likely to
be read, and reproduced anyway, because **there was no import that would have
given it to you**. Writing it down a third time was the move that had already
failed twice, so it is enforced instead:
`backend/scripts/check-date-formatting.mjs`, wired into the required
`backend-typecheck` job, fails on a new hand-spelled date unless somebody adds
it to a reviewed allowlist with a reason.

The gate is proved rather than assumed. `backend/tests/dateFormatGate.test.ts`
plants a date format outside the source tree on every CI run, asserts exit 1,
removes it and asserts exit 0 — and separately asserts it does NOT fire on money
or row counts, because a gate that cries wolf is a gate somebody deletes. Run by
hand during this work, the planted line
(`toLocaleDateString('en-US', { month: 'short', … })`) produced the string
`Aug 16, 2026` — the owner's screenshot, reproduced from source and then caught.
