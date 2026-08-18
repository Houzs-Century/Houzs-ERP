# Bug classes — what keeps producing bugs here, and what now catches it

Owner, 2026-08-13: 「是不是應該看一下我們最近的 BugHistory，找找是什麼原因、為什麼會有這些
bug、導致了什麼後果？你是不是應該以此來優化一下自己，避免以後再出現同樣的問題？」

This file is the answer, and it has one rule: **no class appears here without the
name of a check that now fails on it.** Where a class has no mechanical remedy,
it is listed at the bottom under [Classes with no check yet](#classes-with-no-check-yet)
and says why, rather than offering advice.

Advice is what we had. It did not work, and the corpus says so in its own words —
`docs/jsonb-double-encoding-coe.md`, Lesson 4:

> **Documenting a trap is not fixing it.** Two files were given careful comments
> explaining this exact double-encoding after its first occurrence. The comments
> taught readers to tolerate the bad data. The writers stayed broken, and the
> trap caught a third script the same afternoon.

Three days after that COE was written, the repair script written to undo its
damage reproduced it, and two violations were still live on `main` when this
file was created. That is the whole argument for gates over prose.

## How the counts were made

`BUG-HISTORY.md` at `origin/main` d33ac743 splits into **814 entries** (133 `##`
headings of which 32 are bare date separators, plus 713 `###`), each dated from
its `**Ref**` line where it has one, else its enclosing date heading. 449 carry an
explicit `**Root cause**` section; 311 carry a `**Lesson**` / `**The class, for
next time**`.

A count below is the number of entries whose **title or root-cause paragraph**
carries the shape. It deliberately does **not** search whole bodies: an entry that
cross-references an earlier class is not an instance of it, and searching bodies
is why independent passes over this same corpus produced 104, 54 and 15 for one
class. **Every count here is a lower bound** — an entry that describes the shape
only in its fix, or in different words, is missed. Where a class is better counted
from a source other than regex (the jsonb class), that source is named.

---

## A. A pre-serialized value bound to a json/jsonb parameter

**Shape.** postgres.js asks the server for parameter types before it binds
(`describeFirst` is set whenever there are parameters and the statement is not
prepared — which is every query here, since every client opens with
`prepare: false`). When the server answers "that parameter is jsonb", the driver
runs its **own** `JSON.stringify` over the value. A value that was already a
string is therefore encoded twice and lands as a jsonb **string**.

Nothing errors. A jsonb string is valid jsonb. The `UPDATE` still reports a
rowcount, `variants->>'fabricId'` returns `NULL`, and every `Array.isArray()`
reader sees nothing.

**Count — 6 occurrences across 5 writer scripts in 15 days.** Not a regex: this is
the COE's own tally plus the recurrence after it. 2026-07-29 (found, fixed with an
11-line comment); 2026-08-08 `[MEDIUM]` "The fee-line repair's first prod DRY-RUN
died inside the 0214 RPC — the rows arrived as a jsonb STRING"; 2026-08-10, three
production apply runs of `refresh-sofa-colours.mjs` in one afternoon; 2026-08-13,
the repair script for that damage.

**Worst consequence.** `"APPLIED - stamped 146 sofa lines", three times, and it
was corrupting them` (2026-08-10). Per the COE: *"419 claimed stamps moved the
number zero times, and the cutover spent an afternoon believing three successful
writes had happened."* Then seven production sales-order rows went from
array-shaped to string-shaped on 2026-08-13 — written by the repair for the
damage. The corrupted column is the sofa build spec, which is what the AutoCount
write-back composes from.

**THE CHECK — `npm --prefix backend run audit:jsonb-binds`**
(`backend/scripts/check-jsonb-binds.mjs`, wired into ci.yml `backend-typecheck`).

Fails on any `JSON.stringify` bound as a query parameter across `backend/src` and
`backend/scripts`, in both shapes the repo writes: interpolated into a SQL tagged
template, or placed in the params array of `.unsafe(text, [...])`. The one legal
escape is `$n::text::jsonb`, matched **per placeholder**, which forces the server
to type that parameter as text.

Two live violations were fixed to turn it on:
`backend/scripts/split-collapsed-sofa-lines.mjs` (`$2::jsonb`, ten lines below a
correct `tx.json()` in the same file) and
`backend/scripts/backfill-2990-delivered-dos.mjs` (a stringified array into
`scm.mfg_so_audit_log.field_changes`, `jsonb NOT NULL`, with **no cast anywhere** —
which is why the sweep that grepped for `::jsonb` missed it; the parameter is the
thing to look at, not the cast).

**Proved, not assumed.** `backend/tests/jsonbBindScan.test.mjs` (13 tests, in
`pretest` so it cannot be skipped) runs the scanner against the real source of
every occurrence, in both the shape that caused it and the shape that fixed it.
One of those tests exists because mutation-testing this checker found a hole in
it: the fix carries a SQL comment saying `$2::text::jsonb`, and reverting only the
**code** left the comment, which the funnel test matched — the guard silently
stopped guarding the site it was written for. A comment must never be able to
satisfy a check.

---

## B. A read whose failure is folded into a confident value

**Shape.** supabase-js does not throw. A failed select resolves
`{ data: null, error }`. So `const { data } = await sb...` followed by `data ?? []`
makes these three states identical: *the query failed*, *you are not allowed*, and
*there is genuinely nothing here*. The next line writes it.

**Count — 20 entries**, plus the corpus's own tag `reference_houzs_nullish_hides_ignorance`
on 10. Live census: **938** `const { data … } = await …` with no `error` bound
and **76** bare `.catch(() => {})` and siblings, across 143 files. (Every one of
the 938 reads is in `backend/src`; the frontend's 76 → 38 share is all bare
catches. The census stood at 954 when the gate was written, and 16 have since
been fixed — see *The first descent* below.)

**Worst consequence — real money, twice.** 2026-07-17: *"A blip on the payments
read told the driver an already-paid order still owed the full total — and POD
collected it again"*, and the figure was written as the collected amount. Same
day: *"A blip on the read that asks 'did we already apply this credit?' … DEFEATED
the guard and spent the customer's credit twice."* `recomputePaid` folding to 0
reverted a fully PAID invoice to SENT; `recomputeGrnInvoiced` folding to 0 made a
supplier's goods billable a second time. On the permission side, `pms.canPayment
?? true` granted access on a money surface whenever the payload failed to load.
The owner: 「它們不會報錯。它們悄悄發生，你兩個月後對帳才發現」.

**THE CHECK — `npm --prefix backend run audit:swallowed-reads`**
(`backend/scripts/check-swallowed-reads.mjs`, wired into ci.yml `backend-typecheck`).

Per-file ceilings in `backend/scripts/data/swallowed-read-baseline.json`, over
**both** trees. Site 939 fails the build. Ceilings may only fall: a file whose real
count drops below its ceiling also fails, with `--update` as the fix, so the ratchet
descends instead of merely holding.

**Why a ratchet and not a ban.** The sites predate the rule and most are certainly
fine; nothing separates the safe ones from the dangerous ones, and no honest PR
deletes 938 destructures. What is provable is the direction: the 2026-07-17 census
counted 785 of 1,277, the class was declared fixed across 15 money documents, and
four weeks later it stood at 954 of 1,794. **The class did not recur despite the
fix — it grew during it, because nothing counted.** That is the thing the gate
removes.

### The first descent — ranked by what the absence AUTHORISES

Counting sites cannot tell a dangerous one from a harmless one, so the sites were
ranked by consequence rather than by file. A read whose empty result blanks a
display field is low grade. A read whose empty result **lets a write proceed** is
where the money moved twice. **16 of those were fixed and the ceilings lowered by
exactly that** (954 → 938).

The rule each fix carries, in the repo's own words — it was already written by
`backend/src/scm/lib/downstream-lock.ts`, which is the model for all of them:

> A failed read must never read as an absence when the absence is what authorises
> the write.

| Decision the read gates | Where it was | Guard now |
| --- | --- | --- |
| remaining-qty / over-receipt cap (10 sites, 5 route files) | the whole cap lived inside `if (row) { … }`, so a failed read stepped over it entirely and the line was written **uncapped** | `lib/qty-cap.ts` → `qty_cap_check_failed` (409) |
| "nothing still references this" before a delete | `findSkuUsage` did `if (error) continue`; `findModelUsage` read `skus ?? []` — an unreadable probe reported a live SKU as never sold | `lib/sku-usage.ts` → `usage_check_failed` (409) |
| "nothing still references this" before a delete | `categories.ts` folded a failed count with `count ?? 0`, passing `category_in_use` | `category_in_use_check_failed` (409) |
| "does this already exist" before a destructive cascade | `mfg-products.ts` rename read as "no duplicate", and the cascade re-points **referencing tables first**, so `UNIQUE(company_id, code)` only fires after two SKUs' stock and bindings are merged | `duplicate_check_failed` (409) |
| a gate that decides a state change | `so-confirm-gate.ts` folded a failed lines read into an order with no lines, returned **zero problems**, and the DRAFT was confirmed and enqueued to AutoCount | `so_confirm_check_failed` problem (422) |

Each is pinned twice: a unit test that makes the mock's read **reject** and asserts
a refusal (`qty-cap.test.ts`, `sku-usage.test.ts`, `so-confirm-gate.test.ts`), and
a route-level test that asserts the handler refuses **and the row is still there**
(`backend/tests/destructiveGuardsRefuseUnreadableProbe.test.ts` — a status-only
assertion would pass on a 409 that had already deleted). The ten cap call sites are
pinned by the lowered ceilings: reverting one to the inline destructure now takes
`purchase-invoices.ts` from 38 to 39 and fails `audit:swallowed-reads`, which at
the old ceiling of 40 it would not have.

**Deliberately not touched:** the POST-insert over-receipt verifiers in `grns.ts`
and `purchase-invoices.ts`. Those run after the row is committed, so refusing means
deleting a receipt the operator watched succeed — the fail-closed answer is not free
there, and the files say so in their own comments. This pass took only the pre-write
gates, where a refusal costs a retry.

**What the gate still does not cover.** It counts sites; it cannot tell a dangerous
one from a harmless one. The structural fix is a query layer returning a
discriminated result (`{ ok: true; rows } | { ok: false; error }`) so `?? []` has
nothing to coalesce and `tsc` forces the branch. `findServiceLineCodes` in
`backend/src/scm/lib/service-line-guard.ts` already has that shape and is the model;
`lib/qty-cap.ts` and `lib/sku-usage.ts` are now two more.

---

## C. A parameter that decides, declared optional

**Shape.** `param?: T` lets a caller say nothing, and saying nothing is spelled
exactly the same as *there is nothing to say*. When the parameter decides which
company's books to read, the default is not "unknown" — it is "all of them". `tsc`
is happy either way, so the omission is invisible to the compiler and to review.

**Count — 22 entries.** Seven are the same parameter class, and the rule was
written down after the second: 2026-07-17 *"an optional scoping parameter is a
trap whose default is 'wrong'"*. It then recurred the same day (the CS Agent), and
again on 2026-07-29 (`soItemId`), 2026-08-09 (`itemCode`, DIVAN ONLY — threaded
through "every call site" except two, for four days) and 2026-08-11
(`composeCreateSo` called with two of three arguments).

**Worst consequence.** One company's stock covered the other's shortage in the
planning engine, and *"The CS Agent promised customers delivery dates backed by the
OTHER company's stock"* — a real `PROMISE_DATE` given to a customer, computed from
pooled supply. Separately, the entire idempotency programme (middleware written,
mounted, migrated on both trees, unit-tested) was inert for the one document the
whole payment chain hangs off, because seventeen call sites never sent the header.

**THE CHECK — `npm --prefix backend run audit:decision-params`**
(`backend/scripts/check-optional-decision-params.mjs`, wired into ci.yml
`backend-typecheck`).

Fails on any **parameter** named `companyId`, `company_id`, `itemCode`, `soItemId`,
`idempotencyKey`, `asDraft` or `actorId` declared `?:` in `backend/src/scm/shared`
or `backend/src/scm/lib`. It parses with the TypeScript compiler API rather than
grepping, so a row-shape property (`{ company_id?: number | null }`, describing a
row that came back from the database) is not confused with a parameter — 66 grep
hits reduce to 19 real ones.

**The fix it enforces** is the one already proven here: `param: T | null | undefined`
instead of `param?: T`. The key becomes required, `undefined` stays a legal value,
runtime is unchanged for every honest caller, and silence stops compiling.

**It found a live leak on `main`.** All 19 sites were converted in this PR, and the
compiler then named every caller that had been omitting the argument. One of them:
`backend/src/scm/routes/inventory.ts` `GET /reconcile` called `reconcileLedger(sb)`
with no company. `reconcile-ledger.ts` documents exactly two modes — per-company
for *"operator-facing /reconcile"* and cross-company for System Health — and
`backend/tests/reconcileLedgerScope.test.ts` pins the per-company mode in both
directions, after company A's report listed company B's PC-Return numbers. **That
fix was tested at the function and never wired at the route**, so the operator's
per-company report had been running in cross-company mode. Nothing was red.

**What it does not cover.** `backend/src/scm/routes` (82 further hits) is out of
scope: route handlers take the company from the request context, and every recorded
instance of this class was in a helper called from somewhere that had no request.
Widening the scope is a follow-up, not a claim this file makes.

---

## D. A guard, generator or gate that cannot fail, or that nobody runs

**Shape.** A check exists, is well written, sits in `package.json` under `audit:`
beside real gates — and is wired into no workflow, or has no non-zero exit path, or
enumerates the sites that already broke instead of scanning the class. It reads as
coverage it never provided.

**Count — 39 entries** describe a declared mechanism that had never once fired.
Measured directly at d33ac743, before this PR: of 296 workflow files, 9 fire
automatically and 287 are `workflow_dispatch` only; `audit:map`,
`audit:route-locator` and `audit:trgm` appeared in **zero** workflows; and
`check-trgm-coverage.mjs` printed `MISSING an index : N` and then `process.exit(0)`
on **both** branches.

**Worst consequence.** 2026-08-04, `[HIGH]` *"Cancel DO, Mark signed and Mark
delivered had never worked on desktop"* — discovered at the moment Cancel DO was
the remediation for the double-shipped Sales Order. From
`docs/unlinked-line-duplicate-coe.md`: *"the remediation path for a data-integrity
fault had never been exercised. A guard that has never been used is not known to
work, and the one occasion it was needed is a poor time to find out."*

**THE CHECKS.** Four repairs, all in this PR:

| What was wrong | Fix | Name |
| --- | --- | --- |
| `check-trgm-coverage.mjs` reported gaps and exited 0, on both branches, in no workflow | `--check` mode exits 1; wired to CI | `npm --prefix backend run audit:trgm` |
| The codebase-map generator crashed silently for three weeks (2026-08-12) and the map rotted | Every committed generator must still run | `npm --prefix backend run audit:generators` |
| `frontend`'s `typecheck` was `tsc --noEmit` against a `"files": []` solution tsconfig — it resolves zero inputs and exits 0 on a broken tree. Fixed to `tsc -b` on 2026-08-01 incidentally, inside an unrelated feature PR; nothing stops it going back | The shape is asserted | `node --test frontend/scripts/check-typecheck-gate.test.mjs` |
| `permissionDivergence.test.ts` asserts "no bare `.catch(() => {})` remains" over a hand-written array of the **two** files that had already broken | Scope stated in the file; the tree-wide count moved to a scanner | class B above |

**The model to copy is `backend/tests/migrationNumbers.test.ts`**, whose header
says why in one paragraph: *"On 2026-07-18 two files were numbered 0128. Within
the hour of fixing and documenting that, the SAME collision was created again at
0136 … The written rule did not prevent the second occurrence, because the person
applying the rule was the person who had just written it. So the rule is enforced
here instead of documented."* It also records the trap in guards themselves — its
first version used `readdirSync` in a `try/catch` and *"passed on an empty
listing"*, staying green with a real duplicate planted in the directory, "which is
worse than no test at all". Every check added in this PR asserts a non-empty
population for that reason. And it keeps earning its place: it caught the same
collision a third time at 0284.

`audit:trgm` is wired into **ci.yml only, never a deploy workflow** — the original
author's reason for exit-0 was that this check is a static approximation and *"a
false positive must cost a conversation, never a deploy"*. That reasoning is
correct and is preserved; a PR check is the conversation.

**Deliberately NOT gated: freshness of the generated docs.** Both
`docs/generated/codebase-map-facts.md` and `docs/generated/route-locator.md` embed
per-file line counts and per-route line numbers, so any edit to any route file
makes them stale — route-locator moved 637 lines for one added file. As a required
check that would fire on nearly every backend PR for cosmetic drift, and a gate
people learn to bypass is how this repo got a `--check` script that could not fail
in the first place. `audit:generators` gates the failure that actually happened
(the generator stopped running); freshness stays a chore, and both files were
regenerated in this PR.

---

## E. One rule, spelled by hand at every site that needs it

**Shape.** A rule that has no single home gets re-derived wherever it is needed.
Each copy is individually reasonable and locally correct, so nothing looks wrong
in review, and the copies then drift apart one edit at a time. The class is
recognisable before it drifts: the same sentence appears in more than one file's
comments, each time as if for the first time.

**Count — the date format, measured 2026-08-18.** The rule was written down
**twice**, both times as the system-wide standard:

- `frontend/src/lib/utils.ts` — *"House style is numeric DD/MM/YYYY (owner
  requirement — no 'Jun'/'Jul' month names anywhere on the desktop app)"*
- `frontend/src/vendor/shared/format.ts` — *"day-first DD/MM/YYYY (Malaysian
  standard). System-wide canonical display format (Commander 2026-06-18)"* under
  a header reading *"SOLE source of truth — no inline duplicates anywhere in
  client OR server"*

and was then re-derived by hand about **thirty** more times in **five** spellings:
`2026/08/16` on all eleven V2 list pages, `16/08/2026` from a copied regex on
their eight detail pages, `16 Aug 2026` from month-name arrays in the print
routes, raw `2026-08-16` on the Fleet screens, and the **viewer's OS locale** at
**175** native `<input type="date">`. A list page and the detail page one click
from it spelled the same date two different ways. Two comments cited the owner
for *opposite* rules about month names.

Same shape, twice more in the same week and already recorded in `BUG-HISTORY.md`:
the transfer-label vocabulary, and the both-dates-or-neither rule. Each was found
written five times, each enforced slightly differently, each missing from at
least one path.

**Worst consequence.** The 175 native inputs are not a style problem. A native
`<input type="date">` renders in the **operating system's** locale, so one field
read `16/08/2026` on one machine and `08/16/2026` on another — the literal
「有时候 MMDDYYYY」 bug the owner reported on 2026-06-18. `DateField` was built
that day to fix it and reached **14** of 189 date inputs. The screenshot that
reopened this on 2026-08-18 shows a Sales Order header reading `Aug 16, 2026`
next to a line row reading `Sep 12, 2026` — a string this repo authors nowhere
and cannot control.

**Why prose failed here specifically.** The rule was not forgotten. It was
written down, in the right words, by the right person, in the file most likely to
be read — and then reproduced anyway, because *there was no import that would
have given it to you*. `fmtCenti` shows the counterfactual: money lives in
`shared/format.ts` and the V2 pages import it, and those same files then
hand-wrote their own `fmtDate` immediately below the import.

**THE CHECK.**

| What was wrong | Fix | Name |
| --- | --- | --- |
| The date format was written at ~30 sites in 5 spellings, and at 175 more it was whatever the viewer's OS said | One `fmtDate`/`fmtDateTime` in `shared/format.ts`; a reviewed allowlist fails the build on a new hand-spelled date | `npm --prefix backend run audit:date-format` |

Its limits are stated in its own header and are real: it is a **reviewed
allowlist over date-format shapes**, not a meaning detector. It cannot see a
format assembled at runtime, it cannot tell a date from a fraction, and an
argument-less `.toLocaleString()` on a variable not named like a date is
invisible to it. `backend/tests/dateFormatGate.test.ts` plants a violation
outside the source tree on every CI run and asserts the gate exits 1, then that
it exits 0 once the plant is gone — and separately that it does **not** fire on
money or row counts, because a gate that cries wolf is a gate somebody deletes.

The format itself is proven by
`frontend/src/vendor/shared/format.date.canonical.test.ts`, which pins the two
defects the old body had and nobody in Malaysia could reproduce: `new
Date('2026-08-16')` is UTC midnight and rendered as **15/08/2026** west of
Greenwich, and `fmtDate(null)` returned **01/01/1970**.

---

## Classes with no check yet

These recurred and cost real money. They are here **without** a check, named
honestly, because the remedy is larger than one PR — not because they matter less.
The top two are the highest-value follow-ups in this file.

### E. Prod-writing scripts run outside every gate that protects `src/` — 67 entries

`backend/tsconfig.json` includes only `src/**/*.ts`. `backend/scripts` holds **335
`.mjs`** files and 3 `.ts`; 304 open a postgres connection directly; there is no
ESLint anywhere in this repo (no config file, no lint script in any
`package.json`), so `tsc` and `vitest` are the only gates and neither can see any
of the 335. This is the layer that caused the largest losses: the 2026-06-17
production wipe (`docs/prod-wipe-by-loader-coe.md`), the FAIR PNL seed that made
the owner's P&L read RM 2,221M against a real ~RM 15.86M, the 146 sofa lines
corrupted three times, and 88+ columns silently losing their `DEFAULT`
(`docs/pg-migration-dropped-defaults-coe.md`).

**Why no check here.** Two of the three obvious remedies are each their own PR:
adding `allowJs`/`checkJs` over 335 unchecked files produces thousands of errors
that must be triaged, not suppressed; and routing every script through one
prod-writer module under `scripts/lib/` — it does not exist yet — (explicit
`--target` allow-list failing closed, a
`pg_dump` before the first write, no bare `DELETE FROM scm.*`, success read from
`RETURNING` and never from `res.count`) is a migration of 304 call sites. What this
PR does cover is the one rule that is total and needed no migration: `audit:jsonb-binds`
scans `backend/scripts` as well as `backend/src`, which is where four of that
class's six occurrences were.

### F. One rule, N hand-written copies — 61 entries

The same computation, display rule or permission predicate exists in two to fifteen
places; both copies run, they disagree, and the copy production reads is the stale
one. 2026-07-23: sofa combo pricing drifted between SPA and backend for **8 hours
every morning** (UTC vs MYT), so salespeople quoted superseded effective-dated
prices, silently. 2026-08-11: `findColour` *"existed FIVE times, one hand-written
copy per script, and they had drifted apart"* — the weakest copy is what production
stored. Measured today: **18 files exist in both `backend/src/scm/shared/` and
`frontend/src/vendor/shared/`, and 11 of the 18 pairs differ.**

**Why no check here.** The repo already has the right idiom twice
(`backend/tests/phoneNormaliseMirror.test.ts`, `variantAxesMirror.test.ts`), and
generalising it is a byte-equality test over the 18 pairs with a
`DELIBERATE_DIVERGENCE` map. The blocker is that **11 pairs differ today and
nothing distinguishes a deliberate difference from a regression** — that
classification is a judgement call per pair, needs the owner of each file, and
turning the gate on before it is done would either fail main or bake 11 unreviewed
exemptions into an allowlist. Shipping the empty gate would be theatre of exactly
the kind class D is about. It is the next piece of work, and it is scoped: 18 pairs.

### H. A view's output column set, frozen at `CREATE VIEW` time

`backend/docs/scm-view-trap-coe.md`. Postgres freezes a view's columns when it is
created, even when the body says `SELECT so.*`, so a column added to the base
table is invisible through the view and a `SELECT` naming it fails at runtime.
The COE's stated enforcement is *"copy the comment block from the first call site
and grep for it on review"* — 10 `VIEW-TRAP` comments exist today and zero checks,
and the family bit twice more afterwards (2026-07-24, `Sales Orders list down on
prod`, then again after migration 0190).

**Why no check here.** The right one is a `test:pg` case — that CI job already runs
a real postgres:16 — building the view family from the migrations and asserting
every column named in the shared HEADER select resolves through the **view**, not
only through the base table. It needs the migration tree replayed into the test
database and the header select parsed; a day's work, not a side-effect of this PR.
The COE has been amended to say plainly that its rule is prose-enforced rather than
implying coverage it does not have.

### G. A guard enforced at the call sites instead of at the chokepoint — 61 entries

A company predicate, a remaining-qty cap or a race re-check is re-typed at each
endpoint that writes the table; one writer never gets it and there is no
disagreement to notice, only silence. 2026-08-04 `[CRITICAL]`: *"One Sales Order
shipped twice, and neither the over-delivery guard nor my own check could see it"*
— 「为什么一张SO可以开两张DO？？」, four units out of the door for an order of two, and
then 「你在说瞎话吗？…现在库存有没有乱，我都不知道」.

**Why no check here.** The measurable version — every `.from('<company-scoped
table>')` in a route handler must be inside a `scopeToCompany(…)` wrap — needs the
scoped-table list generated from the migrations and an allowlist triaged across
2,146 `.from(` call sites against 392 `scopeToCompany` calls. That is a real and
worthwhile audit script; it is not a side-effect of this one. The deeper remedy is
structural and better: make the raw client unreachable from route modules so
`sb.from(...)` does not typecheck and only `scoped(c).from(...)` does. Class C
above is the same shape solved at the type level for helpers, and is the precedent
to follow.

---

## Adding to this file

A new class earns an entry when it has **recurred** — one bug is an accident. The
entry needs a count with its method, the worst consequence in the entry's own
words, and the name of a check. If you cannot name the check, put it under
[Classes with no check yet](#classes-with-no-check-yet) and say what blocks it.

And when you close a COE: **a COE is not closed until it names the file path of the
check that now fails on its shape.** That is the lesson of `docs/jsonb-double-encoding-coe.md`,
which was read, believed, and reproduced anyway.
