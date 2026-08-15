## 41 migration references nobody could mark, so nobody triaged any of them [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** `check-docs-drift` reported **41** `renamed-migration` advisories —
each one a doc naming a migration filename that no longer exists, where the
NUMBER now resolves to a completely different migration. A reader following
`0210_so_amendments.sql` [external] opens `0210_scm_threepl_companies.sql` and finds
something unrelated.

Nobody acted on any of them, and that was rational: the list was mostly correct
references with no way to say so.

**Root cause.** The path check honours three markers — `[gone]`, `[planned]`,
`[external]` — and the migration-FILENAME check honoured none. So a doc could not
declare an honest reference, the advisory could never shrink below 41, and the
real drift sat inside it unread. **A list that can only grow is a list nobody
reads.**

And the markers that existed did not cover the commonest honest case here. The
migration usually still EXISTS and simply carries a different number, because
parallel PRs collide and the loser renumbers. `[gone]` would have been a new lie.

**What the 41 actually were** — established by reading each one's context, not by
pattern:

| kind | count | marker |
|---|---|---|
| 2990's migration tree, said so in the sentence (`migrations-postgres/`, "2990's ...") | 8 | `[external]` |
| the migration exists under a new number | 16 | `[renumbered]` (new) |
| genuinely deleted, incl. `MIGRATION-RETIREMENTS.md`, whose subject IS retirement | 17 | `[gone]` |

**The trap avoided.** The obvious fix — a script that renumbers every reference
to the current file — would have rewritten *2990's* `0210_so_amendments.sql` [external] into
a Houzs migration number. That reference was CORRECT; the checker resolves
against this repo's tree and the doc was talking about another repo's. Reading
one line of context is what caught it.

**Fix.** The migration-filename check honours the same markers, plus a fourth,
`[renumbered]`, which tells the reader the file is findable — just not at that
number. All 41 marked with what is TRUE of each.

**Measured: 41 -> 0.** Not because anything was suppressed — every reference now
carries a reader-facing statement — but because the list is finally a list of
problems. Proven by adding one fake reference to a doc: it appears immediately
against a clean baseline, and removing it returns to zero.

**Ref.** 2026-08-15. Lesson: **a detector with no way to record a legitimate
finding produces a backlog instead of a signal** — and the fix is vocabulary, not
suppression. CLAUDE.md already said it: *"Do not add a silent exemption list
instead. A suppression the reader cannot see is a suppression nobody
re-checks."*
## Five docs sent the reader to a line number that no longer exists [low]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** `check-docs-drift` reported five `line-past-eof` advisories — a doc
citing `file.ts:161` where the file has 140 lines. Following one lands nowhere;
following a line number that is merely WRONG rather than past the end lands on
unrelated code and is not detected at all.

**Root cause.** A line number in prose is a fact with a very short expiry — it
rots the moment anything ABOVE it is edited, which is most edits. The worst
example here was not past EOF at all: `docs/2990-mirror-full-design.md` cited
`so-revision.ts:157-428` for `applySoAmendment`, and that function begins at line
271. The number was inside the file, so nothing flagged it, and it pointed at
something else entirely.

**Fix, and it is a convention rather than five edits.** Cite the SYMBOL, not the
line: a function name, an exported const, a route path. Those move with the code
and survive an edit above them.

| was | now |
|---|---|
| `so-revision.ts:157-428`; `so-mirror.ts:161-169` | `so-revision.ts` -> `applySoAmendment()`; `so-mirror.ts` -> the `soMirror` router |
| `backend/src/routes/users.ts:2291` (x2) | `users.ts` -> the second `POST /:id/impersonate` registration |
| `backfill-sofa-special-orders.mjs:237` | the filename alone — the entry's point was the CONTENT it wrote |
| `schema.pg.ts:905-1307` | "the `scm_*` table block in `schema.pg.ts`" |

Each replacement was checked to RESOLVE before it was written:
`export async function applySoAmendment` and `export const soMirror` both exist,
and `users.ts` carries four `/:id/impersonate` mentions.

**Measured: 5 -> 0.**

**Not fixed here, and characterised rather than left as noise.** Six
`unknown-permission` advisories remain and all six are FALSE POSITIVES — the
checker's own message admits it ("or it is a table.column that shares a prefix
with a real key"). `projects.venue`, `projects.state`, `projects.stage`,
`projects.name` and `projects.setup_start_at` are COLUMNS, read in prose about
data: *"`projects.venue` is free[-text]"*, *"read `projects.setup_start_at`"*.
Teaching the checker to tell a table.column from an `<area>.<verb>` permission
needs the real column set, which is a separate change.

**Ref.** 2026-08-15. Lesson: **a line number is the most perishable thing you can
put in a document**, and the dangerous half of that class is invisible — a number
still inside the file points confidently at the wrong code and no checker can see
it.
## #2110 said every other floating menu was already portalled. Four were not [high]

<!-- area: Frontend + mobile -->

**Symptom.** Owner, after #2110 fixed the State dropdown: *"这个你要全系统看一下,
还有没有同类的问题。如果全部都有这个问题的话,都是要修复掉"*. On production's
**New Sales Order**, opening the **country dial code** next to Phone shows the
search box and **not one country**.

**Root cause, traced.** The same mechanism as #2110, in components that PR's own
body listed as already converted. `position: absolute` escapes layout FLOW but
not an ancestor's OVERFLOW clip, so a menu rendered as a sibling of its trigger
is sliced by the card it sits in. `#2110`'s note — *"Every other floating picker
in this repo … had already been converted"* — was true of the three it named and
false of the rest; this entry is what re-checking it found.

**PROVEN in the browser, on prod, not inferred.** Measured with
`getBoundingClientRect()` + `elementFromPoint()` through the Chrome tooling
against `erp.houzscentury.com`, 2026-08-15:

| site | measurement |
|---|---|
| `PhoneInput`, `/scm/sales-orders/new` | 287px panel, **247px cut** by `SalesOrderNew.module.css .card { overflow: hidden }`; **0 of 25** countries hit-testable |
| `SalesOrderNew` debtor list, same page | panel painted **49px ABOVE** the input (top 314 vs input bottom 363) at **1678px** wide against the input's 1200px, and the card left **130px** of room for a `max-height: 260px` list |
| `SearchableSelect` (City, Postcode), same page | portalled, so no ancestor clip — but the panel ran to y=890 in a **779px** viewport, and `position: fixed` puts that beyond any scroll |

The debtor list's misplacement has its own cause worth recording:
`SalesOrderNew.module.css` never had a `.field { position: relative }` (its
sibling `SalesOrderDetail.module.css` does, at `:208`), so the absolute list
resolved against the card body rather than the field. One bug hid inside the
other — the clip was visible, the wrong anchor read as "the list is just wide".

**Fix.** One shared implementation, `frontend/src/lib/anchoredPanel.ts`
(`measureAnchoredPanel` + `useAnchoredPanel` + `anchoredPanelStyle`): portal to
`<body>`, `position: fixed`, geometry from the trigger's rect, re-measured on
capture-phase `scroll` and on `resize`, flipped above when the room below cannot
hold the list, `max-height` clamped to the room actually available. Lifted out of
`StatePicker`, which now consumes it, so the pattern is shared rather than copied
five times. Converted: `PhoneInput` (≈20 call sites), `SalesOrderNew`,
`ConsignmentOrderNew` and `ConsignmentOrderDetail` debtor lists;
`SearchableSelect` and `SalesOrderDetail`'s already-portalled list gained the
flip and the clamp they were missing.

**The trap a portal introduces, and the guard for it.** A document-level
outside-click handler tests `rootRef.contains(e.target)`. Once the panel is in a
`<body>` portal it is no longer inside `rootRef` **in the DOM**, so a `mousedown`
on an option reads as "outside", closes the list, and the option unmounts before
its `click` can fire — the menu becomes unpickable. `PhoneInput` is the one
converted component with that handler; it now tests the panel too, and
`PhoneInput.test.tsx` asserts a mousedown inside the panel does not close it.

**Two things the hook does that the copies did not.** An unchanged measurement
returns the PREVIOUS object — a scroll gesture fires dozens of events and each
fresh object re-rendered the whole picker. And that same identity check is what
stops a caller with an unstable ref from spinning; both are pinned by tests.

**Verified.** `PhoneInput.test.tsx`'s 4 placement tests fail against
`origin/main`'s component and its 5 behaviour tests pass — the intended split.
In a browser: the pre-fix component in the real `.card` markup reproduced prod's
numbers exactly (`cutBottom: 247`, 0 of 25 countries), and the fixed one is
`parentIsBody: true`, `position: fixed`, no clippers, 8 countries visible and all
25 reachable; near the window bottom it flips above and stays on screen.

**What this did NOT cover.** Native `<select>` is not this bug — the browser
paints those above everything — and the ones on these forms were left alone.
`RowActionsMenu` on Project Maintenance, the eight `SplitDropdown` toolbar menus,
`Inventory`'s warehouse filter and mobile `SoSearchField` all carry the
anti-pattern; each was opened on a real page and measured `cutBottom: 0`, so
they were left alone rather than converted on suspicion. Four more —
`ServiceCases`' QC Result select, `Team`'s "Reports to" autocomplete and
`MailCenter/Inbox`'s bulk-label and label-colour menus — sit inside an ancestor
that a code read shows is `overflow-hidden`, but were **not** reproduced live and
are **not** fixed here. That is the open item.

**Ref.** PR #2223 · 2026-08-15 · follows #2110 (2026-08-13).

## The same question about this repo gave a different answer every time it was asked [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom, in the owner's words (2026-08-14):** *"现在有的问题就是每次问的答案都不
一样，如果我问你这个 ai 你给我的答案都是错的"* — and, the next day, *"我问你同一个
问题问三次，你应该给出的都是同样的答案"*.

He is describing a real property of this repo, not an impression:

| the question | answers it has given |
|---|---|
| how many SCM handlers are there? | 632, then 1019 — the checker changed, not the code |
| how many route modules have no guide? | 76 of 141, then 70 of 134, **one hour apart** — one count included `.test.ts` files |
| which status checks block a merge? | `CLAUDE.md` carried a list that was wrong, twice |
| how many unscoped writes? | 0, then 20 — the matcher had been dead |
| how many lines of file-size debt? | 1,430 then 1,391, hours apart, while it was being written down |

**Root cause.** Every one of those answers was RE-DERIVED BY READING, and reading
is not repeatable. Two readers grep differently, one includes a directory the
other does not, and both write the number into a doc where it then rots. The
`audit:` generators fixed this for four artifacts; everything else was still
answered from memory or from a fresh grep.

**Fix.** `scripts/explain.mjs` — a registry of questions, each COMPUTED from the
tree. An answer is only registerable if it carries:

- a **denominator** — "76 modules have no guide" is unarguable; "76 of 141" can
  be checked
- **refs** — `file:line`, so the reader looks instead of believing
- a **`minCorpus`** — under it the question REFUSES. Three checkers here have
  reported a clean run because their pattern stopped matching, so "the scan found
  nothing" is now a different outcome from "the answer is zero", by construction.

Five questions to start, each one chosen because it is in the table above.

**The property is tested, not promised.** `scripts/explain.test.mjs` runs every
question **three times** and compares the answers BYTE FOR BYTE. Proven red: an
injected `Math.random()` in one answer fails it with
`so-statuses: run 1 and run 2 disagree`. A question that lists a directory
without sorting fails there too, which is the point.

**And the docs are wired to the same source.** A doc can hold
`<!-- explain: <id> -->…<!-- /explain -->`; `--write` fills it and `--check-docs`
fails when it drifts. That is the gap `check-docs-drift` cannot cover — it
resolves PATHS, so a doc whose file exists and whose NUMBER is wrong reads as
clean. Proven red: editing `292 files` to `999 files` in the filled block fails
`--check-docs` with exit 1.

**Its own first bug, kept as the example.** `--write` filled the EMPTY EXAMPLE
block inside `docs/EXPLAIN.md`'s ``` fence — the page teaching you to write an
empty block demonstrated a filled one. Fills now skip fenced regions, and a test
pins the example's emptiness.

**Ref.** 2026-08-15. `docs/EXPLAIN.md`. Lesson: **"the same answer every time" is
a property you can test, not a discipline you can promise** — and the test is
three runs and a byte comparison.
## Five inbound-email parsers ran on attacker input with no test, inside a file over its size ceiling [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Context.** The owner's decision, 2026-08-15: pay the file-size debt down BEFORE
making `file-size` a required check, so the lock never blocks an urgent fix.
`main-protection` has `bypass_actors: null` and `current_user_can_bypass: never`
— verified, not assumed — so a required check that blocks a production fix cannot
be overridden by anyone, including the owner. Shrink first, lock second.

This is the first payment: `routes/mail-center.ts`, the smallest offender, 6
lines over.

**What was there.** `toArray`, `stripHtml`, `safeIso`, `base64ToBytes` and
`safeFilename` — five pure functions, inline in a 2,329-line route file, **with
no test of any kind**. Every one of them runs on the inbound-email webhook, so
every input is attacker-controlled:

- `safeFilename` is the path-traversal guard on the R2 object key. Nothing
  asserted that `../../etc/passwd` became `passwd`.
- `base64ToBytes` returns `null` rather than throwing so one bad attachment
  cannot abort a whole email. Nothing asserted it.
- `safeIso` keeps a malformed `Date:` header out of a timestamp column. Nothing
  asserted it.

**Change.** Moved VERBATIM to `services/mail-parse.ts` — pure, so no env, no
database, no R2 comes with them — and `backend/tests/mailParse.test.ts` now pins
the behaviour. The tests passed on their FIRST run against the moved code, which
is what makes "moved verbatim" a checked claim rather than an assurance.

`mail-center.ts` 2,329 -> 2,284, under its 2,323 ceiling; the ceiling then
lowered to 2,284 so the gain cannot be re-consumed. **Only that one ceiling** —
`--update` would have taken back 276 lines of slack across 9 other files, and
with four PRs in flight that could break one of them mid-air.

**A red proof that could not be taken, stated rather than faked.** Adding lines
back to prove the new ceiling bites does NOT fail this PR, and the gate is right:
it charges a file only when THIS change GREW it (`x.lines > was`, where `was` is
the line count at the merge base). At 2,286 the file is still smaller than the
2,329 it was, so nothing is charged. The lowered ceiling binds the NEXT change,
whose base will be 2,284. Verified by reading `charged()` in
`scripts/check-file-size.mjs`, not by an experiment that would have proved
something else.

**Ref.** 2026-08-15. Debt 1,391 -> 1,385 lines, 13 -> 12 files.
## A recorded payment never reached AutoCount — BALANCE went stale the moment it was sent [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner's goal for the write-back, in his words: *"我们记录新的
payment，它就是可以进去。"* It did not. #2218 started sending the outstanding
balance as the `BALANCE` UDF, and from that moment the account book carried a
figure that was correct when the order was last SAVED and wrong from the next
payment onwards. A fully settled order kept showing a debt until somebody
happened to edit a line or the header.

**Root cause, traced by enumerating the call sites, not by reading the design.**
Every SO mutation route funnels through `queueAcSoEdit`, and there are eleven
such call sites in `scm/routes/mfg-sales-orders.ts` — the header CAS save, line
add / edit / delete, the three `tbc-*` swaps, the price override. The last one
sits at line 10403. The three routes that mutate the payments ledger start at
10958 (`POST /:docNo/payments`), 11146 (`PATCH`) and 11357 (`DELETE`), and none
of them queued anything. A payment changed money the account book holds and the
ERP said nothing about it.

Two things kept it invisible:

- `src/scm/lib/autocount-outbox.test.ts` has a case literally named *"an EDIT
  carries it too, so a payment taken after the create reaches the book"*. It
  passes, and it always would have: it calls `enqueueEdit` itself. A composer
  test cannot see a missing call site.
- `tests/autocountWritebackWiring.test.ts`'s *"every SO mutation path queues an
  edit"* checks seven hand-listed places. A payment is an SO mutation and was in
  none of them, so the word `every` was false and the suite stayed green — the
  **unverified-completeness-claim** class at the top of this file, this time in a
  test name rather than a PR body.

**Fix.** The enqueue goes into `recordSoPaymentRow`, the factored insert core,
NOT into the HTTP route: `scan-so.ts` books scanned receipts through the same
core with no request context, so a rule written into the route would have
covered the payments a human typed and silently missed every scanned one — this
module's recurring shape. `PATCH` and `DELETE` call `queueAcSoEdit` in their own
closures, having no shared core. `POST /:docNo/payments/:id/slip` deliberately
does not: it attaches proof and moves no money.

`src/scm/routes/soPaymentQueuesAcEdit.test.ts` pins the core — the queued edit
must carry the balance AFTER the payment (500.00 ordered, 300.00 taken, `200.00`
sent), a settling payment must send `0.00` rather than dropping the key, the
toggle OFF must queue nothing, an order with no AutoCount counterpart must queue
nothing, and a dead queue must not fail the payment. Its three positive cases
were observed RED with the enqueue neutralised. The three route anchors are
pinned in `tests/autocountWritebackWiring.test.ts` under their own test rather
than by widening the "every" claim that already failed to hold.

**Ref.** 2026-08-15, PR #2228.
## The address cascade only ran downhill, on eight of the eleven forms [high]

<!-- area: Frontend + mobile -->

**Symptom.** Owner, 2026-08-15: *"City 和 Postcode … 它可以由上往下，也可以由下往上，
双边启动都是可以的。"* On New Consignment Order — and seven sibling forms — City sat
disabled reading *"— pick state first"* and Postcode disabled reading *"— pick city
first"*. An operator holding a postcode the customer just read out could not enter
it: the only way in was to already know the State.

**Root cause, traced.** Two distinct faults, both from the wiring being
hand-copied per form rather than shared.

1. **Reverse resolution existed and was never called on eight forms.**
   `resolvePostcode` / `resolveCityState` / `allCities` / `allPostcodes` have
   been in `localities-queries.ts` since the SO work, with tests whose own header
   names the SO forms as the caller. Only `SalesOrderNew`, `MobileNewSO` and
   `SalesOrderDetail` (#2117) ever wired them. The other eight kept
   `disabled={!form.state}` / `disabled={!form.city}`.

2. **Top-down stopped one step short, on ALL of them — including the three that
   already had the reverse.** Every copy computed the postcode pool as
   `(state && city) ? postcodesInCity(...) : allPostcodes(rows)`. With a State
   picked and City still blank, that second arm is the whole country. Observed on
   production 2026-08-15 in Chrome on `/scm/sales-orders/new`: State set to
   **Johor**, Postcode typed `43300` — a **Selangor** code — and it was offered.
   Picking it silently flipped the State the operator had just chosen.

**Fix.** One shared layer, `frontend/src/vendor/scm/lib/address-cascade.ts`:
`cityOptionsFor` / `postcodeOptionsFor` for the option pools and pure
`pickState` / `pickCity` / `pickPostcode` returning the whole
`{state, city, postcode}` triple. Pure and triple-returning because the call
sites disagree on state shape — some hold three `useState` atoms, some one
`form` object — and an object-shaped form must write the result in ONE `setForm`
or the State picker's own handler (which exists to CLEAR the cascade) wipes the
value just picked. Two new derivations close fault 2: `postcodesInState` for
State-picked-City-blank, `postcodesForCity` for the ambiguous-city case where
State legitimately stays empty. All eleven forms now call in; the placeholders
say *"Pick city — State fills in"* instead of describing a gate that is gone.

**Ambiguity stays refused.** `resolveCityState` still returns null for a city in
two states and `resolvePostcode` still returns null rather than pick a side —
`pickCity`/`pickPostcode` leave State alone in that case rather than guess.
Pinned in `address-cascade.test.ts`.

**Ref.** 2026-08-15. Lesson: **the reverse of "a rule expressed twice is two
rules" — a rule expressed once per FORM is one rule per form.** Three copies of
this cascade had already drifted from each other (one cleared the postcode in
JSX, one inside the resolver) and all three carried the same nationwide-pool
bug, so the bug that was fixed three times in a row was fixed nowhere. The
trigger to extract is not elegance, it is the fourth copy.

## Four things the cutover pulled out of AutoCount that the write-back never put back [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner, on the write-back's fidelity: *"之前我们有从 AutoCount 抽取
数据进来过我们的 ERP … 他抽取了什么东西，就代表什么东西都是要进来的 … 既然我抽出
来了，就代表我是需要的。"* Concretely, he reported a line delivery date arriving in
the account book as the DOCUMENT date on orders where the ERP holds none, and it
should be blank.

**Root cause, traced against the committed extract rather than reasoned about.**
`backend/scripts/data/ac-fidelity-so-headers.json.gz` (13,015 rows, 18 fields) and
`ac-fidelity-so-lines.json.gz` (60,939 rows, 13 fields) are exactly what the
cutover read off the live `AED_HOUZS` book, so the gap is a diff and not an
opinion. Four findings, each the module's own recurring shape — **the ERP holds
the fact in one column and the composer reads another**
(`docs/autocount-writeback-golive-coe.md` section 2, where it had already cost
three incidents):

1. **`UDF_BALANCE`** — non-zero on **2,339 of 13,015** headers, and never sent.
   The ERP has three candidates and the obvious one is wrong:
   `mfg_sales_orders.balance_centi` is rewritten to the GROSS total by
   `recomputeTotals` on every edit, so it never reflects a payment — and it LOOKS
   right precisely because the cutover's own `UDF_BALANCE` landed in it
   (`check-migration-fidelity.mjs:95`). The live answer is total minus the
   payments ledger, plus the legacy header deposit only where no `is_deposit`
   ledger row exists, which is what `GET /mfg-sales-orders/:docNo` and the
   customer print show.
2. **`DeliverPhone1`** — on **120** headers, genuinely different from `Phone1` on
   **37**. Two contacts, two columns (owner: *"应该是有一个 Delivery Contact，一个
   是 Contact"*): the ERP's is `emergency_contact_phone`, which is where
   `import-ac-outstanding-so.mjs:302` put AutoCount's own `DeliverPhone1` at the
   cutover. The CREATE was masked by the service's `Or(DeliverPhone1, Phone)`
   fallback; the EDIT has no fallback, so a changed delivery number never reached
   the book at all.
3. **`SODTL.DeliveryDate`** — **NULL on 11,886 of 60,939 lines**, 2,268 documents
   entirely blank, so the book plainly holds blanks. `SO_ITEM_COLS` did not select
   `line_delivery_date`, so `soLine` left it undefined and the key was never sent;
   and `AcSyncService`'s `if (dd.HasValue)` could not tell an absent key from a
   null one, so no payload could ever have asked for a blank. What landed was
   AutoCount's own default, which is the document date the owner saw.
4. **`Desc2` was sent but half-composed.** The cutover PARSED Further Description
   to get the ERP's variants, so the specification has to go back; the composer
   emitted `Col / Fabric / Seat / Leg` and read colour off `fabricColor`, the
   GRN-family key. A bedframe keeps its colour in `fabricCode` / `colourLabel`
   and its build in `gap` / `divanHeight`, so an ERP-created bedframe reached the
   book with an EMPTY Further Description — while the book's own text carries
   `COL` on 6,741 of its 15,950 populated values, `DIVAN` on 5,778 and `GAP` on
   2,620, its three commonest labels. Two renderers for one string, which is COE
   lesson 4 exactly.

**`SODTL.UOM` was the fifth candidate and is REFUTED, which is the finding worth
keeping.** It is in the extract and unsent, so it reads as a gap. Measured against
the book's own `ItemUOM` rows, **59,582 of the 59,624 lines carrying a UOM carry
one the ITEM's master row holds** (the 2 exceptions are the `unit`/`UNIT` case
typo) — the line never decides it. And the ERP's `uom` column is written
`?? 'UNIT'` at every create path, while **363 of the 758 distinct item codes on
those lines have no `UNIT` row at all**, their only UOM being `SET`. Sending it
would have put `UNIT` on a line whose item only has `SET`, against a column the
detail foreign-keys to `ItemUOM`, and lost the whole document — the same shape as
`FK_SODTL_Location`. Owner: every SKU already carries a UOM, set when the item is
opened.

**Fix.** `BALANCE` and `DeliverPhone1` on both create and edit; the line delivery
date on both, sent PRESENT-AND-NULL on a create and omitted on an edit; `Desc2`
composed by `buildVariantSummary`, the ERP's own renderer.

The balance rule moved into `backend/src/scm/shared/so-outstanding.ts` and the SO
detail route now calls it, so the account book and the screen cannot compute
different numbers. `AcSyncService` guards the delivery date on `ContainsKey`
instead of `HasValue`, which is what makes a blank expressible at all — the
property is `DeliveryDate:Nullable`1` on all six detail classes.

Three rules the change keeps: **zero is a value** (a settled order sends `"0.00"`,
since `udf()` drops a falsy entry and the book would otherwise show a paid debt
forever); **no total means no key** (zero would declare a real debt settled in a
licensed ledger); and **an edit never blanks what the book holds** (a null
delivery date and a blank delivery phone both omit).

A new refusal, `Desc2TooLongError`, comes with the richer Desc2: `SODTL.Desc2` is
`nvarchar(100)` and the book is AT that ceiling — the longest of its 15,950 values
is exactly 100 and none is over — so an over-long line becomes a readable
`skipped` row instead of a lost document behind a 500. Same `AC_DESC2_MAX` the
sofa collapse already refuses on.

**Ref.** 2026-08-15. Divergence **D3** struck from the register in
`autocount-writeback.contract.test.ts` (11 -> 10). Lesson: **an extract is a
specification.** "Which fields should we send?" was answered for months by
judgement; the committed cutover files answer it by subtraction, and they also
refute one of the five candidates that judgement would have shipped.
## #2220 fixed the rows and left the tiles saying the opposite [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The same self-contradiction #2220 was opened for, one component
further up. For two `failed` rows carrying a re-queue marker, `/autocount-sync`
now renders both rows as **Re-queued** — and the headline above them still reads
*"2 documents need attention (2 failed) — in the ERP and not in AutoCount"*, the
Failed tile still reads **2**, the Re-queued tile reads **0**, and the Re-queued
filter returns nothing.

**Root cause, traced.** #2220 taught `acOutboxState` that a re-queue marker
counts on either terminal state. That function decides the per-ROW rendering and
the JS narrowing. It does not decide the COUNTS: those are five separate
company-scoped SQL head-counts inside `routes/autocount-outbox.ts`, which kept
their own skipped-only rule —

```
countRows(c, (q) => q.eq('status', 'skipped').like('last_error', REQUEUED_LIKE))
```

— so `failed` was counted raw, `requeued` counted only skips, and
`attention = nFailed + nSkipped` inherited both. `statusesFor.requeued` was
`['skipped']` for the same reason, which is why the filter came back empty.

**PROVEN, not inferred.** A probe against the route on `main` (`c464bd386`) with
exactly two re-queued failed rows returned
`counts {"pending":0,"sent":0,"failed":2,"skipped":0,"requeued":0,"attention":2}`,
row states `[["requeued",false],["requeued",false]]`, and `?state=requeued` → `[]`.
The four new tests fail against that tree and pass against this one.

**Fix.** The marker is honoured per terminal state in SQL too: count re-queued
failures and re-queued skips separately, subtract each from its own total, and
sum them for the Re-queued tile. `statusesFor.requeued` takes both statuses and
`state=failed` narrows out re-queued rows the way `state=skipped` already did.
`total` switched to the TERMINAL counts — it had been reading the outstanding
failed count, which would have made re-queued rows vanish from the total while
still being listed under it.

**Why the first fix stopped where it did.** #2220 changed the shared taxonomy
and the canonical mirror, which is where the rule belongs — but the route had a
SECOND copy of the same rule expressed in PostgREST predicates, and no test
covered a re-queued failed row's COUNTS. The page's own tests all asserted rows.

**A THIRD copy, found by looking for it.** `check-autocount-outbox-health.mjs`
— the workflow the owner was told to run before the page existed, and still the
headless reader — selects `WHERE status = 'failed'` and prints the result under
*"each is a document that is in the ERP and NOT in AutoCount"*. It had the same
bug, and it is the same false statement about a live account book. Fixed in the
same PR: the totals query counts the re-queued rows per status with a `FILTER`,
the failed detail query excludes them, and they are reported under RE-QUEUED
with the skips. Not found by a test — found by grepping for every place the rule
is expressed after the first two disagreed.

**Ref.** 2026-08-15. Lesson: **a rule expressed twice in two languages is two
rules** — and it was expressed three times here. The taxonomy module, the route's
PostgREST predicates and the health script's SQL all encoded "re-queued means
history"; #2220 fixed the one written in TypeScript, and both of the ones written
as queries went on disagreeing with it. When a fix lands in a shared module, grep
for the rule's other spellings before calling it done.

## The write-back queue had no reader the owner could open [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Owner, 2026-08-15: *"你确保有完整的记录，就是我可以看得到 ... 如果它是
在排队、skip、planning 还是 fail 等等，fail 的话是什么原因？everything 都要呈现出
来，要不然我就不知道."* He could not tell whether a document he had saved had
reached AutoCount.

**Root cause, traced.** `scm.autocount_outbox` records every operation the ERP
ever asked AutoCount to perform, with its status and its reason — and nothing in
the ERP read it. `grep -rn autocount_outbox backend/src` returns the enqueue, the
drain, the re-queue and their tests, and no route: there was no HTTP surface over
the table at all. Its only two readers were
`backend/scripts/check-autocount-outbox-health.mjs` and
`backend/scripts/check-cancel-parity.mjs`, both reachable only by dispatching a
GitHub Action and reading the log — which the owner cannot do and, per the repo's
own standing rule, should not have to.

That matters most for the two states that mean a real divergence. A `failed` row
is a document that is in the ERP and NOT in the account book. A `skipped` row is
one the ERP declined to send on purpose, with a named remedy. Both were invisible
in the product.

**Fix.** `GET /api/scm/autocount-outbox`
(`backend/src/scm/routes/autocount-outbox.ts`) plus the page at `/autocount-sync`
on both surfaces (`frontend/src/pages/AutoCountSync.tsx`,
`frontend/src/mobile/MobileAutoCountSync.tsx`, sharing
`frontend/src/lib/autocountOutbox.ts`). Counts by state first, then the list,
with every row's reason printed in full. Company-scoped on all seven statements
(#2201's lesson), gated on the new `scm.autocount.read` or the existing
`settings.manage`, and read-only — re-sending stays in the re-queue workflow
behind its `includeFailed` opt-in (#2189).

**The classification was NOT re-derived**, which was the real hazard: a second
copy of the skip taxonomy is how the health check once told an operator to
backfill DtlKeys for an item-map problem (#2094). It now lives once, in
`backend/src/scm/lib/autocount-outbox-status.ts`, with a plain-node mirror for
the script (which cannot import TypeScript) refereed by
`backend/src/scm/lib/autocountOutboxStatus.canonical.test.ts`.

**Ref.** 2026-08-15. Lesson: **a queue nobody can read is a queue nobody reads.**
The mechanism was durable, retried, dead-lettered and recorded its own reasons
for eight months of work, and still failed the one test that matters — the person
responsible for the account book could not see it.

## A concise-arrow beforeEach registers your mock as vitest's teardown [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** One test in `frontend/src/pages/autoCountSync.test.tsx` failed in
26 ms with `Error: the queue is unreachable` — the exact error the test had
armed with `mockRejectedValue` — attributed to the line that CONSTRUCTED the
Error, before any assertion could run. The page was fine: rendering it with the
same rejection in a scratch file passed.

**Root cause, traced, not guessed.** The file had
`beforeEach(() => apiGet.mockReset())`. `mockReset()` is chainable and returns
the mock, so the concise arrow RETURNS A FUNCTION — and vitest calls a function
returned from a hook as that test's teardown. So vitest invoked `apiGet()` after
every test; in the one test that had armed a rejecting implementation, the
teardown's rejected promise was awaited and became the test's failure.

Proven by bisection (adding braces fixed it; `mockClear` instead of `mockReset`
did not; a `QueryCache` `onError` did not — so it was never an unhandled React
Query rejection) and then directly, with a two-test probe whose `beforeEach`
returned a counter-incrementing function: the counter read `1` at the start of
the second test.

**Fix.** Braces instead of a concise arrow at both sites that had the shape —
`frontend/src/pages/autoCountSync.test.tsx` and
`frontend/src/vendor/scm/lib/so-versioned-mutation.test.ts` — each with a comment
naming the trap. The second was latent rather than failing: every test there arms
`...Once` implementations, which its own calls consume, so the teardown call
found an empty mock and returned `undefined`. It would have broken on the first
plain `mockRejectedValue`.

**NOT fixed here, and it is the thing that stops the third one:** no check
catches this shape. `grep -rEn 'beforeEach\(\(\) => [A-Za-z_$][A-Za-z0-9_$.]*\.mock[A-Za-z]*\('`
over `frontend/src`, `backend/src` and `backend/tests` found exactly the two
sites above, so the tree is clean today — which is precisely when a lint rule is
cheap to add. Filed as a follow-up.

**Ref.** 2026-08-15. Lesson: **an error attributed to a line that cannot explain
it is a harness bug, not a code bug.** The instinct was to blame React Query's
error handling; it took a scratch reproduction that PASSED to turn the search
around and look at the hook.
## CLAUDE.md told every session four things that were not true, and it is auto-loaded [high]

**Symptom.** None you could see. `CLAUDE.md` is loaded into every session before
anyone reads a line of code, so a wrong sentence in it is not a stale document —
it is a wrong belief installed in everyone who works here. It has form: it
described the database as D1 SQLite for a month after the Postgres cutover, and
carried a required-status-check list that was simply wrong.

**Four found on 2026-08-15, all in the file that everybody trusts most.**

*1. "CI ... does NOT run `audit:route-locator` or `audit:map`."* `audit:map` had
been a `ci.yml` step since the previous day —
`grep -c audit:map .github/workflows/ci.yml` answers 1. The claim sends the
reader away from regenerating the map, and then their PR fails on it. Only the
`route-locator` half was true.

*2. The same bullet said it TWICE, in two paragraphs that contradicted each
other*, and the second began mid-sentence — `largest files), regenerated from the
tree.` — a paste that never deleted what it replaced.

*3. A worked drift example that no longer held:* "`codebase-map-facts.md` IS
drifted at HEAD — it records `consignment-returns.ts` at 957 lines against an
actual 1118". The map and the file now both say 1141. **A stale worked example is
worse than no example**: it reads as freshly measured evidence.

*4. "Treat `skipped` on `backend` as a failed deploy", full stop.* Over-broad in
the expensive direction. `deploy.yml`'s filter is `backend/**` plus the workflow
itself, so a docs-only PR legitimately skips that job with the RUN concluding
`success`. Measured the same day: #2207 touched only `BUG-HISTORY.md`,
`docs/generated/` and `scripts/check-file-size.mjs`, and the old wording would
have had someone call it a failed production deploy. The signal is the PAIR —
`failure` + `skipped` is the incident; `success` + `skipped` is the filter
working.

And one of these was self-inflicted the same night: the shebang rule named
`tests/scale*.node.mjs`, files renamed to `*.test.mjs` by #2180 — the rename did
not update the rule that points at them.

**Root cause.** `check-docs-drift` resolves a claim whose PATH is gone. It cannot
resolve a claim about BEHAVIOUR — "CI does not run this" — and that is exactly
the shape that misleads, because it reads as settled fact and points the reader
the wrong way. Nothing checked it, so nothing caught it.

**Fix.** The four sentences are corrected, each with a dated `CORRECTED` note
saying what it used to say and why that was wrong — deleting the error silently
would leave the next reader unable to tell which version they remember.
`backend/tests/claudeMdClaims.test.ts` then pins them: the gated/not-gated table
is compared against `ci.yml`, the deploy rule must keep the run-conclusion pair,
and the shebang rule's named test files must exist.

**Proven red in BOTH directions**, which is the point for a claim like this:
editing the table to say "NO" fails it, and removing `audit:map` from `ci.yml`
fails it too, with the message naming which side moved.

**Ref.** 2026-08-15. Lesson: **the more trusted a document is, the more expensive
its errors are, and CLAUDE.md is the most trusted one here** — it is read by
everyone, before anything else, and never questioned. Its checkable claims should
be checked.

## The file-size gate told you to "re-baseline", and there is no such operation [low]

**Symptom.** The inherited-debt block ends *"Whoever grows a file owns its
ceiling. Fix these where they were grown, or re-baseline."* Every reader who
took the second option went looking for a command that does not exist.

**Root cause.** `--update` calls `lowerCeilings`, which is
`Math.min(current, lines)` — it can only LOWER a ceiling, and only for a file
that already got smaller. Editing a number upward by hand is caught by
`findRaisedCeilings` and fails CI. Both behaviours are correct and both are unit
tested (`--update lowers a ceiling but will NOT raise one to clear a violation`,
`scripts/check-file-size-ratchet.mjs`). So there is exactly ONE way to clear this
debt — shrink the file — and the message named a second one that cannot be done.

**Measured, and it is why this is worth fixing rather than shrugging at.** Every
crossing happened between 2026-08-12 and 2026-08-14 — the ceilings were baselined
by #2139 on 2026-08-12, so the whole debt is three days old.

**Do not quote a total from here; run `node scripts/check-file-size.mjs`.** It
prints the aggregate now, which is the point of this change. Two readings taken
while writing this entry, hours apart, gave *14 files / 1,430 lines* and then
*13 files / 1,391*, and `frontend/src/pages/Projects.tsx` moved
14,996 -> 15,053 -> 14,987 -> 14,990 -> 15,056 -> 15,128 across six commits on a
single day. A number typed here would have been wrong before the PR merged —
which is the rule this repo already has about numbers in prose, applied to
itself.

`file-size` is not a required status check, so a PR that trips it merges, and the
next author inherits it. That is the mechanism; the total is just today's reading
of it.

Attribution to a specific PR was ATTEMPTED and is not reliable: most
first-crossings land on MERGE commits (one `merge: take origin/main (7 commits)`
crosses five files at once), which is where two histories joined, not where the
lines were written. **UNKNOWN**, recorded rather than dressed up — "fix these
where they were grown" is not currently answerable by this repo's history.

**Fix.** The message now names the real remedy and prints the aggregate, so the
debt carries a number every time the gate runs instead of being a list you scroll
past.

**NOT fixed here, and it is the owner's call.** Whether `file-size` should become
a required status check. It is the only thing that would stop this accumulating —
and it would also block merges on a ratchet that 14 files currently fail, so it
is a judgement about cost, not a defect to fix unilaterally.

**Ref.** 2026-08-15. Lesson: **an error message is part of the tool.** This one
sent readers to an escape hatch that the same repo's own unit test proves cannot
exist.

## The bug index filed 25 entries under Sales orders because of the English word "so" [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** None, which is the point. `docs/generated/bug-index.md` is the only
way into a 9,000-line ledger — "have we hit this before?" is answered by reading
one area's rows. `audit:bug-index` was green throughout: it checks that the FILE
matches the GENERATOR, never that the generator is right. A reader looking under
the right subsystem simply found nothing and concluded there was no prior entry.

**Root cause, two of them.**

*One.* The document abbreviations sat in the case-INSENSITIVE patterns as
`\bso[- ]`, `\bpo[- ]` and `\bdo[- ]`. Under `/i` those match the English words
"so " and "do ". Counted across the ledger:

| form | SO | DO | PO |
|---|---|---|---|
| UPPER + space/hyphen | 151 | 65 | 147 |
| lower + hyphen (`so-revision.ts`) | 111 | 16 | 57 |
| **lower + space (prose)** | **556** | **42** | 0 |

Body hits cap at 5, so any entry whose prose said "so the…" five times scored a
FULL body hit for Sales orders. Of 185 entries, 54 had no area word in their
TITLE and were placed by their body; **20 of those were placed by "so" alone**,
with no real document reference in them at all.

*Two.* There was no area for the repo's OWN machinery. An entry about a ratchet,
a generator or a test runner carries no subsystem vocabulary, so it landed on
whatever English word matched: the coverage-ratchet entry in "Auth, permissions"
on *scope* and *token*, the codebase-map generator in "Fleet, trips" on *route*,
the node:test conversion in "Projects + PMS" on *project* — a vitest project.

**Fix.** A third, case-SENSITIVE column for the abbreviations (uppercase either
separator; lowercase only with a hyphen), a new **Repo tooling** area placed
FIRST so ties fall to it, and an explicit `<!-- area: ... -->` tag an entry can
carry when no keyword table can place it. An unknown tag FAILS the generator
rather than falling back to the guess — a typo that silently reverts to guessing
is worse than no tag. The index now prints how many of its own rows are guessed.

**Measured.** 43 → 18 in Sales orders; 15 entries into the new tooling area; 25
rows left an area they were in only because of an English word.

**What the first fix got wrong, twice, and both are in the guard now.**

`\bgate\b` was in the tooling pattern for one round and dragged four PRODUCT
entries in — the confirm gate, the stock-location gate, a permission gate, and
"A shipped DO's line cost was rebuilt from a ROUNDED unit price", which is about
money. Houzs calls product features gates. **A word is generic or not according
to THIS REPO's vocabulary, not English.**

And the guard's own red proof slipped through: it listed six literal strings
(`"\\bso[- ]"` and friends), a shell ate the `\b` while reverting the fix, the
generator got a bare `so[- ]` — every bit as ruinous — and the guard said
nothing and reported exit 0. It matches the SHAPE now, and the red proof was
redone by editing the file directly.

**Ref.** 2026-08-14. `backend/tests/bugIndexAreas.test.ts`, red-proven. Lesson:
**a generated doc can be perfectly consistent with its generator and still be
wrong about every row** — `--check` gates the copy, and nothing gated the
judgement until this test.
## The write-back opens a DUPLICATE master for a value the book already holds under another spelling [high]

**Symptom.** No error, and that is the point. The owner asked why so much has to
be opened at all — *"Branding、venue、sales、location、agent，你都可以做 binding
吧？…这样子之后就不用新开那么多，很多其实都已经有了"* — and he was right.
`/ensure-masters` opens a master AutoCount cannot find under exactly the string
it is given, so `SUNWAY SHOWROOM` does not fail against the book's own `SUNWAY`
(DUNLOPILLO SUITE SUNWAY): it opens a SECOND stock location, and one physical
showroom's stock lands in two rows of a licensed account book, permanently.
Nothing reports it, because from the sync's side every document succeeded.

**Root cause, traced against production** (read-only `autocount-field-alignment.yml`,
run 31815502403 on `main` for the warehouse count and run 31817727846 on the PR
branch for the per-dimension buckets, both 2026-08-14, company 1).

Two separate things, and only the first was known:

1. The four maps are **spelling corrections, not allow-lists** (2026-08-14, the
   entry below), so anything they had not been told about passes through and is
   opened. That was the right call — it is what makes a rep hired this month
   writable — but nobody had ever ASKED which of those pass-throughs the book
   already holds. **Eleven of the twelve `scm.warehouses` codes the
   field-alignment report calls unknown already exist**, as does the bulk of the
   venue and salesperson vocabulary.
2. The maps were hand-written object literals in `autocount-writeback.ts` while
   the record of WHY each binding is right lived in
   `scripts/data/autocount-so-writeback-mappings.json` beside them. **The two had
   drifted in all four dimensions** — the TS carried `ETHAN` and `WEI PIN`,
   confirmed out of the JSON's own `agent_map_fuzzy_to_confirm` and never written
   back, plus five identity location entries and `ZANOTTI`/`NONE`/`CARRESS`/
   `DUNLOP`. So the cheap way to confirm a binding was to edit TypeScript and
   leave the reason nowhere.

**Fix.** A matcher run as a REPORT, whose output a human confirms — never an
automatic binder, because a wrong bind writes the wrong place or the wrong
salesperson into a licensed book.

- `backend/scripts/lib/ac-master-matcher.mjs` — normalise, then score on
  IDF-weighted token overlap and edit distance. CONFIDENT means normalisation
  ALONE explains the difference (case, punctuation, word order, a `SOLO` suffix,
  `DISP`/`DISPLAY`, `SERV`/`SERVICE`, a dropped `WAREHOUSE`/`SHOWROOM`); LIKELY
  needs a shared word that names at most two masters in the whole book; a value
  sharing only common words is NO MATCH. Every proposal carries its reason.
- `backend/scripts/check-autocount-master-bindings.mjs`, run as a second step of
  the already-dispatchable `autocount-field-alignment.yml` — every distinct
  company-1 value per dimension, bucketed, with production row counts and a
  paste-ready fragment for the confirming edit.
- The four maps are now GENERATED from the JSON
  (`scripts/gen-autocount-master-maps.mjs` -> `src/services/autocount-master-maps.ts`,
  `npm run audit:ac-master-maps` in CI), so confirming a binding is an edit to
  the file that also carries the reason and never to TypeScript.

**What it does NOT do.** `BRANDING_MAP` stays an ALLOW-LIST — matching may
propose an addition, never a pass-through (the entry below has the measured
reason). `agent_excluded` stays a record of a decision, so a staff name that
reads as a test account and is not on it is NAMED (`Test Sales Director`, on a
live writable order) rather than added.

**Tests.** `backend/tests/acMasterMatcher.test.mjs` drives the matcher on the
real book vocabularies: all eleven codes confident with the right target,
`CHINA WAREHOUSE` no-match, `AEON BIG PUCHONG` never confident against the three
`AEON BIG` venues it is not, and every differently-spelled `agent_map` pair a
human already confirmed reproduced as a proposal.
`backend/tests/acMasterMaps.test.ts` pins every pair the maps carried at HEAD, so
generating them is provably behaviour-preserving and a binding can be added but
never silently removed or re-pointed. The matcher also asserts its own worked
examples before the report reads a row — a matcher whose rules rotted would
bucket everything as no-match, which reads exactly like a book that holds
nothing.

**Ref.** PR feat/autocount-master-bindings, 2026-08-14. Module guide §7p.

## Eight AutoCount fields the ERP holds and the write-back never sent — one null, three ways to lose a document [high]

**Symptom.** The owner, after the third instance of one bug in one week: *"你看
一下那些 sales agent venue 等等全部都对齐了"*. Nothing looked wrong. Sales orders
pushed to AutoCount successfully and arrived with no venue, no town, no postcode,
no state, no customer reference and no brand; some did not arrive at all and
answered `Foreign Key Error (Constraint Name=FK_SO_SalesAgent)` /
`FK_SO_SalesLocation`; and every edit of an order quietly blanked whatever the
account book held in eight header fields. Two of the three failure modes produce
**no error, no outbox row and no log line**, which is why the question had to be
asked rather than noticed.

**Root cause, traced field by field against production** (read-only workflow
`autocount-field-alignment.yml`, run 31808445421, 2026-08-14; 115 sales orders
and 60 purchase orders that can still be written).

One helper, `mapOrPassthrough`, returned **`null`** for any value its map had
never heard of — despite its name, which promised the opposite. `null` is the
worst possible value in all three places it landed:

| mode | mechanism | fields |
|---|---|---|
| FATAL-FK | `Str()` turns a present-null into `""`, the property is assigned unconditionally, `Save()` hits a foreign key and the WHOLE document is lost | `Agent`, `SalesLocation`, `CreditorCode` |
| SILENT-DROP | `udf()` drops a null key, so the field never reaches the book | `VENUE`, `BRANDING`, `ToPONo` |
| SILENT-BLANK | a present-null on `/edit` reaches `prop.SetValue(doc, "")` and overwrites | `Ref`, `Phone1`, `DebtorName`, `Attention`, `InvAddr1..4` |

**And the maps never protected anything.** Measured against the live book's own
vocabularies, *every target all four maps can emit is already a master there* —
so dropping what they had not been told about protected against nothing and only
deleted it.

Underneath that sat the same shape found in `FK_SO_SalesAgent` on 2026-08-13:
**the ERP keeps the value in one column and the composer read another.**
`ToPONo` read `po_doc_no`, which PR #140 stopped writing — the operator's text
lands in `customer_so_no`. `BRANDING` read a header column that is NULL on every
ERP-created order, while the value sits on the LINES (the detail page has been
showing it as `first_item_branding` all along). `InvAddr3` / `InvAddr4` read
`address3` / `address4`, which only the cutover import ever wrote, while an
ERP-created order keeps the town, postcode and state in `city` / `postcode` /
`customer_state` — three columns `SO_HEADER_COLS` did not select at all.

| field | affected | failure |
|---|---|---|
| `VENUE` | **112 / 115** | silently never written |
| `InvAddr3` / `InvAddr4` | 94 / 115 | town, postcode and state never reach the document |
| `SalesLocation` | 21 / 115 | `FK_SO_SalesLocation` — **all 21 BLANK, none unmapped** |
| `Ref` on an edit | 112 / 115 | blanks the book |
| `ToPONo` | 3 / 115 | reads a column nothing writes |
| `BRANDING` | header NULL on 115 / 115 | the value is on the lines |
| PO `Agent` | **60 / 60** | `scm.purchase_orders` has no agent column, so every PO sent `""` into `FK_PO_PurchaseAgent` |
| PO `CreditorCode` | 0 / 60 today | assigned DIRECTLY by `CreatePo`; a blank code is `FK_PO_Creditor` |

**The one finding whose prescribed fix would have fixed nothing** is
`SalesLocation`. The audit prescribed `mapOrPassthrough(x, LOCATION_MAP) ?? x`.
Re-measured at the moment of writing, that repairs **zero** orders: all 21
failures carry a BLANK `sales_location`, not an unmapped one, because
`deriveSalesLocationFromState` returns null for an order with no customer state.
Reading code would not have caught that; re-running the check did.

**Fix.**

- `mapOrPassthrough` **split**, not flipped, into `bookSpelling` (the book's own
  spelling or `null` = *never heard of it*) and `bookSpellingOrOwn` (else the
  ERP's value verbatim, for `/ensure-masters` to open). Flipping it would have
  broken `resolveAcAgent`, which must refuse an unmapped raw `agent` — that
  column holds bare uuids and "Unassigned" in production, and the service opens
  an agent under exactly the string it is given. Every caller was enumerated
  first.
- `soCustomerRef`, `soBranding`, `soInvoiceAddress`, `soSalesLocation` — one
  named function per field, each reading where the ERP actually keeps the value;
  five columns added to `SO_HEADER_COLS` and `branding` to `SO_ITEM_COLS`.
- **BRANDING is the one field that does NOT pass through, and production is what
  decided that.** The first version of this fix did pass it through; running the
  check against production printed the six values it would open as brands in the
  licensed book — `2990s Sofa` (44 orders), `Accessories` (8), `2990s Mattress`
  (8), `2990` (3), `Bedframe` (3), `Happi.S` (2). Four categories and a company
  name: `mfg_products.branding` is not a brand vocabulary, so `BRANDING_MAP`
  became an allow-list and the check prints that list every run. `CARRESS` and
  `DUNLOP` were ADDED to it instead — real brands in the book's own history that
  the map had simply never been told about, which is what a spelling map is for.
- The header `SalesLocation` falls back to the stock location the document's own
  LINES resolve to, which opens no master: `requireLocation` has already refused
  a line without one, so `mastersOf` is collecting that code off the line anyway.
  **This does not make the 21 writable** — the after-run says so plainly, and the
  report was extended to say why: 13 have no live line at all
  (`MissingSalesLocationError`) and 8 have lines with no `warehouse_id`
  (`MissingLocationError`, which already refused them). The gain is a named
  skipped row instead of a document lost to a foreign key, plus a pass-through
  that covers the unmapped case production does not exhibit today.
- Every PO names `AC_PURCHASE_AGENT` (`OTHERS`), and a supplier with no code is
  REFUSED (`MissingCreditorError`) rather than sent blank — the `MissingAgentError`
  precedent, applied twice more.
- `soEditHeader`'s own written rule — *"A NULL VALUE IS OMITTED, NEVER SENT"* —
  applied by construction: one `present()` helper at the single place a header
  is built, wrapping `soEditHeader`, all four `DOWNSTREAM[*].header` builders and
  the PO edit, with `AcDownstreamSpec.header` retyped `Record<string, string>` so
  a null cannot be put back without a compile error.
- `mastersOf` reads `body.Header` as well as the top level, in the SAME change —
  a pass-through that opens nothing on the edit path would have been the bug
  again one level down. Its sales/purchase discriminator now also reads
  `DocType`, because a PO edit carries no `CreditorCode` at all.
- `enqueueConvert` omits `Ref` / `DocDate` instead of sending null.
- `EnsureMasters`'s header comment claimed *"It never creates a LOCATION"* while
  the loop sixty lines below calls `SaveLocation`. The CODE was right — the
  owner asked for everything to be opened on 2026-08-11 and the module guide
  records it — so the COMMENT was corrected, and now carries what that costs:
  19 of 25 `scm.warehouses` codes are in neither the map nor the book.

**The master-opening consequence, in numbers, because it is a real one.** The
venue pass-through appends **3 options** to the book's 94-option VENUE dropdown
(`2990s PJ` ×110, `AEON BIG KEPONG` ×1, `AEON BIG PUCHONG` ×1) — reversible from
AutoCount's own UDF maintenance screen. It opens **0 new stock locations**: no
unpushed order carries an unmapped non-blank `sales_location`, and the header now
falls back to a code its own line already names. The 19-of-25 warehouse exposure
is on the LINE path, has been live since go-live, and this change does not widen
it.

**Why the check itself had to change too.** The report was still counting
AGENT_MAP hits after #2148 had taught the composer to pass an unmapped staff name
through, so it reported 96 unrescuable orders that the composer would in fact
have written — a checker measuring a design the code no longer had. Every
ERP-side section now calls the composer's own function and prints two numbers per
field: how many orders still send nothing, and which masters a pass-through would
OPEN, by name and count.

**Ref** — 2026-08-14, `fix/autocount-field-alignment`. No migration.
`docs/autocount-field-alignment-audit.md` carries the per-finding trace and what
is still open.



## Two fabric tools would have undone each other forever, and the loop had no fixed point [medium]

**Symptom** — `normalize-fabric-codes` merged six LAMB VELVET colours into the
HYPHEN form on production on 2026-08-14 (`VERIFY PASS`). The very next plan from
`merge-duplicate-fabric-series` proposed moving the same series back to the
SPACE form:

```
KEEP  "LAMB VELVET"  0 live lines, 7 colours
DROP  "LAMB-VELVET"  0 live lines, 6 colours
  LAMB2002: "LAMB-VELVET-2002" -> "LAMB VELVET-2002"   (0 live lines move)
```

Applying it would have undone the colour merge, and the next colour run would
have undone that. Two tools, one library, **no fixed point**.

**Root cause — and NOT a bug in either tool.** The series merger picks the side
production references more, which is the owner's ruling of 2026-08-11:
*合并，按引用数多的那边*. Both sides of this pair carry **zero** live lines, so
the rule ties, and the tie-break below it — *the series holding more colours* —
answered a question the owner's rule never addressed. Colour count is a
heuristic; it happened to point away from the one thing that IS defined, which
is what `lib/fabric-code.mjs` says the series is called. Asked directly, the
parser is unambiguous: **both spellings parse to series `LAMB-VELVET`**, and
`seriesToken("LAMB VELVET")` returns `"LAMB-VELVET"`.

**Fix** — one tie-break inserted, and the owner's rule untouched above it: most
live references first, **then the side already spelled the way the parser spells
it**, then colour count, then shorter id. This is the rule the COLOUR merger has
always carried — *"the row already carrying the canonical id wins outright"* —
which the series merger never got.

**A near miss.** The first version asked `parse(seriesId)`, which wants a full
code (series + number) and answers `null` for a bare series id — so the
tie-break would have been dead on every pair and the script would have kept
behaving exactly as before. Nothing would have looked wrong. Caught by running
it against the real ids rather than reading it.

**Pinned by** `backend/tests/seriesMergeCanonicalTiebreak.test.mjs`: the owner's
reference rule still wins when references differ, the canonical side wins on a
tie either way round, colour count still decides when neither side is canonical,
and — the property that matters — whatever the merger keeps on a tie is what the
canonicaliser would have written.

**Class** — *the same rule in two places, disagreeing quietly.* Same family as
the twelve catalogue series that only one of two derivers knew about, fixed the
same day.

**Ref** - `fix/series-merge-canonical-tiebreak`, 2026-08-14

## An empty sales order was "ready to ship", because a gate over zero lines is vacuously true [high]

**Symptom** — 16 live sales orders sat in `READY_TO_SHIP` with nothing shippable
in them: no lines at all, or every line cancelled, or service-only. Delivery
Planning offered them for scheduling.

**Root cause** — the auto-advance gate asked `isMainReady`, which is "every MAIN
line is READY". Over an SO with no main lines that is a fold over an empty set:
**vacuously true**. So the emptier the order, the more certainly it passed.

Delivery Planning had already worked out the correct predicate and written it
INLINE, TWICE (`routes/delivery-planning.ts`). The two writers that actually
advance the header had neither copy:

- `recomputeSoStockAllocation` — the sweep that produced the 16;
- `PATCH /:docNo/items/:itemId/stock-status` — the manual READY toggle.

Three places, two of them right, and the two that decide were the wrong ones.

**Fix** — one home for the rule: `summariseReadiness.isShipReady`
(`lib/so-readiness.ts:123`) — `mainCount > 0 ? isMainReady : isFullyReady`,
where `isFullyReady` already requires at least one live line. All four consumers
read it; the two inline copies in `delivery-planning.ts` collapse into it, so
the change is a net simplification there.

**Self-healing, no data repair** — the regress arm reads the same predicate
(`lib/so-stock-allocation.ts:765`), so the 16 husks fall back to `CONFIRMED` on
the next sweep on their own. Their audit line now says *the order has no
stock-bearing lines — not ship-able* instead of a stock-re-allocation note that
described nothing that happened.

**Class** — *a fold over an empty set answering "yes"*. Same shape as a `.every()`
guard on an empty array, and the reason the file-size and coverage gates in this
repo refuse an empty scan rather than reporting it clean. Worth grepping for:
a readiness/completeness predicate that never asks whether the population is
non-empty.

**Ref** - `fix/ship-gate-empty-so-0814`, PR #2186, 2026-08-14

## PR-4 (owner-gated flip): ship commitments bind via the live allocator; the stored PO→SO link stops deciding the batch [high]- **What was wrong with the old model.** `resolveShipCommitments` derived `expectedBatchNo` from the STORED raise-link (`resolveExpectedBatchBySoItem` over `purchase_order_items.so_item_id`, 'block' on multi-PO). Under the Decision (owner 2026-08-06, `docs/modules/purchase-order.md` §Decision — soft until DO, hard from DO) that is the retired pre-2026-08 model: the stored link is procurement provenance, and letting it pick the committed batch made a stale raise-link bind execution — a hand-typed line (67 of 101 live PO lines carried no link, prod 2026-07-31) could never bind at all, a multi-PO link refused instead of picking, and the pick ignored the pooled supply picture entirely.
- **The flip.** `expectedBatchNo` now comes from `allocateExpectedBatches` (`lib/do-live-allocator.ts`): pooled open-PO supply for the DO's codes and warehouse, walked in the owner's DEMAND order (delivery date nulls-last, then doc number — "SO1 比 SO2 优先"), supply ordered earliest effective ETA nulls-last then smaller PO number, SOFA sets picked WHOLE (one dye lot; a received `allocated_batch_no` on part of a set anchors the preference via `pickIncomingForSofaSet`'s `preferPoNumber`; no single covering PO -> no pick, the existing sofa guards take over — never a per-module split), every pick drawing down the pool before the next line looks. Ties auto-pick + the operator confirms in the existing short-stock dialog — no new refusal. `planSofaSetPoConflicts` stays armed as the backstop.
- **The fold (double-commitment made impossible).** The shadow deliberately omitted outstanding ship-before-arrival commitments; the flip subtracts them from the pool BEFORE picking (`subtractOutstanding` over `loadCommittedShipments` — moved VERBATIM from mrp.ts into `lib/committed-shipments.ts` so MRP and the DO path share ONE definition of "still committed": `ABS(qty) - SUM(consumed)` on a claimable OUT, the same test the SQL reconcile recomputes). A unit an earlier shipment already owns can no longer be committed to a second one; when the receipt nets the first, the subtraction falls away by itself.
- **What remains of the stored link on the ship path.** Provenance and evidence only: the BIND_SHADOW comparison keeps running post-flip (inverted — the allocator binds, the stored link is the shadow) into the same `scm.entity_audit_log` rows the soak checker reads; the DO detail's bound-PO Source-PO fallback and `resolveDoSofaBatchMap`'s legacy pre-0230 re-resolution are anchored-history/display reads and keep it. TWO KNOWN SEAMS flagged for review: the Type-A sofa no-batch guard's drop-ship waiver (`buildDropshipOffenders`/`allHavePo`) still consults the stored link, so its dialog can name a different PO than the allocator stamps; and `resolveDoSofaBatchMap`'s legacy source-3 fallback can still stamp a stored-link batch at deduction time on a post-flip drop-ship DO whose allocator bound nothing (kept — old drop-ship DOs need it, and the code cannot tell old from new).
- **Verification.** Pure walk + fold pinned in `do-live-allocator.test.ts` (stored-vs-allocator divergence resolves to the allocator, demand/supply tiebreaks, intra-write draw-down, sofa whole-set + anchor + no-cover, end-to-end fold with `outstandingCommitments`); `ship-commitment.test.ts` updated for the post-flip meaning of `expectedBatchNo`; backend typecheck + full vitest suite green. The mig-0230 SQL layer is untouched — `tests-pg/shipCommitment.pg.test.ts` still pins the claim/reconcile behaviour the stamped batch feeds.
- **Ref:** #<PR> (DRAFT — DO NOT MERGE until the bind-shadow soak is reviewed AND the owner signs off). `feat/bind-flip-live-allocator` 2026-08-07.

**Ref** - `feat/bind-flip-live-allocator`, PR #1681 (owner-gated), written 2026-08-07

## No draft Sales Order could be discarded — the guard queried a column that does not exist [high]

**Symptom.** Discard on a DRAFT SO returns **500** `delete_failed`, always, for
every draft. The documented `409 so_has_payments` was unreachable, so the failure
looked like a server fault rather than a refusal.

**Root cause.** `backend/src/scm/lib/so-lifecycle-guards.ts` checked for payments
with `.from('mfg_sales_order_payments').select('id').eq('doc_no', docNo)`. That
table has **no `doc_no` column** — it is `so_doc_no`, per
`backend/scripts/scm-schema/2990s-full-schema.sql:621` and the FK
`mfg_sales_order_payments_so_doc_no_mfg_sales_orders_doc_no_fk`. No migration
ever adds `doc_no`. PostgREST answers `42703`, `payErr` is set, and the guard —
**correctly failing closed**, because an unreadable ledger is not an empty one —
returns 500 before it can ever reach the 409.

It was the only site in the tree querying that table by `doc_no`;
`ar-reconciliation.ts:102` and `mfg-sales-orders.ts:494` both use `so_doc_no`.

**Why nothing caught it.** A column name inside a string is invisible to
TypeScript, and the guard's fail-closed branch turns the resulting error into a
plausible-looking 500 rather than a crash. The bug was found by a documentation
audit: `docs/modules/sales-order.md:266` documents a 409 the code cannot produce,
and checking WHY the doc was wrong is what exposed the query.

**Fix.** `so_doc_no`. One word.

**Ref.** 2026-08-14. Lesson: **a fail-closed guard hides its own defects.** When
a guard's error path is indistinguishable from a real refusal, a typo in it is
silent — so the error path deserves the same scrutiny as the rule. The class is
worth a checker: every `.from('t')...eq('c')` where `c` is not a column of `t`
is mechanically findable from the schema, and TypeScript will never see it.
## A shipped DO's line cost was rebuilt from a ROUNDED unit price [medium]

**Symptom.** None visible. The line costs on a delivered order did not sum to
what inventory had actually booked, and no screen shows that sum, so nothing
ever said so.

**Root cause.** `delivery-orders-mfg.ts` restamped every line from its bucket
as `round(bucket_cost / bucket_qty) * line_qty`. Rounding a unit cost to the sen
is correct — the owner's rule is that money carries two decimal places and
anything finer rounds to the nearest sen. Multiplying the ROUNDED figure back
out to rebuild a total is not:

    bucket: 50 sen booked over 100 units
    unit  : round(50 / 100) = round(0.5) = 1 sen     <- correct
    line  : 1 sen x 100 units = 100 sen              <- 50 sen invented

The quieter direction is worse: 0.4 sen a unit rounds to 0, and the entire cost
disappears. Both only bite when the per-unit figure is SUB-SEN, which is what a
small freight allocation or a partly-uncosted batch looks like. This is ledger
**B5** in a second home — B5 was fixed in `recost.ts` (which now carries totals)
and this path was never touched, so the two disagreed about the same goods.

**Fix.** `backend/src/scm/lib/bucket-cost-allocation.ts` — the bucket's booked
cost is split across its lines in proportion to qty, and the LAST line takes the
remainder so the shares sum to the bucket exactly. The unit cost is then derived
from the share. Total is the authority; unit is the derivation. That is also
ordinary ERP practice: a receipt's landed cost is a total, and the per-unit
figure is what you get when you divide it.

The remainder rule matches `landed-allocation.ts:133`, which already existed —
one house pattern for "make the column sum exactly", not two.

**Test.** `bucket-cost-allocation.test.ts`, 9 cases. The first assertion in every
one is that the shares sum to the bucket; a line being a sen off its proportional
share is arithmetic, the column not summing is money appearing or disappearing.
Both directions of the defect are pinned as their own cases.

**Ref.** 2026-08-14. Two things worth carrying forward:

1. **The file-size gate reported OK on a change it could not see.** It compares
   the committed diff against the merge base, so with the work still in the
   working tree it measured `origin/main` and passed. Committing first turned it
   red immediately, which is what it should always have said. A local gate run
   before `git commit` is a check running against the wrong tree — the same
   shape as the three-week `audit:map` crash in `staging-bench-rot-coe.md`.
2. **PROVEN vs UNKNOWN.** The defect is proven in the source and in the tests.
   Whether it has ever fired on production data is UNKNOWN — it needs a bucket
   whose cost-per-unit is under one sen, and nothing here has looked for one.
## The file-size gate reported OK on a tree it could not see [medium]

**Symptom.** `node scripts/check-file-size.mjs --require-base` printed the
ratchet summary and exited 0 while the working tree held changes that put a file
over its ceiling. Committing the same changes and re-running turned it red. The
gate had answered a question about a DIFFERENT tree and said nothing about it.

**Root cause.** The "which files did this change touch" half is computed from
git — `merge-base` plus a diff — so it sees only what is COMMITTED. The "how many
lines" half is read from the working tree. With uncommitted work those two halves
describe different trees: the line counts were current, the touched-file set was
not, so a file this change had grown was classified as INHERITED debt and
reported rather than charged. Exit 0.

This is the same shape as the three checkers CLAUDE.md already records — a
verdict computed over the wrong corpus reads exactly like a clean run. The
difference here is that nothing was broken: both halves worked, and the gate was
still wrong, because they were asked about different things.

**Fix.** The gate REFUSES rather than answers: `uncommittedSourcePaths` parses
`git status --porcelain -z`, and when the touched-file set is in play and any
source file is dirty, it prints what it cannot see and exits 2. Not a warning —
CLAUDE.md's rule is that a check which cannot execute must never report a pass,
and a warning on a green run is a pass. Parsing lives in
`scripts/lib/file-size-ratchet.mjs` so it is unit-tested without a repo: staged
files, renames (`R old -> new`), and paths with spaces each have a case.

**Ref.** 2026-08-14, PR #2179. Lesson: **a gate that reads two halves from two
different places has a third state — not pass, not fail, but "asked about
something else"** — and that state is invisible unless the gate is built to
notice it.

## Seventeen test files ran, passed, and counted as no test at all [medium]

**Symptom.** The coverage ratchet failed a docs-only PR with
`backend/scripts/lib: 17 files have NO test executing them, up from 15`. That PR
touched no file in that directory. Three other PRs were blocked behind the same
red, none of which had touched it either.

**Root cause.** The merged coverage report is built from `test:coverage:light` +
`test:coverage:workers`, both vitest. Seventeen test files ran under
`node --test` (`tests/*.node.mjs`, via `test:scale-contract` and its `pretest`),
and a `node --test` run contributes NOTHING to that report. Twelve modules in
`backend/scripts/lib` are covered only by those files — `ac-line-key-audit`,
`ac-po-line`, `ac-po-line-match`, `catalogue-series`, `classify-tests`,
`invoice-price-core`, `jsonb-bind-scan`, `po-cost-plan`, `release-discipline`,
`route-matrix-diff`, `so-line-dedication`, `swallowed-read-scan` — so the
no-test floor for that area was a number about the RUNNER, not about testing.

The gate was right and the tests were right. The measurement did not reach them.

**Fix.** The seventeen are ordinary vitest files now: `*.node.mjs` ->
`*.test.mjs`, `import test from 'node:test'` -> `import { test } from 'vitest'`,
bodies untouched — vitest runs `node:assert` unchanged, so nothing else moved.
`classify-tests.mjs`'s walk collects `*.test.mjs` alongside `*.test.ts`, which
keeps them out of TypeScript entirely. `test:scale-contract` and its `pretest`
are deleted.

**Measured.** The light suite goes 4102 -> 4361 tests. Those 259 were always
running; nothing that reads coverage could see them.

**Not re-baselined, deliberately.** Raising the floor to 17 accepts the debt and
turns a ratchet into a suggestion; exempting the area gives up on it. Both were
cheaper than the conversion and both would have left the number lying.

**What the rename then broke, and what caught it.** Nine documents and three
runners still named the old files: `check-docs-drift --strict` found the docs,
and `test:release-discipline` + two steps in `stamp-real-po-costs.yml` failed in
CI. A rename is exactly the change those gates exist for.

**What the rename broke a second time: the classifier classified itself wrong.**
`classifyTests.node.mjs` became `classifyTests.test.mjs`, so the widened walk
collected it — and sent it to the WORKERS pool. `classify-tests.mjs` decides by
regex over raw text, and that file is the classifier's own test: its fixtures
contain `cloudflare:test` and `env.DB` because that is what it tests. It also
needs a real filesystem (`fs.mkdtemp`), which workerd has none of, so the pool
did not fail the file — it died. `Worker cloudflare-pool emitted error`, and the
run read **`Test Files 15 passed (16)`**: all seven of its tests reported as
neither passed nor failed. Two assertions inside it were stale from the same
rename (`assert.match(p, /\.test\.ts$/)` against a tree that now holds `.mjs`)
and nobody saw them, because a file that never loads cannot go red.

Being exiled to workerd is a KNOWN, accepted cost for a pure-logic file — slower,
still correct, and pinned by its own test. For a file that touches `node:fs` it
is fatal. That distinction did not exist before this rename.

**Fix.** An explicit `// @vitest-project light|workers` overrides the text scan,
honoured only ABOVE the first import — a file's directive block, never its body,
so a declaration inside a fixture cannot declare on the real file's behalf. That
hole is not hypothetical: this classifier's own test is made of such fixtures.
Necessary rather than convenient — a content rule cannot judge a file whose
content is ABOUT the content rule. Overrides are returned and printed, and pinned
at exactly one file, so a second cannot arrive unnoticed.

**And the guard for it was in the wrong place first.** "Every suite on disk is
collected by some project" was written as a test in
`tests/scaleRealSchemaContract.test.mjs`, replacing the `pretest` assertion whose
arrangement this change deleted. Narrowing the walk back to `.test.ts` to prove
it red returned `No test files found` — the guard was itself one of the 18 files
that stop being collected. It would have vanished with the suites it protects and
CI would have gone green on 267 files instead of 285. It is
`backend/scripts/audit-test-projects.mjs` now, its own CI step, with a
deliberately duplicated walk so that narrowing the classifier's produces a
MISMATCH instead of two views that agree because they are the same code. It
replaces `audit:test-projects`, which had been pointing at a script deleted
weeks earlier (`gen-test-projects.mjs`, MODULE_NOT_FOUND) and was wired into no
workflow, so nothing noticed. Both failure branches proven red, exit 1.

**The conversion also imposed a 5-second budget on files that never had one.**
`node --test` has NO default timeout. vitest's is 5,000ms — a UNIT-test budget —
and moving the runner applied it silently to all seventeen.
`tests/noNulBytesInSource.test.mjs` reads EVERY tracked source file (~2,000
synchronous reads) looking for a raw NUL byte; measured on Windows it takes 3.47s
alone, 70% of the default before any contention, and in a full 288-file run it
returned `Test timed out in 5000ms` in two of six runs.

It presented as a flake in the worst possible place: a whole-tree gate that
intermittently reads as "the tree is dirty". The first hypothesis — a concurrent
write leaving a file momentarily zero-filled — was tested (10 consecutive
regenerations of the one candidate, checking `indexOf(0)` immediately after each)
and REFUTED; the failure text, once captured rather than summarised, said
`timed out` and never named an offending file. Two full runs were spent grepping
only the summary lines, which is why the wrong theory survived as long as it did.

Fixed with an explicit 60s timeout on that one test, with the reason in the file.
Raising vitest's global `testTimeout` was the wrong lever: it hands the same
slack to 288 files and hides a genuinely hung unit test. The other converted
suites were measured too — the next slowest walks the script tree at 1.65s and
the rest are under 1s, so none carries a declared timeout it does not need.

**Ref.** 2026-08-14. Lesson, and it generalises past this gate: **a measurement
can be wrong in the direction of looking rigorous.** "17 files have no test" read
as a real backlog for as long as nobody asked which runner the report came from.
Third lesson, from the timeout: **changing a runner changes the defaults the old
runner never had** — and the failure surfaced as a flake, in a gate about
something else entirely, five hours after the change that caused it.
Second lesson, from the guard that had to move: **a guard that dies with the
thing it guards is not a guard** — before trusting one, break the thing it
watches and check that the guard is still alive to complain.
## Two new comment kinds were written by raw SQL that bypassed the only typed entry point, and `main` stopped deploying [high]

**Symptom.** `main` red on `frontend` — a REQUIRED status check — and the Deploy
run reporting `frontend: failure` with `backend: skipped`, which CLAUDE.md says
to treat as a failed deploy. Nothing reached production from #2184 merging until
this fix. Two Deploy runs failed the same way (the second for an innocent PR that
merely inherited the tree). Eight errors, all one shape:

```
src/pages/Projects.tsx(8955,53): error TS2367: This comparison appears to be
unintentional because the types '"note" | "approve" | "reject" | "amend"'
and '"upload"' have no overlap.
```

**Root cause.** PR #2184 added two per-task history kinds, `upload` and `remove`,
and wrote them from `backend/src/routes/projects.ts` as raw SQL —
`INSERT INTO project_checklist_comments (item_id, kind, body, user_id) VALUES (?, 'upload', ?, ?)`.
That statement never passes through `addChecklistComment`, which is the ONE typed
entry point for that column, so the backend compiled while emitting two values no
type in the repo admitted. Neither union was widened:
`backend/src/services/projects.ts` (the helper's parameter) nor
`frontend/src/pages/Projects.tsx` (`interface ChecklistComment`).

The frontend half of the same PR then filtered those kinds OUT of the Remarks
column — correct, and at the owner's instruction — and `tsc -b` read those filters
as comparisons that can never be true.

**The shape worth remembering.** The type is declared in two files and written
from a third that consults neither. Nothing connected them, so the drift was
invisible until an UNRELATED expression happened to compare against a missing
value. Had the PR not also added that filter, the two kinds would be undeclared
today and no gate would have said a word — the build error was luck, not a check.

**Fix, in two parts by two people.** The FRONTEND union was widened directly on
`main` while this branch was in flight — that is what un-blocked the deploy, and
this entry does not claim it. What landed here is the half that was still
missing: the BACKEND union on `addChecklistComment`, which was still
`"note" | "submit" | "reject" | "amend" | "approve"` after the outage was over,
and `backend/tests/checklistCommentKinds.test.ts`, which extracts every kind
literal written into that table and asserts both declarations admit all of them
AND agree with each other. Proven red by reverting the frontend union — exit 1,
naming both `remove` and `upload`.

That split is worth recording rather than tidying away: the visible symptom was
fixed in one file, and the other declaration — plus the thing that stops it
recurring — was still open afterwards. Un-blocking the build and fixing the
defect were not the same job.

The guard is ANCHORED on the declaring construct (`interface ChecklistComment`,
`export async function addChecklistComment(`), not on the first `kind:` union in
the file. Its first draft was not, and read `kind: "income" | "cost"` 56 lines
earlier in the same file — it refused with "only 2 kinds parsed" rather than
reporting a pass, which is the property CLAUDE.md demands of a checker that
cannot match, but the anchor is what makes it correct.

**Ref.** 2026-08-14, PR #2184 introduced it. Deploy runs 31802261895 and the one
before it, both `frontend: failure` / `backend: skipped`. Lesson: **a typed helper
is not a boundary if another file can write the same column directly** — and
CLAUDE.md's own rule, "a BUG-HISTORY entry with no test attached is unfixed", is
why this one ships with a guard rather than a paragraph.

## main went red again on the same file, and the frontend stopped deploying a second time [high]

**Symptom** — hours after the last one, `main` fails `tsc -b`:

```
src/pages/Projects.tsx(4563,9): error TS2451: Cannot redeclare block-scoped variable 'q'.
src/pages/Projects.tsx(4765,9): error TS2451: Cannot redeclare block-scoped variable 'q'.
src/pages/Projects.tsx(4770,25): error TS2339: Property 'data' does not exist on type 'string'.
src/pages/Projects.tsx(4771,22): error TS2339: Property 'data' does not exist on type 'string'.
```

Every open PR inherited it — `frontend`, `frontend-build`, `frontend-checks`,
`frontend-typecheck` red on six of them at once — and the frontend deploy was
blocked for the second time in one day.

**Root cause** — the projects calendar declares two different `q` in one
function scope. `:4563` is the SEARCH STRING (`params.get("q")`, read at `:4785`,
`:4799`, `:4949`, `:4955`); `:4765` is the QUERY OBJECT from `useQuery`, read at
`:4770`, `:4771`, `:5079`, `:5080`, `:5082`. Two features, added separately,
each reaching for the shortest name in a 15,000-line file. The second
declaration wins for the type checker, so `q.data` resolves against a `string`.

**Fix** — landed as #2198, which renamed the SEARCH variable `q -> search` and
left the query object as `q`. I had prepared the opposite rename (query object
to `eventsQ`) and dropped it when theirs merged first: both are correct, and
re-naming it a second time would be churn in a file that is already the most
collided-on in the repo. This entry is the write-up that fix did not carry.

**A near miss worth recording.** I first read `:4765` through a 120-column
truncation, concluded the call was missing a comma before its fetcher, and wrote
a patch to insert one. The comma was there — the display had cut it. The patch
did not land only because the script asserted the line matched the shape it
believed before editing, and refused when it did not. Read the bytes
(`JSON.stringify` the line), not the pretty-printed excerpt, before repairing
something you have only seen truncated.

**Class** — *a semantic merge conflict*, the second in a day in this same file
after the `"upload" | "remove"` union. Both PRs were green alone; the failure is
the pair, which a per-PR gate cannot see. `Projects.tsx` is 15,003 lines and 128
over its size ceiling — the collision surface IS the file's length, and every
such fix has to be net-zero lines to get past the ratchet, which is its own
argument for splitting it.

**Ref** - `fix/calendar-query-shadows-search`, 2026-08-14

## A comment mentioning `env.DB` sent five pure-logic tests to the serial workerd pool [low]

**Symptom.** Not a failure — a cost, which is why it sat unnoticed. The backend
test suite is split in two: `test:light` runs on a plain node runner, and
`test:workers` runs in the Cloudflare pool with `fileParallelism: false` and
`maxWorkers: 1`, i.e. strictly serial. Five files that import nothing but vitest
and plain source modules were being paid for in the serial pool.

**Root cause.** `backend/scripts/lib/classify-tests.mjs` decided the pool with

```js
const NEEDS_WORKERS = /\bcloudflare:test\b|\benv\.DB\b|\benv\.DB_PARITY\b/;
… NEEDS_WORKERS.test(source)
```

applied to the file's RAW text. So prose counted. `tests/companyScopeFailClosed.test.ts`
says `// Fake env.DB.` in a comment — it BUILDS a fake — and that comment alone
routed it to workerd. Same for `adminResetLink`, `reviewHighFindings`,
`fairPnl.route` and `fairReport.route`, each matching inside a `/* */` block.

**Fix.** Blank comments before matching, with a string-aware scanner. Naive
stripping was not an option and the repo already knew it: `check-docs-drift.mjs`
deliberately does NOT strip, because `"http://x"` contains `//` and this codebase
writes mount paths like `"/products/*"` that contain the block-comment opener.
Tracking the four states (code / '…' / "…" / \`…\`) is what makes it safe, and two
tests pin exactly those two traps.

**Verified.** Workers pool 46 -> 41 files. All five relocated files pass in the
light pool (71 tests). Both suites whole afterwards: light 276 files / 4284
passed, workers 41 files / 335 passed — no test lost, none broken.

**The class, for next time.** A regex over source text cannot tell code from
prose, and a classifier is not a linter: being wrong costs time rather than
correctness, so nothing goes red and nobody looks. The behaviour had in fact been
PINNED as a known cost by `tests/classifyTests.node.mjs` a few hours earlier; that
test now pins the fix instead, which is what a pin is for.

**Ref** — 2026-08-14, PR `chore/classify-strip-comments`. No migration.

## The new linter could not start on Windows, and said "no ESLint installed" while ESLint was installed [medium]

**Symptom.** `npm --prefix backend run lint` on a Windows checkout: first
`[lint] No ESLint in backend/node_modules. Run npm ci in backend/ first.` after a
`npm ci` that had just succeeded, then — once the obvious fix was tried —
`spawnSync ...\.bin\eslint.cmd EINVAL`. Linux CI was green throughout, so the
linter this repo had just gained was unrunnable on the OS the repo is developed
on, and no finding could be checked locally before pushing.

**Root cause, traced through the spawn.** `scripts/lint-ratchet.mjs` resolved
`node_modules/.bin/eslint` and guarded it with `existsSync`. On Windows npm
writes THREE shims — `eslint`, `eslint.cmd`, `eslint.ps1`. The extensionless one
is the POSIX shell script; it exists, so `existsSync` was satisfied and the
error message blamed a missing install, but it is not executable on Windows and
`spawnSync` returned ENOENT. Reaching for `.cmd` instead moves the failure, not
fixes it: since CVE-2024-27980 Node refuses to spawn a `.cmd` without a shell,
which is EINVAL.

**Fix.** Skip the shims. Run ESLint's own entry — `node_modules/eslint/bin/eslint.js`
— under `process.execPath`. No shell, so nothing is quoted or interpreted, and
the same code path serves both platforms.

**Why it is the same class as the shebang trap** (see CLAUDE.md, "Anything a TEST
imports lives in `backend/scripts/lib/`"): a defect that only the developer's
machine sees, invisible to CI by construction, where the symptom names the wrong
cause. A gate nobody can run locally is a gate that gets pushed blind.

**Verified.** 734 frontend files and the whole backend tree now lint locally,
where neither could previously start; both then reported real ratchet findings,
which is the proof the run was genuine and not a silent no-op.

**Ref** — 2026-08-14, PR #2137 `eslint-layer`. No migration.


## Two derived docs were merge gates for a thing every PR is required to change [high]

**Symptom** — on 2026-08-14, five open pull requests failed `backend-typecheck`
simultaneously, all on the same line:

```
docs/generated/bug-index.md is out of date (175 entries in BUG-HISTORY.md).
```

None of them had touched the index. They were regenerated one at a time, and
were stale again after the very next merge. Separately, `audit:map` failed a
one-line fix for a **broken production deploy** while printing, in its own
message, *"This is an on-demand check. It is deliberately NOT a CI or deploy
gate."* — from inside `backend-typecheck`, where a non-zero exit is precisely a
gate.

**Root cause** — both files mirror something every pull request is *required* to
move:

- `bug-index.md` mirrors `BUG-HISTORY.md`, and the working agreement (#2135)
  makes every code PR append an entry to it;
- `codebase-map-facts.md` embeds LINE NUMBERS, which shift on essentially every
  backend merge.

`main-protection` sets `strict_required_status_checks_policy`, so merges are
strictly serial. The instant any PR merges, both files are stale on every other
open PR — through no act of their authors. Every author is charged for what the
previous author did, and the queue cannot converge.

**What the gate is actually for, and is kept** — `docs/staging-bench-rot-coe.md`
records `audit:map` crashing unnoticed for three weeks. That is a generator
DYING, not output drifting, and it is worth failing on. The two are now
separated: a generator that parses zero entries or scans zero route modules
exits **2**; drift prints both counts and the fix and returns **0**. `--strict`
restores the hard failure for a local run or a job that wants it.

**Pinned by** `backend/tests/derivedDocsDoNotDeadlock.node.mjs` (in
`test:scale-contract`): it fails 3 of 3 on the previous scripts, and asserts
that the only `process.exit(1)` left in either check path is guarded by
`--strict`.

**Class** — *a gate whose blast radius is wider than its subject.* Fourth
instance in two days, after the fabric census counting deliberate tombstones and
the file-size ratchet twice. The tell is the same every time: the failure
message asks the author for something only somebody else can do.

**Ref** - `fix/derived-docs-deadlock`, 2026-08-14

## The frontend deploy has been failing since 12:02 — a union that was never told about two kinds the server emits [high]

**Symptom** — every `deploy.yml` run since 12:02 on 2026-08-14 fails in the
`frontend` job, exit code 2, eight `TS2367` errors in
`frontend/src/pages/Projects.tsx`:

```
error TS2367: This comparison appears to be unintentional because the types
'"note" | "approve" | "reject" | "amend"' and '"upload"' have no overlap.
```

`backend` deployed; `frontend` did not. **The two halves of production have been
on different versions for the better part of an hour**, and nothing said so
except a red run nobody was watching.

**Root cause** — `ChecklistComment.kind` at `Projects.tsx:437` reads
`"note" | "submit" | "reject" | "amend" | "approve"`. #2184 taught the task
history to show file uploads and removals: it added the WRITER
(`backend/src/routes/projects.ts:4235` inserts `kind = 'upload'`, `:4318`
inserts `'remove'` into `project_checklist_comments`) and the READER (four
`c.kind === "upload"` comparisons), and never the union between them.

**Why CI did not catch it** — it did, eventually; it could not catch it *first*.
Both #2183 and #2184 were green against the main they merged onto. The failure
is the pair, not either one: a semantic merge conflict, which a per-PR gate
cannot see by construction because the tree it fails on did not exist when
either PR ran.

**Fix** — `"upload" | "remove"` added to the union, with the reason and both
writer line numbers in a comment beside it. Verified with the deploy's own two
commands, not a proxy: `npm run typecheck` (which is `tsc -b`; `npx tsc
--noEmit` here resolves zero inputs and exits 0) and `npx vite build`. 140 test
files / 1,361 tests pass.

**Class** — *a contract enforced in two places and declared in a third*. Same
family as the SO Processing Date literals: the type is the contract between a
writer and a reader, and it was the only one of the three not updated.

**Worth doing next, not done here:** nothing watches for main being red. The
deploy failed six times before anyone looked. `notify-failed-release` ran and
succeeded on both failures — so the notification path fired and still nobody
saw it, which is its own finding.

**Two gates then charged this fix for the file it had to touch**, and both were
right to, so the fix was made to cost nothing rather than to argue: the union
change is a one-for-one line swap with its pointer as a trailing comment, so
`Projects.tsx` is the same 15,003 lines it was on main and the size ratchet has
nothing to charge. The lint ratchet flagged one NEW floating promise at `:558`
— `addNew()` in an onChange, landed by someone else past a non-required check —
fixed as `void addNew()`, the idiom already used at `:2116` and `:7691`, rather
than re-baselined.

**Ref** - `fix/task-history-kinds`, 2026-08-14

## A delivery order that lost its link to the sales order made MRP order the goods a second time [high]

**Symptom.** The owner, on the MRP Stock Status Report, 2026-08-14: "all these
SO already have PO & some done delivered, why still appear at MRP for ordering?"
Four sales orders he named were fully shipped — one of them on a delivery order
already marked DELIVERED — and MRP was still asking purchasing to buy the goods.

**Root cause.** Of the three places `delivery-orders-mfg.ts` inserts DO lines,
the two that build a row from a client-supplied item body go through
`buildItemRow`, which does `so_item_id: (it.soItemId) ?? null` — taken from the
request, with no derivation and no guard. The third, `POST /from-sos`, sets it
from the picks server-side and always has it; that is the shape the other two
should have had. A client that omits the field writes a delivery the system can
never attribute, silently and permanently.

Everything that asks "how much of this order is still to fulfil" resolves on
that column — the remaining-qty guard, the sofa batch guard, the SO header's
status flip, and MRP's delivered-netting, which does `.in('so_item_id', ...)`
and skips a null. So a shipped order reads as entirely undelivered. MRP is
correct about everything it can see; it simply could not see the shipments.

`2990-SO-2606-025` is the clearest tell: its delivery order is DELIVERED while
the header still says CONFIRMED, because the header only flips when every line
is covered and no line could be.

**Measured on prod.** 24 unlinked lines on live delivery orders, across 11 open
sales orders, every one of them over-reporting shortage. None in June; 13
between 2026-07-02 and 07-30; 11 more between 08-03 and 08-06; none since.

**Why the earlier fix did not end it.** PR #1395 (2026-07-29) fixed the DO-create
page to send `soItemId` — and lines created on 08-03 and 08-06 are still
unlinked, from a client path that path did not cover. The reason one client
regression could write a month of permanently bad data is that the server
accepts the omission. `backfill-do-line-snapshot.mjs` had even met these rows
already ("WHERE so_item_id IS NULL there is no parent... leaves the line alone")
and correctly skipped them; nobody asked why the orphans existed.

**Fix, part one — the data.** `backfill-do-so-item-link.mjs` re-links what can
be read: only within the sales order the DO already names, only between lines of
the same item code, and where a code repeats, only on a variant identity unique
on both sides. `2990-SO-2606-016` carries two `CODY-(K)` lines differing only by
colour (BF-10 / BF-12) and both documents carry that colour, so that pair is
read rather than guessed. Two genuinely indistinguishable lines are REFUSED —
a bijection exists but choosing one is a coin flip, and the two SO lines can
differ in what is linked to them. A wrong link is worse than none: it credits
one line's shipment against another and cannot be told from a fact afterwards.

**Fix, part two — the hole.** Still to do: `buildItemRow` should derive the link
from `(so_doc_no, item_code)` when a client omits it and refuse only when that
is ambiguous — the same thing `/from-sos` already does — so no future client
regression can write this again.

## The coverage gate never ran on Windows and reported success without reading a report [high]

**Symptom.** `node scripts/coverage-ratchet.mjs --check --report <file>` on a
Windows checkout: no output at all, exit 0. Not "every area held its floor" — no
table, no area list, nothing. The same command on Linux CI prints a six-area
table and fails correctly.

**Root cause, traced to one line.** The entry-point guard was

```js
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
```

On Windows `process.argv[1]` is `C:\…\coverage-ratchet.mjs`, so the template
builds `file://C:\…` — two slashes, backslash separators. `import.meta.url` is
`file:///C:/…` — three slashes, forward slashes. They can never be equal, so
`main()` was never called and the module fell off the end having done nothing.
On POSIX the path already starts with `/`, so the concatenation happens to
produce the three-slash form and the comparison matches **by luck**.

**Why it is worse than a papercut.** This is the gate that holds line coverage
and the no-test-file floor. Locally it answered every question with a silent
success — `npm run coverage:check` was indistinguishable from a pass — so a
developer on Windows could not check a floor before pushing, and would be told
everything was fine. The repo's own rule names this exact shape: *"A verdict
computed over nothing must never read as a pass."*

**Fix.** `import.meta.url === pathToFileURL(process.argv[1]).href`. Same
comparison, done by the API that knows about drive letters and separators.
Verified by running the gate on Windows afterwards: it now reads the report
(733 files), prints all six areas, and fails on the areas that are genuinely
below their floor.

**The class, for next time.** Second instance in one day of *a gate that is
silently a no-op on the OS this repo is developed on, while Linux CI stays
green* — the first was `lint-ratchet.mjs` spawning `.bin/eslint`
(BUG-HISTORY 2026-08-14). Both were invisible to CI by construction. When a
check is added, run it on Windows once and confirm it PRINTS something.

**Ref** — 2026-08-14, PR `fix/coverage-lib-tests`. No migration.
## A saved default layout made its own hidden columns un-tickable, and a sticky funnel had nothing to clear it [medium]

**Symptom.** A Purchaser reported 5 of 60 purchase orders missing. The owner
signed in as the same account on his own machine and saw all 60. Chasing that,
the GRN No checkbox in the Columns drawer would not tick at all.

**Root cause — two, in the same component.** The short list was a column funnel
the user had ticked once. Funnels persist to `dt:filters:<table>`, apply from the
first paint, and are visible nowhere but the header carrying them — per browser,
which is why the owner's login could not reproduce it. The toolbar Reset could
not help: the 15 pages that pass `resetFilters` (`git grep -l "resetFilters={"
-- frontend/src`, less this component's own test) define "active" as their own
pills, view and search, and their `onReset` clears URL params and sort, never the
stored funnels.

The dead checkbox was worse. A table with no prefs of its own renders the
company's default layout, and while that baseline is in play `effectiveHidden`
reads the PRESET's hidden/shown lists and skips the user's — but `toggleColumn`
wrote the skipped ones. Revealing writes to the hidden list (already empty, a
no-op) and to the shown list only for a `defaultHidden` column. GRN No carries no
such flag, so the click wrote nothing whatsoever. That is every hidden column on
a list whose defaults live entirely in a saved layout — Delivered and Assigned SO
too — and Show all was dead there for the same reason.

The same gap had a quieter third face: hiding one column under a default stored
only that column. The first stored pref of any kind ends the baseline for good,
so the next mount read "hid this one, arranged nothing else", unhid every other
preset-hidden column and re-sorted the table into definition order. Nobody
reported it; the layout-sync test had pinned it as correct.

**Fix.** `DataTable` folds its own `colFilters` into the Reset button's `active`
and clears them on click, and renders the button unconditionally so the 24 lists
that render a `DataTable` without passing `resetFilters` get one too. Visibility
gestures move to `dataTableColumnPrefs.ts` and bank the baseline into real prefs
— order included — before applying themselves, which is what picking a layout
from the drawer already did, so a toggle and a Show all no longer have a "preset
mode" to escape from.

**What this does not change.** A funnel still persists, and still applies from
the first paint. That is the design — it is the only way a narrowed view survives
a reload. What changed is that the toolbar now admits one is on.

## The coverage ratchet cannot see the repo's `node:test` suites, so it reports well-tested modules as untested [medium]

**Symptom** — `coverage-ratchet` failed on this PR for three rounds with a
regression nobody caused:

```
FAIL backend/scripts/lib:
  - line coverage fell to 53.84% from a floor of 63.29% (1430/2656 lines).
  - 15 files have NO test executing them, up from 12.
```

**Root cause (traced, not guessed)** — the merged coverage report is produced by
**vitest only**: `backend`'s `test:coverage:light` + `test:coverage:workers`, and
`frontend`'s `test:coverage`. Vitest does not execute `node:test` files. This
repo keeps a whole second suite in that runner — `backend/tests/*.node.mjs`, run
in CI by `npm run test:scale-contract` and `npm run test:release-discipline` —
and a third in `vitest.pg.config.ts`, which declares no `coverage` block at all,
so `npm run test:pg` never emits a report.

On 2026-08-13 three new modules landed in `backend/scripts/lib`, each *with* a
thorough `node:test` suite that runs on every PR:

| module | lines | its test | measured by `node --test --experimental-test-coverage` |
| --- | ---: | --- | ---: |
| `release-discipline.mjs` | 231 | `tests/releaseDiscipline.test.mjs`, 43 cases | 98.60% lines |
| `jsonb-bind-scan.mjs` | 125 | `tests/jsonbBindScan.test.mjs` | 95.53% lines |
| `swallowed-read-scan.mjs` | 51 | `tests/swallowedReadScan.test.mjs` | 100.00% lines |

407 lines, all of them exercised in CI, all of them reported by the gate as zero
lines covered and three files with no test at all. The percentage did not fall
because coverage fell; it fell because the denominator grew by 407 lines the
instrument is blind to. Eleven of the fifteen files the gate names in this area
are the same artefact — the full list, with the runner that covers each, is in
`docs/TESTING-RATCHET.md` §6. Four genuinely have no test anywhere:
`sqlite-default-to-pg.mjs`, `scm-area-keys.mjs`, `bedframe-special-map.mjs`,
`classify-tests.mjs`.

**Fix** — the floors for `backend/scripts/lib` were re-baselined deliberately,
`--update --allow-drop`, to 53.74% / 15: that is what the instrument measures,
and pretending otherwise leaves a permanently red check that the next person
routes around. **The blind spot itself is NOT closed here.** Closing it is a
design choice with three real options, written out in `docs/TESTING-RATCHET.md`
§6 along with the one-line command that proves a module is covered
(`cd backend && node --experimental-test-coverage --test tests/*.node.mjs`) —
the smallest is a `testedElsewhere` list in `coverage-baseline.json` beside the
existing `knownAbsent`, each entry naming the harness, so "files with NO test"
means that again.

**Class** — same family as #2161 directly below: a gate whose *measurement* is
narrower than the property it claims to enforce. The two failure directions are
opposite and both cost. #2161's proxies were too narrow and let violations
through silently; this one's is too narrow and fails work that is correct, which
is the mode that gets a gate deleted. A ratchet that goes red on a PR whose
author did nothing wrong burns its own authority, and this one is not yet a
required check partly because of it. Expect a recurrence on the next
`scripts/lib` module that lands with a `node:test` suite.

**Ref** — #2143. Gate under test: itself.

=======
## Defect-review region routing was a UI hint, not a rule — either reviewer could stamp any state [low]

**Symptom.** Owner, on a Sarawak project: "sabah sarawak defect under shukor ya
not nancy".

**Root cause.** The two-warehouse split (2026-08-11) was enforced in exactly two
places, and neither is a gate: `listProjects`' My Pending lane (Nancy sees the
four region states, Shukor everything else) and the frontend's `canReview`,
which hides the Done / Replace buttons. `POST
/checklist/attachments/:attId/actions` accepted a stamp from **either** reviewer
on **any** project — it only asked "are you a reviewer?". A stale tab, a
deep-linked page or any direct call could close a Sarawak defect as Nancy, and
the timeline would record it as legitimate.

**Fix.** The route now loads the attachment's project state and holds each
reviewer to their own half of the split: the Ops Exec on `Pulau Pinang /
Kelantan / Terengganu / Perak`, the Storekeeper Supervisor on everything else,
including a NULL state. Sabah and Sarawak were never in the region list, so this
puts them where the owner expects — Shukor — by rule instead of by hope. Admins
(`*` / `projects.manage`) and the purchaser/BD closing an escalation are
untouched.

**The class, for next time.** A split that lives in a list query and a button's
`disabled` prop is a suggestion. If the rule matters, the write path has to say
no.

**Ref** — 2026-08-14, `fix/defect-review-region-gate`.

## The printed Event Summary read the crew off columns nothing writes, and printed the setup call 8 hours late [med]

**Symptom.** Owner, looking at the live sheet for `2026-07-MYHOME-KL-SPCC-AKEMI`:
the Logistics block showed `—` for lorry, driver and both helpers, and a setup
call entered as **11:00** printed as **19:00**.

**Root cause, two independent faults.**

1. *Crew.* The sheet read `projects.setup_driver_user_id` / `setup_lorry_id` /
   `setup_helper_*_id`. Measured on production: 903 projects, 224 with a setup
   driver, 211 with a lorry, and **0 with `setup_helper_1_id`** — because the
   logistics form does not write those columns. It writes a JSON blob into
   `projects.setup_crew` / `dismantle_crew`, and that blob has been through three
   shapes: crew nested per lorry under `lorry_crew`, an older flat
   `drivers`/`helpers`/`lorries`, and `outsourced` as either `{enabled,
   entries[]}` or a single `{name, phone, plate}`.
2. *Times.* `setup_start_at` comes from an `<input type="datetime-local">` and is
   stored naive (`2026-07-30T11:00`) — already MYT wall clock. `fmtDateTime` was
   adding the +8h that true instants (`created_at`, which carry `Z`) need, so
   every crew time printed 8 hours late.

**Fix.** `parseCrew()` normalises all three blob shapes, prints the
Grab/Lalamove outsource rows and both remark fields, and treats
`outsourced.enabled === false` as "the user removed this". The old columns stay
as a fallback for the ~220 projects that only have them. `fmtDateTime` shifts
only values carrying a zone marker; naive local strings print exactly as typed.

**The class, for next time.** A column that exists is not a column that is
written. Before reading one on a report, count how many rows are non-null — the
helper columns were dead on arrival and the sheet said `—` for months without
anyone being able to tell the difference between "no crew" and "wrong source".

**Ref** — 2026-08-14, `fix/print-crew-json` and `fix/print-crew-times-stage`.

## Migrated purchase lines were priced by inference, and 318 item codes have a price that varies by PO [high]

**Symptom.** 10,372 migrated purchase-order lines carried no unit price. The
standing repair for that was to infer one — a MAX or a single cost per item
code — which reads as reasonable and is wrong wherever the same product was
bought twice at different prices.

**Root cause, traced down the AutoCount document chain.** The cost was never
missing; it was on a document the cutover never read. `PO --(GRDTL.FromDocNo)-->
GR --(PIDTL.FromDocType='GR')--> PI`, and the purchase invoice is what was
actually paid. `NB-NH39(A)(K)` alone was bought at RM1,760.00, RM1,680.00,
RM1,500.00 and RM1,180.00 on four named invoices; 318 of 754 item codes vary the
same way, so one cost per code cannot be right about more than one of them —
MAX-by-item-code overstates PO-003645 by RM580 per unit.

**Fix.** Read the invoice. `stamp-real-po-costs.mjs` prices a blank line from its
OWN receipt's invoice and writes nothing anywhere else. The join is the
three-part key (source document, ItemCode, Desc2) because AutoCount publishes no
line-to-line key on this chain — `PIDTL.FromDocDtlKey` and `GRDTL.FromDocDtlKey`
are both 0-populated. An AutoCount GR is a MULTI-PO receipt, so GR lines are
narrowed by `FromDocNo = our PO` before a price is read; without that narrowing
the script imports another PO's price, silently.

**What it refuses to do, which is the finding.** It does not write
`inventory_lots.unit_cost_sen`. Measured on the committed extract: of 315
zero-cost cutover layers, 289 have an own-receipt invoice that ALSO says 0.00, 23
have no receipt at all, and 3 resolve to a real price. Reading the invoice
cannot cost those layers, and the only way to put a number on them is to borrow
one from a different document — the inference this lane exists to replace. A
blank is visible; a plausible wrong number is silent forever.

**Control.** On the 7,529 lines that already carried a price the invoice agrees
with 7,396 (98.2%); the 133 that differ are order-to-invoice price changes, where
the invoice is the truth for costing.

**Also fixed here (2026-08-14).** The script wrote on `APPLY=1` alone with no
CONFIRM phrase, no re-read on a fresh connection, and no stated re-run behaviour
— `audit:release-discipline`, inside the required `backend-typecheck` check,
failed on all three. `stamp-real-po-costs.yml` had been passing `CONFIRM` through
since it was written and nothing read it. It now refuses without the phrase and
verifies every priced line on a SECOND connection, asserting the VALUE and its
type rather than a row count.

**Ref** — 2026-08-14, PR #1969 `fix/real-po-costs-from-invoice`. No migration.
## The sofa engine billed a part-ringgit price rounded to the nearest ringgit [high]

**Symptom.** Nobody reported it, because the amount is cents and the invoice
looks right. A sofa whose combo is priced RM3152.63 bills **RM3153.00**; one
priced RM5712.11 bills **RM5712.00**. Over-charging on one row, under-charging
on the next, and margin computed against the rounded revenue while cost stays
exact.

**How big, measured not guessed.** Actions -> **Sofa price rounding check
(read-only)**, run 2026-08-14 against production: module SKU flat prices **0**
part-ringgit, seat-height selling overrides **0**, and combo charged prices
**23 of 163**. So the question the ledger held open as B4 — *should a sofa module
ever be priced in cents?* — was already answered by the data: the business
prices in cents, and the engine was rounding it away.

**Root cause.** `SofaProductPricing` carried whole MYR. Inputs arrive in sen,
`sofaCompartmentsFromModulePrices` did `Math.round(sen / 100)` on the way in,
the combo total did `Math.round(comboPriceCenti / 100)`, and
`computeSofaSellingSen` did `Math.round(total * 100)` on the way out. That round
trip is pure loss — up to 50 sen per module and per combo.

**Fix.** The engine carries SEN end to end. Its arithmetic is addition,
subtraction and one integer multiply, so integer sen is strictly better than
fractional MYR: no rounding, and no float either. The public boundary is
unchanged — `computeSofaSellingSen` already took sen and returned sen, so its
one live caller (`mfg-pricing-recompute.ts:613`) needed no change.

**The field was RENAMED, not just re-interpreted.** `price` -> `priceSen`,
`reclinerUpgradePrice` -> `reclinerUpgradeSen`. Changing a unit silently is how a
missed call site becomes 100x wrong with nothing to catch it; renaming makes the
compiler enumerate every site. It found them all — backend and frontend
typecheck both clean on the first run after the change.

**Test.** `backend/src/scm/shared/sofa-price-sen.test.ts` — the engine had NO
arithmetic test before this (`sofa-combo-pricing.test.ts` covers combo
normalisation only). Written as CHARACTERISATION first: three whole-ringgit
cases that must not move, because 140 of the 163 production combos are whole
ringgit and a change there would be a live pricing change; then the three
part-ringgit cases, which reproduced the production deltas exactly (+37 sen on
RM3152.63, -11 sen on RM5712.11) before the fix and are exact after it.

**Ref.** 2026-08-14, ledger B4. **Not covered by this fix:** documents already
priced from those 23 rows carry the rounded figure. Sizing that is a separate
pass and it is recorded in the ledger, not assumed to be nil.

## The migration tool could only ever reach production [medium]

**Symptom.** None visible, and that is the point. `pg-migrate.mjs` appeared to
work, because the only database anyone ever pointed it at was the one it could
reach.

**Root cause.** `pg-migrate.mjs:48` opened its connection with `ssl: "require"`
hardcoded. Correct for production — Supabase through Hyperdrive — and fatal
against any local PostgreSQL, which serves no TLS: the script dies in **0.059s**
with `Client network socket disconnected before secure TLS connection was
established`, inside `loadAppliedMigrationRows`, before reading a single
migration file.

**Why it matters more than a developer-convenience bug.** It means a migration
could not be applied anywhere except production, so the first real database any
migration ever met was the production one, during a deploy. That is exactly how
mig 0290 stopped the backend release on 2026-08-14
(`docs/migration-gate-coe.md`).

**Fix.** `backend/scripts/lib/pg-ssl-mode.mjs` — TLS required for everything
except the two loopback names spelled exactly, failing CLOSED on an unparseable
URL, an empty string, `undefined`, or a number. Keyed on the hostname rather than
an env var on purpose: a hostname comes from the target itself, so it cannot be
switched on by ambient configuration, whereas a stray `PGSSL=disable` in the
wrong environment file would silently downgrade a production connection. Against
the real DSN the value is `'require'` — byte-identical to the old behaviour.

**Test.** `backend/tests/pgSslMode.test.mjs`, wired into `test:scale-contract`.
The cases that carry the weight are the near-misses, all of which must still
require TLS: `localhost.evil.com`, `notlocalhost`, `127.0.0.1.evil.com`,
`127.0.0.2`, and a production host carrying `?host=localhost`. A hostname is
compared whole, never by prefix or suffix.

**Ref.** 2026-08-14. Found by building a CI gate that turned out not to work; the
gate is ruled out in the COE, this fix outlived it.

## A view migration written against the wrong baseline stopped the production deploy [high]

**Symptom.** PR #2140 merged green and the backend never shipped. The Deploy run
concluded `failure` with `pg-migrate` red and the wrangler step **skipped**, so
production kept serving the previous Worker while `main` looked healthy. Every
migration after this one was queued behind it.

```
FAILED 0290_scm_gl_keep_reversed_originals.sql:
cannot change name of view column "line_id" to "journal_entry_id"
```

**Root cause — the migration was written against an OLD definition of the view.**
`scm.v_gl_entries` is defined by mig 0106 and opens `l.id AS line_id`. The new
migration opened `j.id AS journal_entry_id` and inserted its two new columns
BEFORE `company_id`. `CREATE OR REPLACE VIEW` allows neither: existing column
names, types and ORDER must match exactly, and new columns may only be APPENDED.
The file's own header asserted "ordering, company_id and every existing column
are untouched" — a claim about a database, made without one.

**Why nothing caught it.** The pg suite applies the specific migrations a test
names, and no test named this one — two of the five migrations in that PR had pg
tests, the view did not. `tests/setup.ts` replays a different tree entirely
(`src/db/migrations/`, the D1 mirror), and SQLite does not enforce this rule.
**Nothing anywhere replays `migrations-pg/` in order against a real Postgres**,
so a rule only PostgreSQL enforces had no gate in front of it.

**Fix.** Match mig 0106's column list exactly for the first 18 columns and append
`reversed` / `reversed_by_je` after `company_id`; the WHERE change that the
migration is actually for is unaffected. Verified mechanically: the first 18
columns now diff clean against 0106.

**The repair NOT taken, deliberately.** `DROP VIEW` + `CREATE VIEW` also fixes
the error and is the obvious move. It is wrong: a recreated view is a NEW object
with an EMPTY ACL — this is how mig 0189 took the production Sales Order list
down for every user and needed both 0190 and 0191 to restore the grants. Keeping
it a REPLACE never drops a privilege.

**Test attached** — `backend/tests-pg/glViewKeepsReversed.pg.test.ts`. It builds
mig 0106's view as its FIXTURE and applies the migration on top, which is the
only arrangement that can catch this class; a test that built the view from the
migration's own SQL would have passed while production failed. It also asserts
the fixture still reproduces the original bug, so the suite cannot pass
vacuously.

**Ref.** 2026-08-14, after PR #2140. Lesson, and it is the one this file keeps
re-learning: **a migration that edits an existing object must be written against
what is LIVE, not against the migration that first created it** — and a claim
about what a database will accept is not evidence until a database has accepted
it.

## Three gates gave a different verdict on Windows than on Linux, and one of them hid a real defect [medium]

**Symptom.** `npm --prefix backend run audit:jsonb-binds`, `audit:swallowed-reads`
and `audit:test-schema` all failed on a Windows checkout of a tree whose Linux CI
was green. The test-schema one was the most misleading: it said "regenerate", and
regenerating produced a byte-identical file that `git diff` reported as unchanged.

**Root cause — the platform's own separators, in three places.** Each gate
compares something it builds at runtime against something committed, and each
comparison was written on Linux where the two forms coincide.

- `check-jsonb-binds.mjs:80` keyed its ALLOWLIST on `relative(REPO, file)`, which
  returns `backend\scripts\...` on Windows against a list written
  `backend/scripts/...`. No key ever matched, so the one deliberately allowed
  site was reported as a finding.
- `check-swallowed-reads.mjs:55` had the same bug against
  `swallowed-read-baseline.json`, whose 126 keys are posix because CI writes
  them. Every per-file ceiling lookup missed, so the ratchet reported the whole
  tree as 153 NEW sites.
- `gen-test-schema-snapshot.mjs:324` compared file text with `!==`. Git hands a
  Windows checkout CRLF; the generator always builds LF.

**Why the middle one mattered.** A ratchet that reports everything as new is not
merely noisy — it is unreadable, and an unreadable gate gets waved through. Under
those 153 phantom findings sat a REAL one: this branch had added 21 reads shaped
`const { data: own } = await <query>` with no `error` bound, in the very company-scope
guards it was adding. supabase-js does not throw, so on a database failure `own` is
undefined and the guard answers `404 not_found` — reporting an outage as "this
document does not exist". Fixing the path bug is what made that visible.

**Fix.** Normalise before comparing: `.split(sep).join('/')` on both scanners,
and an `eol()` that strips `
` before the snapshot comparison. Then bind
`error` at all 21 sites and return `500 lookup_failed` so a failed read can never
be read as an absent row.

**Ref.** PR #2140, 2026-08-14. Same family as the `#!` shebang trap and the CRLF
test anchors already in this file: **a gate that only runs green on CI's platform
is a gate the person doing the work cannot use.**

## A restricted salesperson could re-price, re-pay and cancel ANY consignment order [high]

**Symptom.** None until someone noticed a document had changed. Consignment
order doc numbers are enumerable, so a scoped rep with a doc_no could PATCH the
header, override a line price, add or delete a payment, or cancel the order
outright — on an order belonging to a rep they have no relationship with.

**Root cause — the reads were guarded and the writes were not.** `GET /:docNo`,
`/audit-log` and `/payments` all ran `salesDocOutOfScope`. Every one of the TEN
write verbs had COMPANY scope only. So the module correctly refused to SHOW a
rep an order outside their scope, and cheerfully let them WRITE to it.

**This is the second time.** `mfg-sales-orders.ts:806` fixed exactly this on the
Sales Order on 2026-07-22, in these words: *"a scoped salesperson could PATCH /
delete / repay / reassign ANY SO by enumerable doc_no"*, covering *"all four SO
payment verbs, which WRITE money"*. The consignment order is described in-repo
as an SO clone — the clone did not inherit the fix, because a fix applied to one
file is not applied to its copy.

**Fix.** `selfScopedConsignmentBlocked`, a direct mirror of the SO's
`selfScopedSalesBlocked`: company checked FIRST and for everyone (view-all
included, via the degrading three-state sentinel), salesperson checked second
and only for the self-scoped tier, same refusal body byte for byte. It scopes
the LOAD, not a stamp. Company scope was ADDED TO, never replaced. The guard
sits ahead of `coHasDownstream` in every verb so an authorization refusal is
never dressed up as a 409 `co_has_downstream` — the SO's own 2026-07-22 lesson,
now pinned by a test.

27 tests across three layers, including a STRUCTURAL sweep of the route source
so a write verb added later cannot skip the guard and the create's exemption
must be documented to pass. Non-vacuity proved twice by reverting individual
guards.

**Deliberately NOT fixed, and written into the source rather than skipped:** the
CO create takes `body.salespersonId` VERBATIM, while the SO gates it on
`scm.so.attribute_other` and overrides a self-scoped caller's pick. So a scoped
rep can still book a NEW consignment order under another rep's name. That
changes who gets paid, it is a different control from row scope, and the owner's
ruling was about reaching an EXISTING order — so it is his call, not the fix's.

**Lesson.** When a module is a clone, its bug ledger is shared whether anyone
says so or not. Fixing a rule in the original and not grepping for its twin is
how the same defect ships twice — and `check-shared-mirrors` only refereed
`shared/` rule modules, not two route files that are copies of each other.

**Ref.** the SO's fix 2026-07-22, this one 2026-08-13.

## The backend said the stock write failed; the screen said "Stock OUT recorded." [high]

**Symptom.** A purchase return is created, the inventory movement is refused at
the database, and the operator is told it worked. The stock never left, the
paperwork says it did, and nobody finds out until someone counts.

**Root cause — a 200 that CARRIES a failure, and nobody reads the payload.**
`POST /purchase-returns` has returned `movementErrors` since it was written.
`useCreatePurchaseReturn` typed the response as `{id, returnNumber}` and
`PurchaseReturnNew.tsx` announced "Stock OUT recorded." unconditionally. The
backend was doing its half correctly for months; the field simply had no reader.

The three LINE verbs were worse: `writePrLineDeltaMovement` returned `void`, so
they discarded a failure they already knew about. `DELETE` answered **204**,
which has no body and cannot carry the error at all — while every sibling
line-delete (`consignment-notes`, `consignment-returns`, `delivery-returns`)
already answered `200 {ok, movementErrors?}`.

**This is a class, not one bug.** Eight backend route files return
`movementErrors`; before this fix, THREE frontend files read it — and one of
those three is a mobile wizard. The rest of the surface throws the field away.

**It is also invisible to the checker built for exactly this problem.**
`check-silent-mutations.mjs` asks whether a mutation handles a REJECTION. These
mutations resolve: HTTP 200, no exception, `onError` never fires. The failure
rides *inside* a success. A different shape needs a different check.

**Fix.** `writePrLineDeltaMovement` now returns `string[]` in the create path's
exact shape; all three verbs return it; `DELETE` moves 204 -> `200 {ok,
movementErrors?}` because a status with no body cannot report anything. A
`RECOUNT_FAILED` audit row lands too, matching the shape `grns.ts` and
`delivery-orders-mfg.ts` already use. The write still COMMITS — an edit must not
be rolled back for a ledger hiccup — but it is now loud. Frontend: one shared
`reportMovementErrors` helper in the hook layer so desktop and mobile cannot
drift apart, and `PurchaseReturnNew.tsx` stops claiming success the response
contradicts.

**Stated honestly: today's operator-visible change is the CREATE path only.**
The desktop detail page has no line editor (`useUpdatePurchaseReturnItem` and
`useDeletePurchaseReturnItem` have zero consumers, and the Edit button
navigates to an `?edit=1` param the page never reads), and mobile renders
purchase returns read-only. The line verbs are API-only; the wiring is what a
future editor inherits.

**Lesson.** Returning an error field is half a feature. A repo-wide grep for the
field's READERS is the other half, and it takes ten seconds. When a response
shape says "this may have failed", something has to be looking.

**Ref.** 2026-08-13, owner decision ("要,和创建路径一致").

## A payment recorded in one company moved the OTHER company's invoice [high]

**Symptom.** None at the keyboard, which is why seven of these survived. An
operator with company A active opens company B's invoice by id and records a
payment. The payment row is filed under **A**. `recomputePaid` then moves **B's**
`paid_centi` and flips B's AR status SENT -> PARTIALLY_PAID -> PAID. Both books
are now wrong and neither shows an error.

**Root cause — A STAMP IS NOT A PREDICATE.** Every one of these handlers read a
document BY ID with no company predicate and then wrote a child row stamped with
the ACTIVE company:

```ts
const { data: si } = await sb.from('sales_invoices').select(...).eq('id', id).maybeSingle();
...
await sb.from('sales_invoice_payments').insert({ company_id: activeCompanyId(c), ... })
//                                               ^ this is a STAMP, not a check
```

The stamp is what makes it silent: the row looks correctly attributed while
sitting on the wrong parent. `sales-invoices.ts:2068` carried a comment reading
*"multi-company: match the SI's company"* directly above a line that never
compared anything.

**Seven sites, all confirmed by reading the source:** `sales-invoices.ts`
`POST /:id/payments` (:2068), `PATCH /:id/payment` (:2555, the Outstanding page's
quick-pay), `DELETE /:id/payments/:paymentId` (:2152 — takes a payment OFF the
other company's invoice; the existing `payment_doc_mismatch` check only proves
the payment belongs to the invoice in the URL, never whose invoice that is),
`GET /:id/payments` (:1971), `POST /:id/items/from-do/:doId` (:1461),
`delivery-orders-mfg.ts` `POST /:id/items` (:4593 — the ADD verb, the only one of
three left unscoped; on an already-shipped DO the resync moves the OTHER
company's stock), and `delivery-returns.ts` `POST /` + `/from-do(s)`.

**Two of them are CONVERTERS, and that is the sharper half.** `companyScope.ts`
names four conversions that each refuse a cross-company source (SO->DO, SO->SI,
DO->SI, PO->GRN). The partial DO->SI form and the whole DO->DR path checked
NOTHING — so a 2990 delivery could be folded into a Houzs invoice and 2990's
revenue posted to Houzs' books, or returned as a HOUZS return with a Houzs
document number, writing the stock back in against the wrong ledger.

**Fix.** `scopeToCompany` on every header read; `isCrossCompanySource` +
`crossCompanyConversionBlocked` on both unguarded converters. 8 new tests in
`tests/companyScopeSalesInvoiceMoney.test.ts`, proved non-vacuous by reverting
the fixes (3 of 8 fail) and restoring them (8 pass).

**Lesson, and it is about the tooling as much as the code.**
`check-company-scope.mjs` reported **0 WRITE findings** while all seven existed,
because `.from('x').insert({ company_id: activeCompanyId(c) })` contains a real
`.from(` query and the helper's name, so its scoped-ness test passed. That is the
FIFTH blind spot found in that script in one day, and like the other four it made
the number too SMALL. The checker now strips an insert payload before testing,
and the honest count went 0 WRITE -> 11 WRITE.

**Ref.** 2026-08-13, audit ledger §A.

## A test froze the OLD ASSR company rule, so the stale copy of it looked correct [medium]

**Symptom.** None visible, and that is the finding. When this branch deleted
`search.ts`'s private copy of `assrCompanySql` — a copy still applying a HOUZS
pin the owner removed on 2026-07-20, so a 2990 rep saw HOUZS service cases and
missed their own — `tests/searchScope.test.ts` went RED. The obvious reading was
that the fix had broken something. It had not. The test was the second stale
artifact.

**Root cause (traced).** PR #934 (`dc16fb2e`, 2026-07-21) deleted
`assrPinsToHouzs()` and the `houzsCompanySql` branch, leaving
`assrCompanySql(c, col) = allowedCompaniesSql(c, col)` — no role consulted at
all (`routes/assr.ts:141`). It updated `assr.ts` and
`tests/assrCompanyScope.test.ts` and missed TWO other places that held the old
rule: the private copy in `search.ts` and `tests/searchScope.test.ts`, whose
`toEqual([9001])` is a frozen snapshot of the pre-#934 pin (last touched by #910
and #859, both older than #934).

**Two stale artifacts agreeing with each other is why neither looked wrong.**
The test asserted the copy's behaviour, the copy satisfied the test, and the
pair was self-consistent and jointly wrong for three weeks. A drift only becomes
visible when something OUTSIDE the pair is compared against it.

**Fix.** The test now asserts the real rule, plus the direction nothing covered:
a Sales rep granted only 2990 sees ONLY the 2990 case. That is the half of the
old pin's damage that was invisible — it did not merely add HOUZS cases the rep
holds no grant for, it HID the rep's own.

**Lesson.** A test is a copy of a rule, and it rots exactly like the code copies
`check-shared-mirrors` exists to referee. When a rule changes, grep for its
NAME across `src` AND `tests` before deciding the change is complete — #934
changed the rule in one file and left it standing in two others.

**Ref.** #934 (the original miss), this branch (both copies removed), 2026-08-13.

## Move up / Move down on a category did nothing when the server refused it [medium]

**Symptom.** The owner's canonical shape: press the kebab menu's "Move up", the
card stays where it was, nothing is said. Indistinguishable from a dead button.

**Root cause.** `Categories.move()` (frontend/src/pages/scm-v2/Categories.tsx)
fires `updateMut.mutate(...)` twice — fire-and-forget, nothing awaits it — and
`useUpdateCategory` carried an `onSuccess` and no `onError`. The page's OTHER
consumer of the same hook, `CategoryForm.onSubmit`, awaits `mutateAsync` in a
try/catch and renders `errMsg(e)`, so the SAVE path was always loud and only the
REORDER path was mute. A hook is not safe because one of its callers is: the
verdict has to be taken per call site.

**Fix.** Per-call `onError: writeFailedAs('Category order not changed')` on both
`.mutate` calls in `move()`, leaving the form's inline error panel untouched. The
same sweep closed 37 other mutations that had no error path at all — every one of
them an exported hook in `frontend/src/vendor/scm/lib/*-queries.ts` with ZERO
callers today, so nothing was broken for a user yet; they now carry
`writeFailed` / `writeFailedAs` so the first page wired to one cannot inherit the
silence. `check-silent-mutations.mjs` went 41 UNRESOLVED to 0.

**Lesson.** `check-silent-mutations.mjs` resolves a hook by asking whether ANY
consumer handles the failure. That is the right question for reporting and the
wrong one for a verdict — `useUpdateCategory` would have passed on the strength of
the consumer that was fine. Also: a stale comment sent the reader the other way —
`grn-queries.ts` still describes `usePurchaseReturnFromGrn` as "a context-menu
action on a LIST row (GoodsReceived.tsx)", and that file no longer exists and no
caller does either.

**Ref.** branch `fix/company-scope-sweep`, 2026-08-13.

## Reducing a line on a shipped DO returned the stock at a made-up cost, and minted a lot at it [high]

**Symptom.** None visible, which is why it lasted. An operator lowers a qty on an
already-shipped DO; the stock comes back; the numbers look plausible. What
actually happened is that the returning units were priced at a figure no lot ever
charged, and a NEW inventory lot was opened at that figure for the next FIFO
consumer to eat.

**Root cause.** `resyncInventoryForDo` priced the compensating IN at the bucket's
weighted average:

```
unit_cost_sen = round(out_total_cost / out_qty)
```

That average blends units that HAVE a cost with units that do not. A "ship
anyway" oversell leaves its short units with no lot consumption, so they
contribute 0 to `out_total_cost` while still counting in `out_qty`. Return 4 of an
OUT of 10 where 6 cost 100 sen and 4 cost nothing and it hands back 60 sen/unit —
240 sen of capitalised value for stock that is worth either 400 or 0 depending
on which units came back, and the qty delta does not say which.

**Correction 2026-08-13 (audit).** This paragraph first read "120 sen/unit — 480
sen … either 1,000 or 0". The arithmetic is `600 / 10 = 60`, and both the code
this entry describes and the migration that replaced it say 60: mig 0286's
header worked example, and `delivery-orders-mfg.ts:1788`. The mechanism was
right; the numbers were not.

The DO CANCEL path never had this problem: `fn_reverse_do_out` (0198) walks
`inventory_lot_consumptions`, the row-level record of which lot paid for which
unit, and restores each unit to its own lot at its own cost. The partial path had
no equivalent, so it invented one.

**Fix.** Migration 0286 `fn_return_do_units_at_cost` — the PARTIAL form of the
same function. Unwinds the bucket's consumptions newest-first, returns each unit
to the lot that paid for it, shrinks or deletes the consumption row, restamps the
OUT's COGS from what survives, and writes ONE balancing IN at cost 0 with its
minted lot closed (the value went back to the original lots; pricing it again
would capitalise it twice). Units with no consumption behind them return at
nothing and are REPORTED in `qty_uncosted`, never smeared into a per-unit figure.
The old blended row survives only as a fallback for a database without 0286,
because a reduction that posts nothing leaves shipped stock permanently deducted —
worse than an imprecise cost. Owner decision 2026-08-13 ("按原成本退回").

**Lesson.** When the truth was recorded at the time of the event, do not
re-derive it from an aggregate afterwards. The average was computed from
`SUM(total_cost)/SUM(qty)` over a bucket, and every fact needed to avoid it was
sitting one join away in `inventory_lot_consumptions`. Also: a rule that cannot be
derived from the data — LIFO here — is a CHOICE, and it belongs in the migration
header in words, or the next reader will read it as a fact and preserve it for
the wrong reason.

**Ref.** mig 0286 + `tests-pg/returnDoUnitsAtCost.pg.test.ts` (9 cases; the first
asserts the OLD arithmetic is wrong on the fixture, so the suite cannot pass
vacuously), audit ledger B6, 2026-08-13.

## Posting a payment voucher stamped a journal entry into the other company's ledger [high]

**Symptom.** None at the keyboard. `POST /payment-vouchers/:id/post` accepted a
voucher id from either company and wrote the GL entry against whichever company
that voucher belonged to.

**Root cause.** The handler loaded the voucher by id with no company predicate,
then built the journal entry from `pv.pv_number`, `pv.credit_account_code` and
`pv.company_id` — so the leak was not a read of someone else's data, it was a
WRITE into someone else's books. The sibling paths were already correct: the GET
at `:208` scopes this exact read, and `cancelPaymentVoucherHandler` was hardened
by PR #826. Post is the same door and was the one left unlocked. RLS is not a
backstop here: mig 0061 enabled it with NO policies and the SCM client is the
service-role client, which bypasses it.

**Fix.** `requireActiveCompanyId` + `scopeToCompanyId` before the load, refusing
with the shared `NOT_THIS_COMPANY` 404.

**Lesson.** Found TWICE, independently — by this audit and by #2086 — and the two
fixes were byte-for-byte the same idea. An audit that hardens "the reads" and
stops has done half a job; the write paths are where the damage is, and they are
easy to miss precisely because a write path usually starts with a read.

**Ref.** #2086 and audit ledger §A, 2026-08-13.

## A system-wide destructive rename had no permission gate, because two comments each said the other side had it [high]

**Symptom.** `POST /maintenance-config/sofa-compartments/rename` renames a sofa
compartment code across the SKU master, EVERY historical doc-line snapshot,
Modular allowed-options, combos, quick picks and in-flight carts — irreversibly —
and opened straight at `c.req.json()` with no check of any kind.

**Root cause — a gate handed over and never received.** The porting migration
(`scripts/scm-schema/port-missing-functions-triggers.sql:165`) says:

> "The 2990 body opens with `IF NOT is_admin() THEN RAISE forbidden`. scm has no
> is_admin()/auth machinery … **The admin gate now lives in the route/RBAC
> layer** — the DB-level gate is dropped here … (Behaviour change — flagged.)"

The route comment said the opposite:

> "Admin-gated inside the function (is_admin()); 403 surfaces here."

The DB dropped its gate and pointed at the route. The route believed the DB
still had one. **Nobody wrote it.** Both of that handler's siblings in the SAME
file (`POST /changes:237`, `DELETE /changes/:id:347`) do check
`canWriteScmConfig`. The `42501 → 403` branch is dead for the same reason:
service-role client, RLS bypassed, and the `RAISE` was removed with the gate.

**Fix.** `canWriteScmConfig(c)` on the handler, and the lying comment replaced
with the evidence.

**Lesson.** "Flagged" in a migration comment is not a hand-off. When a guard
moves layers, the receiving layer's change belongs in the SAME commit.

## Two config routers let any SCM user rewrite shared master data [high]

**Symptom.** `POST|PATCH|DELETE /localities` (the shared 5,870-row Malaysian
postcode master, and `warehouse_id` — the city-level delivery-routing override)
and `PUT|DELETE /state-warehouse-mappings/:state` (which warehouse an ENTIRE
STATE ships from) had no permission check at all.

**Root cause.** Neither file imported `houzs-perms`, and both routers are mounted
bare — `localities` is listed in `SCM_UNGUARDED_PREFIXES` (`lib/scm-areas.ts`),
so no area guard runs over it either. The only barrier was `requireScmAccess`,
which admits any SCM user including a view-only Sales Executive. `my_localities`
has no `company_id`, so an edit hits BOTH companies.

**Fix.** `canWriteScmConfig(c)` on all five writes, matching every sibling on the
same ungated umbrella (`currencies.ts:76`, `categories.ts` ×7, `staff.ts:433`).

**Ref** - `fix/company-scope-sweep`, 2026-08-13.
## A refused write reached nobody — 35 mutations across the SCM UI [high]

**Symptom (owner).** "我点了 deactivate 它也是没反应." Press Deactivate on a
fabric: the row does not change, no message appears, nothing in the console. The
button reads as broken.

**Root cause (traced).** `vendor/scm/lib/fabric-queries.ts` had EIGHT mutations,
eight `onSuccess`, and ZERO `onError`. The server's refusal — the SCM area guard
wanting `edit` where the grid's GET only needs `view`
(`scm/middleware/area-guard.ts:16`), a 409 while the active company has not
resolved, a 404 on the other company's row — arrived, was correct, and was
dropped on the floor. `serviceNotify` was ALREADY imported in that file, used for
one SUCCESS toast on the tier update; only the failure half was missing.

This is the worst shape a defect can take here: the USER cannot report it
usefully, and the DEVELOPER cannot see it either.

**Fix.** Shared `writeFailed` (`vendor/scm/lib/mutation-error.ts`) showing the
SERVER's own sentence — `authedFetch` throws Errors carrying it, and a generic
"something went wrong" would only send the next person hunting again.

**Correction 2026-08-13 (audit).** Two details in this entry were wrong about the
file it names. (1) The count is EIGHT, not nine — `fabric-queries.ts` has eight
`useMutation` calls (`useUpdateFabricTier`, `…SupplierCode`, `…Series`,
`…Active`, `…Description`, `useCreateFabric`, `useBulkUpsertFabrics`,
`useDeleteFabric`), and had eight before the fix too (`git show e1fb493b^` — 8
`useMutation`, 0 `onError`). The file's own header comment at
`fabric-queries.ts:17` still says "all nine"; it is wrong the same way.
(2) Fabric does NOT use the shared `writeFailed`: it defines a local
`fabricWriteFailed` (`fabric-queries.ts:31`) with its own title, "That change was
not saved". Same shape — it surfaces `err.message`, the server's own sentence —
but the shared helper is what the OTHER 33 files import (31 `*-queries.ts`, plus
`Categories.tsx` and `PhotoGallery.tsx`), not this one.

**System-wide.** New `frontend/scripts/check-silent-mutations.mjs`: 297
`useMutation` sites, 270 with no `onError`. It does a SECOND pass over each
hook's consumers, because "no onError" is not "nobody catches it" — 182 are
CAUGHT (`mutateAsync`, `.isError`, or per-call `.mutate(vars, { onError })`), 53
UNRESOLVED and listed for a human, **35 genuinely SILENT**. All 35 fixed.

**The checker's own first answer was 104, and it was wrong** — it could not see
the per-call `.mutate(vars, { onError })` form, which `ConsignmentNoteNew` uses.
Reading the source of a case it had flagged is what found it. 104 → 35. The raw
270 was never the bug count.

**Ref** - `fix/company-scope-sweep`, 2026-08-13. See `docs/one-sided-rules-coe.md`.

## Variants were demanded on 9 forms whose own servers never asked [high]

**Symptom (owner).** "明明是当我有 ProcessingDate 和 DeliveryDate 的时候，它才
compulsory，现在怎么变成就算没有 ProcessingDate，也强制要求我填写了？"

**Root cause — a default, not a rule.** `SoLineCard` declared
`variantsRequired = true`, commented "DEFAULT true so Consignment + any other
consumer is unchanged (owner 2026-07-14)". ELEVEN render sites exist; TWO passed
the prop, one passed false, and the other NINE silently inherited `true`.

Checked against each document's OWN route:
- `consignment-orders.ts:687` runs the check `procDate ? ... : []`; its PATCH
  (`:1267`) only collects offenders when `internalExpectedDd` is set. CONDITIONAL.
- `consignment-notes.ts` / `consignment-returns.ts` / `delivery-returns.ts` /
  `sales-invoices.ts` — `findIncompleteVariantLines` appears **zero** times. The
  requirement was pure client-side invention.

**Fix.** CO New + Detail pass the conditional; the eight downstream cards pass
false (the rule `DeliveryOrderNewV2` already states for the DO). **The default is
gone** — `variantsRequired` is a REQUIRED prop, so the next caller that forgets
it fails to compile instead of shipping a field the operator cannot get past.

**NOT changed.** `SalesOrderNew`'s confirm gate (`:1443`, owner 2026-08-08,
HC-SO-2607-008) requires category axes on CONFIRM "date or no date". That is an
explicit owner decision; its marker and its gate disagree and that is an owner
call, recorded not silently resolved.

**Superseded, same day.** That owner call was made and the gate is gone. The
block is now `if (processingDate)` — variant completeness is the PROCEED rule and
only the proceed rule (owner 2026-08-13: "只要是没有 proceed 这一张订单，其实都不
一定是需要填写的，除非它是 proceed 了"). The comment that replaced it records why:
running it at confirm "made a salesperson unable to book a real order from a real
customer who had not yet picked a seat height". Read this paragraph as history,
not as an open item; the code is `SalesOrderNew.tsx:1443-1455`, commit
`1d7d36cc`.

**Ref** - `fix/company-scope-sweep`, 2026-08-13.

## The UI locked a payment method the API would have let you delete [medium]

**Symptom.** SO Maintenance renders the `Installment` payment-method row locked
— value / active / delete disabled, tooltip "it can't be removed or turned off"
— while the API would have accepted deleting it.

**Root cause.** `isCorePaymentMethodRow` was inferred from
`PAYMENT_METHOD_VALUE_TO_CODE`, so ONE constant answered two questions with
opposite needs: `paymentMethodCodeForValue` deliberately EXCLUDES `Installment`
(legacy installment ledger rows persist the code directly), while the lock check
must INCLUDE it (it is wired into order logic — the DO payment schema is
`z.enum([...,'installment'])`). The frontend and backend copies landed on
opposite answers, and their comments said so out loud: frontend "the FOUR core
method rows … the API mirrors this with a 409"; backend "the THREE locked core
rows … 'Installment' is NOT core".

**Fix.** `PAYMENT_METHOD_CORE_VALUES` declared explicitly on both sides, four
entries. `VALUE_TO_CODE` keeps its documented three.

**How it was found, and the general lesson.** New
`backend/scripts/check-shared-mirrors.mjs`. The frontend does NOT import the
backend's rule modules — it VENDORS COPIES. Only `phone.ts` has a byte-identical
canonical test, which is exactly why phone normalisation has never drifted. Of 41
rule modules, this was the one real divergence.

**Ref** - `fix/company-scope-sweep`, 2026-08-13.

## Two audit scripts reported a clean run because their regex could not match [high]

**Symptom.** `check-company-scope.mjs` reported 34 findings. After a one-line
repair it reported 37 — and the extra was `POST /payment-vouchers/:id/post`,
which posts a journal entry into the voucher's company ledger with no company
predicate. The tool had been hiding it.

**Root cause.** Two escapes lost on the way into a JS string: `"\s"` is not the
whitespace class, it is the letter `s`; `"\b"` is not a word boundary, it is
BACKSPACE (0x08). The named-handler resolver could therefore never match a
declaration, `declAt` stayed -1, and the scan silently fell back to slicing
"this registration to the next" — reading a DIFFERENT function's body.
`POST /:id/cancel` was being reported against `reversePvAccounting`, three
functions away.

The same day, `check-shared-mirrors.mjs` extracted only `export function` and
missed `export const foo = () => {}`. Nine of thirteen pairs compared ZERO
functions and it printed "every shared function is identical" — about an empty
set.

**Fix.** Escapes doubled; arrow-function form parsed; NO-OVERLAP is its own
verdict, never folded into a pass. **Every checker now self-tests its patterns at
startup and exits non-zero rather than reporting from a dead one.**

**Lesson.** A regex that cannot match fails SILENTLY and looks exactly like
success. A verdict computed over nothing must never read as a pass.

**Ref** - `fix/company-scope-sweep`, 2026-08-13.

## Switching company destroyed the salesperson's POS cart, silently [high]

**Symptom** - a salesperson who works both companies builds a Houzs POS cart,
switches to 2990, saves anything there, switches back — the Houzs cart is empty.
No error at any step. Indistinguishable from "I never saved it", which is why it
was never reported as a bug.

**Root cause - the KEY, not the scoping.** `scm.pos_carts` came from the 2990
import keyed `staff_id uuid PRIMARY KEY`
(`scripts/scm-schema/2990s-full-schema.sql:930`). Migration 0100 added
`company_id` so the merged backend could scope carts per company — its own header
says carts "must be company-scoped ... like every other per-company module" — and
left the PRIMARY KEY untouched. A column was added; the key was not. The table
therefore still held exactly ONE row per salesperson across both companies, while
`routes/pos-cart.ts` read it with `scopeToCompany` and wrote it with
`onConflict: 'staff_id'`. The 2990 save upserted onto the Houzs row: `lines`
replaced, `company_id` restamped to 2. The scoped Houzs GET then matched nothing.

**Why it looked handled** - `company_id` is present on the table, stamped on every
write, and filtered on every read. Everything you can see in the route file is
correct. Only the DDL says otherwise.

**Fix** - migration `0284_scm_pos_cart_company_key.sql` [renumbered]: backfill NULL
`company_id` to HOUZS, `SET NOT NULL`, then drop the single-column PK and add
`PRIMARY KEY (staff_id, company_id)`. `pos-cart.ts` upserts
`onConflict: 'staff_id,company_id'` **in the same change** — per the
`special_addons` lesson below, a constraint that no longer matches the caller's
`onConflict` turns every save into a `42P10` 500, so the two must move together.
The route now refuses a save with a plain-language 409 when the active company is
unresolved, instead of writing a company-less row it can no longer key.

**Verification** - `tests-pg/posCartCompanyKey.pg.test.ts`, 9 cases against real
Postgres: the pre-migration key is asserted to be the single column FIRST (so the
fixture cannot drift into already-fixed and pass vacuously), then the re-key, the
existing cart surviving it, two companies holding a cart for the same staff, the
route's exact `ON CONFLICT` statement leaving the other company's cart
byte-identical, re-run idempotency, the NULL backfill, and NOT NULL. **These ran
SKIPPED locally — this machine has no Docker and no `TEST_DATABASE_URL`. They
execute on CI's postgres:16 service container. Nothing here has been observed
green yet.**

**Ref** - `fix/company-scope-sweep`, 2026-08-13.

## Fabric-tier overrides: one company can delete the other's, and overwrite it [medium]

**Symptom** - a model's fabric-tier delta reverts to the global value with no edit
behind it, so the SO recompute quietly prices the model differently.

**Root cause** - `DELETE /special/:modelId` and
`DELETE /compartment-special/:compartmentId` in `routes/fabric-tier-addon.ts`
filtered on the id alone, while the sibling GETs use `scopeToCompany` and both
tables carry `company_id NOT NULL` (mig 0083). Same class as the sofa-combo and
model-free-gift deletes fixed in the same pass.

**Fix** - both deletes wrapped in `scopeToCompany`.

**KNOWN AND NOT FIXED, deliberately** - the PK of both tables is the single
business column (`model_id`, `2990s-full-schema.sql:770`; `compartment_id text
PRIMARY KEY`, mig 0025:11). Mig 0083 added `company_id` and left both keys alone,
so each table can hold only ONE row per model/compartment across all companies and
the upsert (`onConflict: 'model_id'` / `'compartment_id'`) overwrites whichever
company saved first — the same shape as the POS-cart entry above. Scoping the
delete cannot fix that. Making it `(company_id, model_id)` is a migration AND a
business question (does Houzs want per-company fabric-tier deltas at all, or is
one shared table the intent?), so it is recorded here for the owner rather than
changed unilaterally.

**Both halves of that paragraph were overtaken, same branch — read it as
history.** The two tables looked identical and are not, and telling them apart
needed the PARENT table, not the child's column list.

- COMPARTMENT: real, and now closed. Mig `0287_scm_compartment_tier_override_company_key.sql` [renumbered]
  re-keys `scm.compartment_fabric_tier_overrides` to `(compartment_id,
  company_id)`, and the PUT moved to `onConflict: 'compartment_id,company_id'`
  in the same change (`fabric-tier-addon.ts:274`) — the constraint and the
  caller's `onConflict` must move together or every save is a `42P10`, the
  `special_addons` lesson below. It was NOT an owner question: the same file
  already scoped the GET by company, so the intent was on record and only the
  key was the leftover.
- MODEL: not a defect at all. `product_models` itself carries `company_id` —
  rows are created with `company_id: activeCompanyId(c)`
  (`product-models.ts:445`) and listed through `scopeToCompany` (`:181`) — so
  each company owns its own model rows with their own uuids and two companies
  can never contend for one `model_id`. A key of `(model_id)` already implies a
  company. `onConflict: 'model_id'` therefore still stands at
  `fabric-tier-addon.ts:155`, deliberately; the retraction is written into the
  route at `:173-192`.

Open, and unsettled from source: mig 0293's header justifies itself with
"`scm.compartment_library` carries NO `company_id`", and mig 0089:74 stamps
`company_id` on that very table (NOT NULL, FK, index). 0089's own header says the
text PK was left alone so "a 2990 import must use ids distinct from Houzs's".
Whether the two companies actually share compartment ids in production is a data
question this audit could not answer, so the re-key is at worst a harmless
widening — but the stated reason for it does not match the DDL.

**Ref** - `fix/company-scope-sweep`, 2026-08-13.
## The working-agreement gate measures narrower than the rules it enforces, in seven places [high]

**Symptom** — the gate from #2135 reports `OK` on pull requests that violate all
three MANDATORY rules in CLAUDE.md. Reproduced against real files on `main`, not
constructed: exit 0 in every case below where a control on the same content
exits 1.

**Root cause (traced, not guessed)** — each check tests a proxy for the rule, and
the proxy is narrower than the rule:

1. `ROUTE_RX` and `PERM_RX` require the string literal on the same line as the
   call. `mfgSalesOrders.post(\n  FORCE_UNLOCK_ROUTE,\n  requirePermission(FORCE_UNLOCK_PERM),` is
   the same endpoint and the same permission and detects as nothing. `main`
   already carries 20 registrations in that shape and 2
   `requirePermission(CONSTANT)` call sites in `tableLayouts.ts`.
2. Rule 2 passes when the guide is *touched*, not updated. One appended blank
   line to `docs/modules/sales-order.md` turned `FAIL` into
   `PASS ... the owning guide(s) were updated`. So does DELETING that guide —
   which also removes the coverage for every later PR, compounding with 7.
3. `addsBugHistoryEntry` matches any added `## ` line, so rewording an existing
   heading reports it as this PR's new entry — it reported
   "## The AutoCount write-back never told AutoCount which salesperson sold the
   order", which is #2148's bug, not the PR's.
4. `detectFixIntent` rests on the branch prefix. Of 61 merged PRs that added a
   ledger entry and touched code, 10 are not flagged at all (#2138, #2122,
   #2069, #2003, #1997, #1987, #1981, #2131, #2121, #2065) and 11 more are
   caught by the branch name alone, so renaming `fix/x` to `feat/x` clears them.
5. `SURFACE_PREFIXES` excludes `backend/scripts/` and rule 3 keys on the
   `migrations-pg/` path, so `ALTER TABLE ... ADD COLUMN ... NOT NULL` plus
   `ALTER TYPE ... ADD VALUE` in a `backend/scripts/*.mjs` one-off clears all
   three rules. That is the shape of #2118 and of the repair scripts #2138 was
   written about.
6. `findStatement` tests length (>= 12) and a placeholder list, not truth.
   `Reversal: revert this PR and redeploy` is false for an applied migration —
   that is the whole lesson of 0284 — and `Verified against: the staging
   database yesterday` is the 0284 failure verbatim. Both pass.
7. The self-checks are zero tripwires, not a ratchet. With 26 of 27 guides
   archived — which #2125 did once already — the index falls from 385 quoted
   paths to 2, every `FAIL` becomes a `WARN`, and the run still exits 0. Nothing
   asserts the index did not shrink. On this tree 1230 of 1472 (83.6%)
   surface-eligible files map to no guide and can only ever warn.

Two more, adjacent: `.gitattributes` marking a path `-diff` renders its content
invisible to every content-based rule while `files.length` stays non-zero, so
the ZERO-changed-files self-check never fires; and the gate is not in the
`main-protection` required checks (`backend-typecheck`, `frontend`), with
`required_approving_review_count: 0`, so a red run does not hold anything.

**Fix** — `scripts/lib/working-agreement.escapes.test.mjs` pins all seven as
executable tests asserting current behaviour, so narrowing any one of them turns
its test RED and forces a deliberate rewrite. The gate's own test step ran one
named file and would never have executed this suite; it is now
`node --test scripts/lib/*.test.mjs` — 30 tests across 2 files, exit 1 on any
failure, both verified. The seven measurement gaps themselves are NOT closed
here: each is a judgement about how wide the check should be, and widening them
is what a ratchet must not do in one step.

**Ref** — #2161. Gate under test: #2135.

# Bug history

Newest first. Each entry is one defect: what was seen, what caused it, what was
changed, and what class it belongs to. Entries are `##` (recent) or `###` under a
`## YYYY-MM-DD` date heading (older); nothing else in this file uses those levels.

**Before adding an entry, read [`docs/bug-classes.md`](docs/bug-classes.md).** It
holds the causes that have recurred here — with a count, the worst thing each one
cost, and **the name of the check that now fails on it**. If the bug you are about
to write up is an instance of a class listed there, the check should have caught
it: say why it did not, and widen the check in the same PR. If it is a new class,
add it there once it has recurred, with a check — or under *Classes with no check
yet*, saying what blocks one.

That file exists because this one was not enough on its own. On 2026-08-10 a
stringified value bound to a jsonb parameter corrupted 146 sofa lines three times
in an afternoon; it was written up here and given a COE; on 2026-08-13 the repair
script written to undo the damage reproduced it, turning seven production rows
string-shaped. The write-up was read. Nothing mechanical enforced it.


## Five causes recurred after being written up, because a write-up is not a check [high]

**Symptom** — the same five faults kept coming back, each one already described
in this file and in a COE, some of them more than once:

1. **A pre-serialized value bound to a json/jsonb parameter.** Six occurrences
   in 15 days, one COE (docs/jsonb-double-encoding-coe.md), 22 hand-written
   warnings scattered through `backend/` — and TWO live violations still on
   main when this gate was written, one of them inside the repair script for
   the damage the class had already done.
2. **A read whose failure is discarded** (`const { data }` with no `error`,
   `.catch(() => {})`). Counted 785 four weeks before this; 954 when counted
   again. The class GREW by 169 sites after fifteen were fixed by hand and the
   fix was declared complete. Nothing had ever counted them.
3. **A parameter that decides, declared optional** — `companyId`, `itemCode`,
   `soItemId`, the idempotency key. Seven recorded occurrences. `?:` spells
   "omitted" and "nothing to say" identically, so a by-SKU exemption can be
   half-applied and typecheck stays green.
4. **A generator whose output is committed but is never re-run.** The codebase
   map generator crashed silently for three weeks; the map rotted while every
   dashboard stayed green.
5. **Searched columns without a trigram index.** Its checker existed — and
   until 2026-08-13 BOTH of its exit paths were `exit 0` and it was wired into
   no workflow at all. It could not fail, and nobody ran it.

**Root cause** — every one of these was already documented. The write-up was
read; the rule lived in prose; prose does not fail a build. The fifth is the
purest form: a check whose every exit path returns success is prose wearing the
clothes of a script.

**Fix** — five gates in `backend-typecheck`, the job that already finishes in
about a minute: `audit:jsonb-binds`, `audit:swallowed-reads` (a RATCHET — the
954 are pinned and may only fall), `audit:decision-params`, `audit:generators`,
`audit:trgm`. Each carries the entry it answers in a comment above it in
ci.yml. `audit:trgm` is deliberately NOT in either deploy workflow: it is a
static approximation, and a false positive must cost a conversation, never a
deploy.

The swallowed-read work that came in with this branch fixed 16 reads whose
failure silently AUTHORISES a write — including a quantity cap that lived
entirely inside `if (row) {…}`, so a failed read skipped the cap rather than
enforcing it.

**Class** — this entry defines the shape the classes are recorded in;
docs/bug-classes.md names each one with its count, its worst cost, and the
check that now fails on it.

**Ref** - `fix/bug-class-gates`, PR #2127 (with #2141), 2026-08-14
## The AutoCount write-back never told AutoCount who sold the order [high]

**Symptom** — the ERP -> AutoCount write-back went live on 2026-08-13. Two
re-queued sales orders retried four times each and the live `AED_HOUZS` book
answered, verbatim:

```
Foreign Key Error (Constraint Name=FK_SO_SalesAgent)
```

Nothing landed in the account book, so there was no residue to clean up — the
foreign key rejects the document before it is written.

**Root cause (traced, not guessed)** — `composeCreateSo` read
`mfg_sales_orders.agent` and nothing else. That column is legacy free text
filled only from `body.agent`, and **no SO form sends `body.agent`** — not
`SalesOrderNew.tsx`, not `MobileNewSO.tsx` — so it was empty on every order
created since the cutover. An empty Agent reaches AcSyncService as `""`
(`Set(() => so.Agent = Str(p, "Agent"))`; `Str` turns an absent key into the
empty string), and `""` is not a row in `dbo.SalesAgent`.

`/ensure-masters` could not save it either, which is the part worth
remembering: `mastersOf` only emits an `Agents` entry when `body.Agent` is a
non-empty string, so an empty agent opened nothing, the call returned `ok`
because it had nothing to do, and the create then died on the foreign key.

The ERP's real salesperson identity was one column along the whole time —
`salesperson_id` -> `scm.staff`, stamped at create as `salespersonIdToStamp`.
**The UI hid the gap for months:** `SalesOrderDetailV2.tsx` renders
`salespersonNameOf(salesOrder.agent, salesOrder.salesperson_id)`, which falls
back to the id, so a name appeared on screen while the column behind it was
empty.

**RULED OUT — a failed master-open.** The first theory was that
`/ensure-masters` had tried and failed and the drain sent anyway. It cannot
happen: `EnsureMasters` returns `{"ok": failed.Count == 0}` and the drain turns
`ok:false` into `masters not opened, document not sent`. The observed error was
the FK on `/create-so`, not that — so the agent was never in the payload at all.

**Fix** — both halves, because either alone leaves a hole:

1. **At the source.** `scm/lib/so-agent.ts`'s `soAgentToStamp` fills `agent`
   from the stamped salesperson's `scm.staff.name` when the caller supplies
   none, at all three create stamp sites (header, goods lines, SERVICE lines)
   and again on the header PATCH when the salesperson is reassigned. An
   explicit `body.agent` still wins; a blank one is not a supplied one.
2. **At compose, for the orders that already exist.** `resolveAcAgent` falls
   back to the salesperson behind `salesperson_id`; `SO_HEADER_COLS` carries the
   column and `readSalespersonName` turns the id into the name beside the other
   header reads, the same division `withLocations` draws for the line warehouse.
   A name `AGENT_MAP` does not know is sent as itself and opened by
   `/ensure-masters` — D10's 2026-08-13 rule applied to people, since the map is
   a snapshot of the book's spellings and not an allow-list.

The create's `scm.staff` read is the venue chain's read: `readStaffForStamp`
returns `{name, venueId}` off one row, where the router was two statements away
from fetching the same row twice. That also pays for the new lines under
`scripts/file-size-ceilings.json`, which lets `mfg-sales-orders.ts` only shrink.

**With BOTH empty the create is REFUSED** (`MissingAgentError`, a visible
`skipped` row through `noteReadFailure`) rather than sent to fail on the foreign
key. The document cannot land either way, so the refusal loses no successful
write; it converts four silent 500s in the AutoCount host's log into one row an
operator can read and the re-queue tool can retry. An EDIT is not refused —
`/edit` applies only the keys it is GIVEN, so omitting `Agent` leaves the book's
own value, the same asymmetry the stock Location runs under.

**The raw `agent` text is never passed through unmapped.** Production rows hold
bare `scm.staff` UUIDs (`useStaffLookup` carries a `UUID_RE` for exactly that)
and placeholder text like "Unassigned", and `/ensure-masters` opens an agent
under exactly the string it is given — so passing either through would write
permanent garbage master data into a licensed book. `scm.staff.name` is a real
person by construction, which is why only it is trusted unmapped.

**The class, for next time** — a display helper that falls back
(`salespersonNameOf(agent, salesperson_id)`) makes an empty column invisible on
screen, and the first system to read the column WITHOUT the fallback is the one
that finds out. When two columns hold one fact and only one of them is written,
say so where the writer is, not only where the reader is.

**Still open, same shape, not fixed here:** `readPoHeader` hardcodes
`agent: null`, so every `/create-po` sends `Agent: ""` into
`FK_PO_PurchaseAgent`. The ERP has no purchase-agent concept and no value to
send; picking one is an owner decision about what AutoCount's purchase reports
will show.

**Ref** — 2026-08-14, `fix/autocount-so-agent`.

## The file-size ratchet failed a PR for making an over-ceiling file SMALLER [medium]

**Symptom** — PR #2127 opened `backend/src/scm/routes/grns.ts`, which stood at
**3,591 lines on main** against a ceiling of 3,482, and left it at **3,586**.
The gate failed it: *3586 lines, ceiling 3482 (over by 104). This file may only
SHRINK.* The PR had shrunk it.

**Root cause** — the fix earlier that same day taught the gate to charge only
files the change TOUCHED. That was right, and not enough: touching is not
growing. A file already carrying 109 lines of someone else's debt then puts
every later author to a choice the ratchet never meant to offer — abandon the
improvement, or pay off the debt before you are allowed to fix a bug in that
file.

**Fix** — a touched file is charged only when THIS change grew it, measured
against its own line count at the merge base. Growth is still charged from the
first line; a file with no counterpart at the base is charged as new; and if the
base cannot be resolved, every touched violation is charged again. The violation
prints either way — the debt is real and stays visible, it is simply not billed
to whoever walked past it.

**The check** — `scripts/check-file-size-ratchet.mjs` gains the case, with the
real numbers: 3,591 at base and 3,586 now is not chargeable; 3,500 at base and
3,586 now is, from the first line.

**Class** — *a gate whose blast radius is wider than its subject*, third
instance in two days (the census counting deliberate tombstones, the ratchet
charging untouched files, this). The subject here is growth; the gate was
measuring altitude.

**Ref** - `fix/ratchet-charges-growth`, 2026-08-14

## The by-SKU variant exemptions reached the app and not the audits, and one of them reached the audits and not the app [medium]

**Symptom** — the same rule gave four different answers depending on which
program you asked.

- `check-so-noncatalog-lines.mjs` reported every DIVAN ONLY, ADJUSTABLE, (S+S),
  DOUBLE DECKER, DDB and CONSOLE line as missing variants it cannot have.
- `cross-fill-so-po-variants.mjs` judged adjustable / double-decker frames
  incomplete for want of a Divan Height and a Leg Height they do not have.
- `check-cutover-metrics.mjs` filtered divanless frames correctly and then
  printed "divan+leg" in the reason string anyway.
- And the opposite direction: a sofa CONSOLE / CT line was exempt from Seat
  Height **in the audit** and not in the app, so the SO gate operators actually
  hit still demanded a seat height from a console table.

**Root cause, traced not guessed** — the TypeScript half of this was already
closed and stayed closed. `itemCode` is a REQUIRED parameter of
`missingVariantAxes` / `missingConfirmVariantAxes` (PR #1763's follow-up, the
worked example under **BUG CLASS optional-param-noop** below), so `tsc` names
any call site that forgets it. Verified rather than assumed: all eleven
non-test TS/TSX call sites pass a real code, and the two indirect layers
(`findIncompleteVariantLines`'s `SoLineForVariantCheck.itemCode`,
`adjustmentIncreaseErrors`'s 4th parameter) type it non-optional too.

The holes were all in `.mjs`, and that is not a coincidence: a plain-node audit
script pays no compiler tax for re-typing the rule, so three of them had.
`check-so-noncatalog-lines.mjs` carried a **fifth hand-copy** of the axes table
whose helper had no `itemCode` parameter at all — under a header saying "keep
these three constants in lock-step with the source" — while the real item code
sat unused at the call site one line above.

`scripts/lib/variant-axes.mjs` exists to prevent exactly this and its header
claims "the copy cannot drift". It had drifted: it grew an `isSeatlessPiece`
exemption (owner 2026-08-11, "有些 sku 是没有的", with AutoCount PO-009553 as
the evidence) that the TypeScript rule never got. `variantAxesMirror.test.ts`
compares the two implementations, and it passed the whole time — its code list
held no CONSOLE or CT case, so the two were only ever compared on inputs where
they already agreed. **A mirror test is only as wide as its corpus.**

**Fix** — `isSeatlessPiece` ported into `so-variant-rule.ts` and its vendored
frontend twin, so the exemption reaches the gate operators hit; the mirror
test's code list now carries `8030-CONSOLE`, `9028-CT`, `HOK-CONSOLE (L)`,
`8030-CT01` **and the near-misses that must NOT be exempt** (`CONSOLE-1A`,
`CT-2A`, `8030-CTRL`, `8030-CONSOLIDATED`). `missingConfirmVariantAxes` +
`isColourKiv` added to the `.mjs` mirror and pinned by the same test, so
`check-so-noncatalog-lines.mjs` imports the rule instead of re-typing it and
passes the real `code`. `cross-fill-so-po-variants.mjs` and
`check-cutover-metrics.mjs` import both predicates instead of their local
copies, and the latter's reason string now applies the same divanless guard its
filter does. `tests/variantExemptionCallSites.test.ts` is the new check: no
script may re-type an exemption pattern, every completeness script must import
the mirror, and no call may pass two arguments.

**Two stale comments, corrected while here.** `missingConfirmVariantAxes`'s
docblock claimed "desktop, mobile and the backend confirm gate all read THIS so
the rule cannot drift" and the frontend test header said the same, while #2072
had removed variants from the confirm gate entirely — the function had ZERO
production callers. `docs/modules/sales-order.md` recorded that and deliberately
left the source comments alone, being a docs-only diff; this is that follow-up.
The function now has one honest consumer, the audit mirror.

**Ref** — 2026-08-14, this PR.

## Twelve audit scripts kept querying the column 0286 renamed away, and the guard that forbids it could not see them [high]

**Symptom** — every read-only cutover, go-live, reconciliation and completeness
audit under `backend/scripts` stopped working on 2026-08-13, and none of them
said so in those words. Twelve `.mjs` files named `internal_expected_dd` in live
SQL after mig `0286` renamed it to `processing_date` (applied on prod
2026-08-13T13:46:59Z). Postgres answers a missing column with **42703 and fails
the WHOLE statement**, so a run produced a stack trace and `exit 1` — not a
smaller number, no number at all. Two files were quieter than that:

- `probe-rename-preconditions.mjs` guarded its consignment row count on the
  presence of the NEW name and then SELECTed the OLD one. Post-rename the guard
  passes, the count 42703s, the READ ONLY transaction aborts, and the probe
  exits **2 — "the probe itself could not read"**, a false report about a
  database it can read perfectly well. Its `mfg_sales_orders` count guarded on
  the OLD name only, so after the rename it printed nothing at all — silence
  that reads as "no rows" rather than "I asked the wrong name".
- `backfill-so-dates.mjs`, which WRITES, refuses any document whose audit trail
  shows a person set, moved or REMOVED one of its dates. That refusal list held
  `internal_expected_dd` / `internalExpectedDd` and **not** `processing_date` /
  `processingDate`, so a Super-Admin *Remove Processing Date* performed after
  2026-08-13 leaves an audit row the scan does not match — and the backfill
  would write the removed date straight back.

**Root cause, traced not guessed** — the name was a string literal in each
script, and nothing enumerated them. PR #2153 fixed this class in the backend by
binding every route to `SO_PROCESSING_DATE_COLUMN` in
`src/scm/shared/so-processing-date.ts`, and `tests/soDatePairWiring.test.ts`
forbids the retired name — over a **hand-listed set of five `src/` files**. It
has to be hand-listed: the backend vitest suite runs in workerd, which has no
filesystem, so a test there can only check files somebody remembered to add. A
`.mjs` script cannot import the TypeScript constant either. The one place the
name was still typed by hand was therefore the one place no guard could reach —
the same gap `scripts/lib/so-terminal-states.mjs` and
`scripts/lib/do-shipped-states.mjs` were created to close for their own sets.

**Fix** — `backend/scripts/lib/so-processing-date.mjs`, the .mjs mirror of the
naming constants, pinned to the TS original by
`tests/soProcessingDateMirror.test.ts` exactly as the two existing mirrors are.
All twelve scripts read the column from it. postgres.js binds a bare
`${string}` as a PARAMETER — `h.${COLUMN}` sends `h.$1` — so the module also
exports `soProcessingDateFragment(sql)`, a `sql.unsafe` fragment that is inlined
as SQL text. `sql(name)` is deliberately NOT used: that path picks its builder
by regex-matching the SQL emitted so far, so the same call renders an identifier
after `SELECT` and garbage after `IN (...)`, which every one of these queries
has. `backfill-so-dates.mjs`'s refusal list is now built from the constants,
current spellings **and** legacy; the probe counts only columns the catalog
proved are there and names which one it counted.

**Why the new test walks the directory.** `tests/soProcessingDateOneName.test.mjs`
is `node:test`, run by `npm run test:scale-contract`, and it reads
`backend/scripts` off disk — so a script written tomorrow is covered by code
that already exists. Comments are stripped before matching: the rename is a
story worth telling, and `unify-processing-date.mjs` quotes the owner naming the
column verbatim. Measured on the tree this branched from: **12 offending files
before, 0 after.**

**Ref** — 2026-08-14, this PR. Same class as the entry below (a column name in a
string is invisible to `tsc`); this is the half of the tree that entry's test
could not see.
## Proceed wrote a column migration 0286 had renamed away, and three write paths never asked the both-dates rule [high]

**Symptom** — two faults on the same rule, found together while auditing every
write path that can set or clear the Processing Date.

1. Moving an SO to IN_PRODUCTION could not write the date it was proceeding
   with. `PATCH /:docNo/status` SELECTed `internal_expected_dd`, compared it,
   and assigned `patch.internal_expected_dd` — a column that stopped existing
   when mig 0286 renamed it to `processing_date`. The header PATCH's proceed
   branch read the same dead name through `effOf('internal_expected_dd')`, which
   resolves `undefined` for every order, so that path returned
   `proceed_needs_processing_date` unconditionally.
2. Three write paths could store exactly one of the two dates: the CO header
   PATCH, the amendment APPROVE path, and the `/status` proceed. The owner's
   rule is *"processing date 和 delivery date 必须同时有或者同时没有"*.

**Root cause, traced not guessed** — the rule was never in one place. It was
hand-written in FIVE files (SO create, SO header PATCH, CO create, amendment
submit, and one direction inside `so-save-problems`) and absent from three. Five
copies is also why the two directions disagreed: `so-save-problems` asked
delivery→processing under `processing_delivery_must_pair`, while
processing→delivery lived in the completeness block behind
`if (facts.procDate && facts.completeness)` — and neither consignment path
passes `completeness`, so on a CO a Processing Date with no Delivery Date raised
nothing at all. `so-save-problems.ts` said as much in a comment ("the CO header
PATCH runs no pair check of its own") and the comment was correct.

The dead column is the same class one layer down. Mig 0286's own header warns
that `jsonb_populate_record` IGNORES a JSON key that is not a column, so a stale
caller "would not error — the date would just stop saving", and says "the
callers are renamed in this same commit". The `/status` block was not. Nothing
the compiler sees can catch a column name that lives inside a string, so it
built, typechecked and shipped. `routes/so-amendments.ts` had the matching
shape: it IMPORTED `canonicaliseSoHeaderChanges` and never called it, so its
approve-time gates read the raw stored jsonb while `so-revision.ts` (which
applies the change) reads the canonical one — an amendment stored under the
pre-rename payload key walked past the deposit, completeness and date gates and
was applied anyway.

**Fix** — one predicate, `soDatePairRefusal` in
`backend/src/scm/shared/so-processing-date.ts`, called by every path that can set
or clear either date: SO create, SO header PATCH, SO `/status` proceed, amendment
submit, amendment approve, CO create, CO header PATCH, the aggregated
`so-save-problems` report (both directions now), and `unify-processing-date.mjs`,
whose single-column UPDATE now re-asserts `customer_delivery_date IS NOT NULL`
and refuses the transaction rather than writing half a pair. Grandfathering — a
stored unpaired pair the save leaves untouched — moved INSIDE the predicate, so
no caller re-derives it. Clearing the Processing Date now clears the Delivery
Date with it (header and every `line_delivery_date`, via
`p_apply_delivery_date`); the reverse stays a refusal, because cascading it would
clear the Processing Date and become the road around
`scm.so.remove_processing_date`. The `/status` and header-PATCH reads are bound
to `SO_PROCESSING_DATE_COLUMN`, and `so-amendments.ts` now actually calls the
canonicaliser it imported. The 2990 mirror is the ONE deliberate exclusion — it
replicates rows 2990 already committed, and a refusal there wedges its outbox
retrying forever — and the route now says so in a comment the test asserts.

**Why the test is a source scan.** `tests/soDatePairWiring.test.ts` anchors on
each path's source, with comments stripped, and fails if one stops calling the
predicate; it also fails on any live mention of `internal_expected_dd`. Eleven of
its fifteen assertions fail against the tree this PR branched from. A unit test
over the predicate would have passed throughout the entire bug: the logic was
never wrong, the enumeration was.

**Ref** — 2026-08-14, this PR. Related: **BUG CLASS optional-param-noop** below
(same shape, different mechanism: there the compiler was silenced by `?`, here by
the value being a string).
## The zero-cost ack migration took 0277, which main had already spent [med]

**Symptom** — `backend/tests/migrationNumbers.test.ts` fails on this branch:
`src/db/migrations-pg: 0277 is taken twice — rename your file to 0280_*.sql`.
CI red, and `main` requires that check to merge.

**Root cause (traced, not guessed)** — the branch numbered its migration `0277`
against the tree it BRANCHED from. While it was open, #1855 merged
`0277_scm_autocount_outbox.sql`, and 0278/0279 landed behind it. This is the
exact failure mode CLAUDE.md already names — *take migration numbers at MERGE
time by re-listing the tree, not when you branch* — and the same shape as the
0171 and 0230 collisions that each blocked a deploy for hours. It stayed
invisible here until the rebase, because the duplicate only exists in a tree
that contains BOTH branches.

**Fix** — renamed to `0280_scm_grn_zero_cost_ack.sql` [renumbered], the number the failing
test itself names. **Rename only, body untouched**, per the runner's own rule:
`pg-migrate` tracks by full filename, so an edited body would read to it as an
orphaned tracker row plus an unknown file to apply. The migration has never been
applied anywhere — it ships only on this unmerged branch — so there is no
tracker row to reconcile. The `Migration 0277` code comments that pointed at it
were repointed to 0280; the ones naming `scm.autocount_outbox` are genuinely
0277 and were left alone.

**Verified** — with the collision present, `migrationNumbers.test.ts` is
`1 failed | 7 passed`; renamed, that file is `8 passed`, and it plus
`zero-cost-receipt-guard.test.ts` are `33 passed` together.

**Ref** — PR #1907 `fix/zero-cost-po-exposure`, 2026-08-11.


## The file-size ratchet charged every open PR for one file it had never opened [high]

**Symptom** — on 2026-08-14 every open pull request failed `file-size`, all of
them naming the same file: `backend/src/scm/routes/grns.ts`, 3,591 lines against
a ceiling of 3,482. None of them had opened it. One of the blocked PRs was the
fix for a **live production defect** in the sales-order proceed path.

**Root cause** — two facts that are each fine alone:

1. `file-size` is NOT one of the ruleset's required checks (those are
   `backend-typecheck` and `frontend`), so a pull request CAN merge with it red,
   and one did — main outgrew its own manifest.
2. The gate charged whichever branch ran next for every violation in the tree,
   not for the files that branch had touched.

Together they turn one merged violation into a repository-wide stop: nobody can
merge until someone else shrinks a file they are not working on. The ratchet was
built to stop growth; it stopped shipping.

**Fix** — the gate now resolves the merge base, diffs it, and FAILS only on
files present in that diff. A violation in an untouched file is still printed in
full with its numbers, under a heading that says whose problem it is — silence
would let the tree drift, which is the thing this gate exists to prevent. If the
merge base cannot be resolved, every violation is charged again: a gate that
cannot tell whose fault it is must not let anything through.

**The check** — `scripts/check-file-size-ratchet.mjs` gains a case that pins the
split: one violation in a touched file fails, one in an untouched file is
reported with its 109 lines intact.

**Class** — *a gate whose blast radius is wider than its subject*. Same shape as
the fabric census that counted the tombstone a merge leaves on purpose, so
`require_clean` could never pass. Both fail on something nobody in the loop can
act on.

**Ref** - `fix/file-size-blames-the-toucher`, 2026-08-14

## The cost-stamping script priced a queen bed from a king's purchase line [high, money]

**Symptom** — `stamp-po-line-costs.mjs` planned to write RM470.00 onto
`DIVAN ONLY-(Q)` x3 and RM641.50 onto `ELEGANT (A)-(Q)` x1. The queen's own
purchase history is RM325 median over 152 lines (+44.6%) and RM585 over 52
(+9.7%). Worse, the dry-run log printed `LEFT AT ZERO` for those very lines
while the plan stamped them, so the log said the opposite of what APPLY would do.

**Root cause (traced, not guessed)** — the pricer resolved per
`(PoNo, ItemCode, Desc2)` but the TARGET lookup dropped the item code:
`bySigKey` was keyed `${ac_doc}|${sig(description2)}`. **Desc2 carries the
fabric, the leg and the gap — the SIZE lives in the item code.** So two bed
sizes on one purchase order share a Desc2 and collapse into one key. Measured
over the snapshot: of 170 target keys, 10 hold more than one line and 9 hold
more than one item code. The two above resolve to different prices, and in both
the priced sibling is a different bed size. Once stamped the line reads as
PRICED, so the new receipt gate could never catch it — the script defeated its
own guard. The contradictory log came from the same split: the `!hit` branch
counted the unpriced AutoCount line as left-at-zero while a *different*
AutoCount line's price reached the same ERP row through the code-blind key.

**Fix** — the decision moved out of the script into
`backend/scripts/lib/po-cost-plan.mjs`, where it runs with no database and is
unit-tested (`tests/poCostPlan.test.mjs`, wired into `test:scale-contract`).
Every key now carries the item code, by three routes, most exact first:
`linked_ac_dtlkey` (migration 0273, a 1:1 identity); `supplier_sku`, which holds
the RAW AutoCount `ItemCode` because `import-ac-outstanding-po.mjs` stores
`sku: l.ItemCode` verbatim — better than the mapping CSV, since a minted sofa
SKU still carries its AutoCount code there; then `material_code` via the CSV. A
DtlKey pointing at a different item code is refused rather than followed, and an
ERP row two AutoCount lines want at *different* prices is refused rather than
resolved. `plan[]` holds one entry per ERP id, so the closing count is no longer
inflated by double-counting. The dry-run prints one line per planned write —
the same list APPLY walks — plus the complement (`plan` and `skipped` partition
the rows read, asserted by a test), so the log and the write can no longer
disagree.

That partition test proves the DECISION partitions the rows; it cannot catch a
script that prints one list and writes another, which is the half that actually
shipped. Three further tests assert the SCRIPT's traversal against its own
source: exactly two `for (const p of plan)` blocks — one printing, one writing —
with the single `UPDATE` inside the second; no loop over `book.*` and no
`unmatchedUnits` counter, the walk that produced the false narration; and every
iteration in `main()` drawing from `plan`/`skipped` or a grouping of them, so no
third tally can be printed. Structural because `main()` opens a database
connection on import and cannot run in this harness. **Mutation-verified:** clean
**18 pass**; reintroduce the `book.poLines` narration loop and it is
**16 pass / 2 fail**; filter the printed list while APPLY keeps the full plan and
it is **17 pass / 1 fail**.

**Provenance of the footprint numbers — read this before quoting them.** Pre-fix
32 lines / 65 units / RM 9,482.00, post-fix 30 lines / 61 units / RM 7,430.50,
i.e. exactly the 2 lines / 4 units / RM 2,051.50 of wrong money removed. These
come from a RECONSTRUCTED ERP row set, **not** from the script's own production
DRY-RUN, which **has never been run** — `workflow_dispatch` resolves a workflow
from the DEFAULT branch, so while `stamp-po-line-costs.yml` exists only on this
branch it is not dispatchable (observed 2026-08-11:
`HTTP 404: workflow stamp-po-line-costs.yml not found on the default branch`).
**Treat the numbers above as an estimate of the right order, not as measurement.**
The binding sequence is therefore: merge, then dispatch the workflow at
`apply=0`, then read ITS `-- planned writes --` list — that list is the exact set
`apply=1` writes — and only then dispatch `apply=1`.

What IS measured in CI, on the real committed snapshot rather than by hand, is
the collision the fix removes: `tests/poCostPlan.test.mjs` re-derives from
`scripts/data/ac-po-line-costs.json.gz` that the pre-fix `(PoNo, Desc2)` key
yields 170 keys of which 9 merge more than one item code, that adding the item
code splits them apart, and that PO-009826 and PO-009802 are among them. That
assertion fails if the snapshot ever stops exhibiting the defect, which is the
signal to re-derive the footprint rather than trust the estimate above.

**What the audit RULED OUT** — the reviewer suggested `linked_ac_dtlkey` made a
1:1 match available today. It does not: a read-only production dry-run of
`backfill-ac-line-keys.yml` on 2026-08-10 reported `PO lines: erp lines 864; to
set 275; **already set 0**` — the column exists and is entirely NULL in
production. The DtlKey route is implemented and preferred, but every match today
comes from `supplier_sku` + Desc2. Do not assume that column is populated.

**The class, for next time** — *a key that resolves a value and a key that
selects the row it lands on must be the SAME key.* Two keys that differ by one
field look equivalent in review and diverge only where the dropped field is the
discriminator — here, exactly on the beds that share a fabric. And a dry-run
that reports on the SOURCE side while APPLY writes on the TARGET side is not a
dry-run; print the write set itself.

**Ref** — PR #1907 review round 2, 2026-08-11.


## Shutting the door on the product rows left them sitting in the fabric master, and a retire tool that could not prove they were unused would have been worse than none [medium]

**Symptom** - the guard below stopped a third product code reaching
`scm.fabric_trackings`, and deliberately did not touch `SOFA 5535` and
`SQUARE PILLOW`, which were already in it. The owner's question —
「为什么sofa 和square pillow在fabric convert里面？」 — was therefore still true of
prod after the fix that answered it.

**Root cause (of the gap, not of the rows)** - retiring them by hand is a
two-line UPDATE, and that is exactly the trap. Nothing in this database protects
a fabric code: there is **not one foreign key to `scm.fabric_colours`**, and
every reference to a fabric is a bare TEXT string inside jsonb or inside a
pipe-joined stock key. So "is anything using this code?" cannot be answered by
the schema, only by counting — across all 58 carriers `lib/colour-carriers.mjs`
knows about. A hand UPDATE, or a script that checked two or three obvious
tables, would deactivate a code that a live sales order still names, and the
line would go unpickable with nothing saying why. That is the same shape as
#1964 (the GRN arm went unswept) and the 2026-08-11 pass that superseded
`BO315-2-FEATHER` while 12 live rows still pointed at it.

**Fix** - `backend/scripts/retire-non-fabric-rows.mjs` + its workflow.
`MODE=plan` is the default, writes nothing, and holds the session
`default_transaction_read_only`; `MODE=apply` needs
`CONFIRM="I HAVE REVIEWED THE DRY-RUN"`. **It has no DELETE in it.** A retired
row gets `is_active = false` and a sentence appended to its description naming
the word that condemned it and the date, with the original description kept
verbatim in front — and the plan prints the exact reversal SQL, as a proper
single-quoted Postgres literal (the first draft emitted `JSON.stringify`, whose
double quotes Postgres reads as an *identifier*; both target rows contain `"`,
so the reversal would not have pasted). Before any row is touched the full
census runs against its code and **any live carrier outside the master refuses
the row**, which is re-checked inside the apply transaction in case the plan
went stale. The census engine (`resolveCarriers` / `countCarrier`) moved out of
`census-fabric-colour.mjs` into `lib/colour-carriers.mjs` so the reporter and
the writer cannot walk different arms; `tests/colourCarriersEngine.test.ts` pins
the emitted SQL per carrier kind with a recording stub, so the move is provably
behaviour-preserving without a database.

**Lesson** - **a write path guard and the rows it would have caught are two
different jobs, and the second one is only safe if it can prove a negative.**
The cheap version of this script is four lines and is wrong in the one case that
matters — a product code that reached a real order. The rule that made it safe
was not cleverness, it was refusing to answer from the schema (which knows
nothing) and answering from a count over every carrier instead, with the row's
own master entry as the single, named exclusion. **And a "reversible" operation
is only reversible if the reversal you printed actually runs** — that bug was
invisible in review and obvious the first time the script was executed.

**Ref** - 2026-08-13, this PR. Follows the guard in the entry below.

## Six source files were binary to git, so a production repair tool shipped with no reviewable diff [high]

**Symptom** — `gh pr diff 2082` showed `Binary files differ` for
`backend/scripts/merge-duplicate-fabric-colours.mjs`; the PR reported **0
additions** for it. That file is a 280-line tool that repoints fabric colours
across fifteen line tables and eight stock tables **on production**. It was
merged with nothing to read. `git grep` answers `Binary file matches` with no
content, so the file is also invisible to every audit that greps the tree — and
this repo audits by grep constantly (jsonb binds, swallowed reads, decision
params, company scope).

**Root cause** — a RAW NUL byte inside a template literal, used as a
composite-key separator:

```
const k = `${r.fabric_id}<NUL>${canonId(p)}`;      // the byte itself
const k = `${r.fabric_id}\0${canonId(p)}`;         // the escape — same value
```

NUL as a key separator is a fine technique. Writing it as the byte instead of
the two-character escape is what makes git classify the blob as binary. Both
spell the same string at runtime; only one is reviewable.

**Measured, not assumed.** Appending one line to the file gave
`git diff --numstat` → `-  -`. After the fix, the same appended line gave
`2  0`.

**The class was six files, not one.** Found by the gate written for the first
one, on its first run:

| file | NULs |
|---|---|
| `backend/scripts/merge-duplicate-fabric-colours.mjs` | 1 |
| `backend/scripts/probe-write-persistence.mjs` | 2 |
| `backend/scripts/seed-owner-fabric-catalogue.mjs` | 3 |
| `backend/src/scm/lib/size-variant-description.ts` | 1 |
| `frontend/src/pages/scm-v2/SalesOrderMaintenance.tsx` | 2 |
| `frontend/src/vendor/scm/lib/propose-days.ts` | 1 |

Every one is the same composite-key pattern, and three of them are live
application source, not scripts — a 76 KB sales-order maintenance page among
them, whose diffs nobody could read either.

**Fix** — all ten bytes replaced with `\0`. Both typechecks pass
(`npm run typecheck`, which in the frontend is `tsc -b`; `npx tsc --noEmit`
there resolves zero inputs and would have proved nothing).

**The check** — `backend/tests/noNulBytesInSource.test.mjs`, in
`npm run test:scale-contract`. It walks `git ls-files`, refuses to pass if the
listing returns implausibly few files, and fails on any tracked source file
carrying a NUL.

**Class** — *a defect that hides the evidence of itself*. The jsonb
double-encoding class corrupts data you can still query; this one removes the
diff, so review and audit both silently see nothing.

**The check caught itself first.** Its own `git ls-files -z` split was written
with the raw separator, so the very first CI run of the gate failed on the gate:
`backend/tests/noNulBytesInSource.test.mjs (first at byte 1943 of 2878)`. That is
the strongest evidence it works, and it is why the escape — not the byte — has
to be the habit: even the person writing the rule reached for the byte.

**Ref** - `fix/nul-byte-in-source`, 2026-08-14
## The description tidier called 249 of the owner's own fabric codes broken [medium]

**Symptom** — the 2026-08-14 production plan of `tidy-fabric-descriptions.mjs`
reported 78 Fabric Converter rows and 171 selling-library rows as
`code is not canonical (would be DE-01) — fix the CODE first`. Every one of them
is a code the owner dictated himself: `DE01`, `NX010`, `ZL-03`. Nothing was
written — those rows fail the canonicality guard and stop there, and the run
ended `WOULD REWRITE: 0` — so no data was harmed. The damage is to the report:
249 correct rows filed beside the real problems.

**Root cause** — the twelve series `seed-owner-fabric-catalogue.mjs` drove to
the owner's own list (2026-08-11) are a DECISION, not a derivation.
`normalize-fabric-codes.mjs` knew that and skipped them — using its own private
copy of the list, `const CATALOGUE_SERIES = new Set([...])` at line 81.
`tidy-fabric-descriptions.mjs` had no copy at all, so it applied the generic
series+number rule to codes the generic rule does not own.

Two scripts, one rule, one of them holding the only copy: the same shape as the
five fabric matchers that drifted apart before #1893 pulled them together.

**Fix** — `backend/scripts/lib/catalogue-series.mjs` holds the list once and
answers `isCatalogueSeries(parsedSeries)`. Both derivers import it. The tidier
now reports those rows in their own line — *the owner's own 12 catalogue
series, left exactly as he dictated* — instead of mixing them into the
unparseable bucket.

**The check** — `backend/tests/catalogueSeriesOneList.test.mjs`, wired into
`npm run test:scale-contract`. It fails on the tree as it was (2 of 5 tests),
and it asserts three things a comment cannot: both derivers import the shared
list; a series the SEED declares is one the shared list holds, so the seed
cannot add a series the derivers would then trample; and no other script holds
the whole list. That last one is measured rather than assumed — only the seed
and the shared module name all twelve, and the next highest file names 7, so
"names all twelve" separates a copy from a mention with room on both sides.

**Class** — *the same rule in two places*, docs/bug-classes.md. The instance
that hurts is not the one that disagrees loudly; it is the one where the second
place does not know the rule exists.

**Ref** - `fix/catalogue-series-one-list`, 2026-08-14

## The integration merge landed on red, and the migration it renumbered still called itself 0284 [medium]

**Symptom** — `main` was red immediately after PR #2121 (*Integrate the
2026-08-13 batch*, merged 13:06). Three failures, all from the same batch: two
migration files numbered `0284`, and two assertions still expecting the old
`findServiceLineCodes` return shape.

**Root cause (traced, not guessed)** — neither failure is a defect in isolation;
both are the shape of assembling thirteen branches against a moving `main` and
then not re-verifying. (1) `0284_scm_processing_date_one_name.sql` [renumbered] was written
on a branch while `main` took `0284` for
`0284_retire_consignment_proceeded_at.sql`; `backend/tests/migrationNumbers.test.ts`
is a ratchet — historical duplicates are frozen as accepted, a NEW one fails —
so it caught the collision and printed its own remedy. (2) the optional-param-noop
sweep changed `findServiceLineCodes` (`scm/lib/service-line-guard.ts`) to return
`{ ok, codes }`, where `ok: false` is **not** all-clear but "the catalog lookup
itself failed and the caller must refuse"; a sibling branch's new test, merged in
the same integration, still asserted the bare array. The PR states the process
cause plainly: *"I armed auto-merge and stopped watching. It merged on a state I
had verified BEFORE the last merge of main, not after."*

**Fix** — the file is renamed to `0286_scm_processing_date_one_name.sql` and its
`RAISE NOTICE` / `RAISE EXCEPTION` strings renumbered with it (9 lines);
`backend/src/scm/lib/optional-param-noop.test.ts` expects
`{ ok: true, codes: [...] }` on both cases. Two files, 11 lines. Verified on
origin/main: `0284` is the consignment retirement, `0285` is the AutoCount UDF
rename, `0286` is the Processing-Date rename.

**Read the rename rule before you repeat this, because the repo states it two
ways.** The PR quotes the test's own instruction — *"Rename ONLY (do not edit the
body): pg-migrate spots a rename by checksum"* — and then edits the body anyway,
arguing the migration had never run outside ephemeral CI databases so there is no
tracker row to orphan. `backend/scripts/pg-migrate.mjs` supports the premise: it
records filename **and** checksum, and detects a pure rename by identical
checksum (`RENAMED <from> -> <to>: identical checksum`); an edited body defeats
that detection and lands as `DRIFT … suspectedRenumberOf`, whose printed remedy
is a manual `UPDATE _pg_migrations SET filename = …, checksum = NULL`. So the
argument holds exactly as long as the file is genuinely unapplied, and nothing in
the PR proves that against a live catalog. Meanwhile
`scripts/lib/working-agreement.mjs:540`, added later, tells the next reader the
opposite: *"pg-migrate tracks by FULL FILENAME — renaming an applied file runs
its SQL a second time."* Two places in this repo now describe the same mechanism
differently; `pg-migrate.mjs` is the one that runs.

**The class, for next time** — verifying and then merging something else are two
different acts, and CI on a squashed integration branch is not CI on the tree
that lands. Running `node scripts/check-working-agreement.mjs --pr 2124` today
reports **two** violations on this PR: the missing ledger entry, and a missing
`Reversal:` / `Verified against:` pair for the migration it renumbered — rule 3
of the working agreement, which costs two lines in the body.

**Ref** — 2026-08-13, PR #2124 (`fix/main-red-after-integration`). Entry written
2026-08-14 from the merged diff, not from the PR description. Module guide:
`docs/modules/sales-order.md` owed two corrections this PR did not make — its
"since mig 0284 one NAME" line, which the renumber falsified, and a duplicated
self-contradicting paragraph beside it still naming the retired
`internal_expected_dd`, left there by #2121. **Both were fixed on 2026-08-14 by
the documentation audit, PR #2129**, before this ledger entry was written; the
guide now reads `0286` at `:484` and `docs/modules/purchase-order-amendment.md`
records the same renumber drift. Nothing further is owed there.

---

## The script written to undo a double-encoded jsonb re-encoded it, and only its own verification noticed [high]

**Symptom** — the apply run of `repair-array-shaped-variants.mjs` reported
success and damage on the same page:

```
array-shaped blocks remaining: 0 (was 7)
SO 9dc36f6f…: variants is string, fabricCode reads "(none)"
```

Seven production rows moved from one unreadable shape to another. No consumer
could read them before the run and none could after it.

**Root cause (traced, not guessed)** — the write was
`SET variants = $2::jsonb` with `JSON.stringify(obj)` bound. `postgres.js`
infers the bind type and sends the parameter **already typed jsonb**, so
`::jsonb` on it is a no-op: the serialized text is stored as a jsonb SCALAR
STRING instead of being parsed into an object. That is verbatim the failure
`docs/jsonb-double-encoding-coe.md` exists to record — *never let a serializer
near a jsonb parameter* — reproduced inside the repair written for it. The
second half is why it could have shipped silently: `arrayShapeCheck` asks only
`jsonb_typeof = 'array'`, so re-running it over seven fresh jsonb STRINGS
reports CLEAN.

**Fix** — `$2::text::jsonb`, and the `::text` is the whole point: it forces the
parameter to arrive as TEXT so the following `::jsonb` is a real PARSE. A local
`badShapeCheck` replaces `arrayShapeCheck` in this script and counts
`jsonb_typeof IN ('array','string')`; `unwrap()` accepts a jsonb string holding
an object as a first-class damage shape and recovers it with one parse; the
UPDATE's guard widens to the same pair.

**Where the fix actually landed** — PR #2118 was CLOSED, not merged: #2121
squash-merged its branch at 13:06. Verified by reading origin/main at
`de99056d5` rather than trusting the PR state —
`backend/scripts/repair-array-shaped-variants.mjs` carries `$2::text::jsonb`
(`:215`), the `IN ('array','string')` update guard (`:216`) and `badShapeCheck`
(`:45`). The apply that followed printed `variants is object, fabricCode reads
"HR805-40"` where the previous run had said `variants is string, fabricCode reads
"(none)"` while reporting the same 7 of 7.

**The class, for next time** — the check that caught this is the only reason it
is a two-hour bug instead of a permanent one, and it caught it for a specific
reason: **the verification asserted the SHAPE it had produced and re-read a key
out of it, rather than trusting the row count.** A repair that had verified "7 of
7 rows written" would have declared victory over seven rows it had just broken
differently. A verification that re-asserts the same predicate the UPDATE used is
not a verification.

**Ref** — 2026-08-13, PR #2118 (`fix/array-repair-double-encoded-again`), closed
as superseded; landed on `main` in #2121 (`d33ac7438`). Entry written 2026-08-14
from the diff and from origin/main. No module guide covers `backend/scripts/`.

---

## The array repair refused the only shape production actually had [medium]

**Symptom** — the plan run over the seven array-shaped `variants` blocks
recovered none of them. Every row was refused by `unwrap()`, which accepted only
a ONE-element array (`${arr.length} elements — only a one-element wrap is
recoverable`).

**Root cause (traced, not guessed)** — the recovery rule was written against a
hypothesis about the damage instead of a reading of it, and the hypothesis was
one element short. The real shape, from the plan run, is two elements: element 0
is the COMPLETE variants object, element 1 is the fragment that was being merged
in when the bad bind turned `variants || <string>` into an array rather than a
merge.

**Fix** — `asObject()` is factored out so an element is accepted whether it
arrived as an object or as a JSON string. A multi-element array is recovered from
element 0 **only when every key of every later element exists in element 0 with
an equal value**, compared by `JSON.stringify`; a tail that contradicts element 0
or adds a key it lacks is refused, and the difference is named per key rather
than reported as "not recoverable". The empty array gets its own message. The
reason the proof is there rather than a plain "take the first element": that,
applied blindly, is how a merge silently drops a seat height.

**What landed, against what the PR says** — the PR's results table lists three
verified cases (real prod shape recovers; a disagreeing tail `seatHeight` is
refused; a tail carrying a `legHeight` element 0 lacks is refused). Those were
run by hand. The merged diff is **one file, 45 additions and 10 deletions,
`backend/scripts/repair-array-shaped-variants.mjs`** — no test file. `unwrap()`
is a pure function with an exactly-testable contract and nothing in the tree
fails if it regresses.

**The class, for next time** — "take the first element" is a guess about which
side of a merge won, and the remedy here generalises: prove the discarded side is
redundant key by key, and name the disagreement instead of returning a verdict.
The same rule the sofa-PO entry at the top of this file states — *"the rows are
indistinguishable" is a claim about ONE side of a match* — arrived at
independently, two days later, in a different subsystem.

**Ref** — 2026-08-13, PR #2100 (`fix/array-repair-redundant-tail`). Entry written
2026-08-14 from the merged diff. No module guide covers `backend/scripts/`.

---

## The array repair died on the first arm with no item_code column [medium]

**Symptom** — the first production plan run of
`repair-array-shaped-variants.mjs` aborted whole, before printing anything about
any row.

**Root cause (traced, not guessed)** — the identity read was hard-coded
`SELECT i.id::text AS id, i.item_code, i.variants::text AS raw` and run once per
arm in the shared `ARMS` list. That list exists precisely because the colour
carriers are heterogeneous tables, and not all of them have that column —
`scm.inventory_movements` does not. One missing column takes the entire
diagnostic down, and a diagnostic that dies reads to whoever ran it as "the data
is broken".

**Fix** — the script asks `information_schema.columns` for schema `scm` once,
builds a table→columns map, and resolves the identity column per arm from
`['item_code','sku_code','product_code']`, degrading to `NULL AS item_code` when
an arm has none. Fifteen lines added, one changed.

**The class, and the check that should have caught it** — this is the class
already written down in this file on 2026-08-11, two days earlier, under *"Three
bugs in the AutoCount parity checkers, all in OUR queries, none in the data"*: a
diagnostic that dies on a schema fact it guessed is worse than no diagnostic. The
remedy recorded there is stronger than the one applied here — *"every one of
these checks now PRINTS the schema fact it depends on before using it"*. This
script now **asks** the catalog but still does not print which column it chose
per arm, so the next reader of its output cannot tell an arm with no identity
column from an arm with no damaged rows. The entry existed; it was not read
before working in a neighbouring script.

**Ref** — 2026-08-13, PR #2098 (`fix/array-repair-item-code`). Entry written
2026-08-14 from the merged diff. No module guide covers `backend/scripts/`.

---

## Seven sales-order lines have carried no variants at all since August, and nothing counted them [high]

**Symptom** — seven `scm.mfg_sales_order_items` rows whose `variants` is a jsonb
ARRAY instead of an object. Every consumer reads `variants->>'fabricCode'` out of
an array as NULL, so those lines have no fabric, no seat height and no leg. Not
the wrong values — **absent** ones, on lines that decide what gets built and what
it costs.

**Root cause (traced, not guessed)** — the damage itself is
`docs/jsonb-double-encoding-coe.md`'s: a pre-serialized string bound to a jsonb
parameter, three times on 2026-08-10, turning a `variants || <fragment>` merge
into an array. The part worth recording here is **why it survived a month
unnoticed**: nothing counted the shape. It surfaced only because every apply in
the fabric family ends with `arrayShapeCheck`, and three separate production runs
on 2026-08-13 each closed with `SO: 7 variants block(s) of ARRAY shape`. The
count not moving between those runs is what proves those runs did not cause it,
and every repoint in `backend/scripts/lib/fabric-write.mjs` carries
`AND jsonb_typeof(i.variants) = 'object'` in its WHERE, so none of them could
have touched an array-shaped row in the first place.

**Fix** — `backend/scripts/repair-array-shaped-variants.mjs` +
`.github/workflows/repair-array-shaped-variants.yml`. `mode=plan` is the default
and prints every row's actual content; `mode=apply` requires
`CONFIRM="I HAVE REVIEWED THE DRY-RUN"`, writes one row at a time and verifies on
a fresh connection that the recovered rows read back as objects with
`fabricCode` queryable again.

**What actually landed is not what the PR describes, and it took three more PRs
to work.** The PR's recoverable-shapes table lists `[ {...} ]` and `[ "{...}" ]`;
the production rows were neither — they are two-element arrays — so this version
recovered **zero of the seven** and #2100 had to widen it 92 minutes later. The
write it describes as *"the object is passed as TEXT and cast once with
`::jsonb`"* was in fact `$2::jsonb` with a JSON string bound, which is the
double-encoding again; #2118 fixed that after it had converted all seven rows to
jsonb strings on production. And the first plan run never reached a row at all
(#2098). The tool is right on `main` today; this PR alone was not.

**The class, for next time** — the detection was sound and the write-up was
written before the plan run that would have falsified it. `mode=plan` existed in
this very PR and prints exactly the shape that refutes its own recovery table.
When a repair ships with a dry-run, the dry-run's output belongs in the PR body
before the recovery rule is claimed to be complete.

**Ref** — 2026-08-13, PR #2096 (`fix/array-shaped-variants`). Entry written
2026-08-14 from the merged diff and from origin/main `de99056d5`. No module guide
covers `backend/scripts/`.

---

## A merge retired the colours and left the live lines pointing at them [high]

**Symptom** — live documents naming `scm.fabric_colours` rows that are already
`active = false` and appear in no picker. The census named one on production
before the repair existed: `BO315-2-FEATHER` — 3 `scm.mfg_sales_order_items`,
3 `scm.purchase_order_items`, 3 `scm.inventory_movements`, 3 `scm.inventory_lots`,
and 1 `scm.fabric_colours` row, already inactive.

**Root cause (traced, not guessed)** — a merge has two halves: retire the losing
colour, and repoint everything that names it. The 2026-08-11 normalisation did
the first against a sweep that knew FOUR document arms out of the fifteen a later
source audit found, so it superseded colours and left live documents pointing at
rows nothing offers any more. The reason nobody caught it is structural: a
duplicate DETECTOR can never report these, because a retired row is not a
duplicate — it is a merge that already happened.
`merge-duplicate-fabric-colours.mjs` excludes inactive rows by construction
(`const live = cols.filter((c) => c.active !== false)`), so it will never list
one. They have to be looked for from the other end — *which retired colours are
still NAMED* — and nothing asked that question.

**Fix** — `backend/scripts/repair-superseded-colour-refs.mjs` +
`.github/workflows/repair-superseded-colour-refs.yml`. The destination is READ
out of the loser's own label, verbatim (`[MERGED into BO315-02 on 2026-08-11 …]`,
and the `[superseded by X on …]` wording that also exists in prod); a row whose
label does not record what absorbed it is REFUSED and listed rather than sent
somewhere plausible, and the target must exist, be ACTIVE, and sit in the same
series. Stock moves in the same transaction as the documents because
`variant_key` materialises the colour into the physical bucket at post time and
is compared, never recomputed — repointing the lines alone is what leaves a sofa
unable to match its own on-hand. One transaction per colour, each ending in a
re-count that must reach zero or the transaction throws; a failure rolls back
that colour and the others stand; verification runs on a fresh connection.
Nothing is deleted and nothing is re-activated.

**The count this PR corrected, and where the wrong one still lives** — PR #2082,
merged the same morning, is titled *"Merge the 68 duplicate colours that sit
inside one series"*. This PR's body states that the detector producing that
figure did not exclude already-retired rows and that the live pair count is
**3** — the other 65 were already retired, and their stranded references were
invisible to both tools. The 68 is still on `main` in two places; see the #2082
entry below.

**The class, for next time** — when a cleanup has two halves, the tool that finds
work for the first half is structurally blind to the residue of the second. Ask
the question from the other end, and do it in the same pass — not because someone
noticed, but because the shape of the operation guarantees there is something to
find.

**Ref** — 2026-08-13, PR #2084 (`fix/superseded-colours-still-referenced`). Entry
written 2026-08-14 from the merged diff. No module guide covers
`backend/scripts/`, and none covers the fabric library at all.

---

## The writes the read-hardening audit left, and a schedule that reported success for a stop it never wrote [high]

**Symptom** — four of the five findings have no operator-visible symptom, which
is the point. A caller switched to one company could POST another company's
payment voucher (writing a journal entry against it), PATCH another company's GRN
header, and render another company's service case as a printable letterheaded
document holding nothing but `service_cases.read`. The fifth is visible:
scheduling a Sales Order straight from the Delivery Planning board returns
`WIRED` while writing no `trip_stops` row at all — the dispatcher sees success,
the driver's sheet stays empty, and lorry capacity counts nothing.

**Root cause (traced, not guessed)** — the 2026-08-10 audit scoped the READS. The
SCM supabase client is the SERVICE ROLE, so RLS is bypassed and an app-level
predicate is the only isolation there is; a scoped read does not gate an unscoped
write two PostgREST round trips later. `getAssrDetail`'s SQL is `WHERE c.id = ?`
with no company predicate at all, and `assr_print`'s GET had only
`requirePermission("service_cases.read")` — **a permission says what you may do,
never whose** — while the JSON detail route beside it already applied the guard.
Two further faults in the same pass:

1. **A dropped error where the absence authorises the write.**
   `postPaymentVoucherHandler`'s idempotency check destructured
   `const { data: existingRows }` and discarded the error. A failed read leaves
   `existingRows` undefined, `?? []` turns that into "no journal entry exists",
   and the handler posts a SECOND entry against the same voucher.
2. **A guard that can never fire.** In `scheduleOntoTrip` the stop insert is
   `if (!already && (doId || soId))`. On the SO-direct path `doId` is null (there
   is no DO) and `soId` is set to `null` six lines above, because
   `scm.mfg_sales_orders` has a TEXT `doc_no` primary key and no uuid while
   `trip_stops.so_id` is a uuid. Both operands are always null; the insert is
   unreachable; the function returned `WIRED` regardless.

**Fix** — `requireActiveCompanyId` + `scopeToCompanyId` on the payment-voucher
POST's voucher read, its `journal_entries` idempotency lookup and its POSTED
status flip; on the GRN PATCH's before-read **and** its UPDATE, with
`maybeSingle()` rather than `single()` so a zero-row match is the honest 404
instead of a 500; `allowedCompanyIds` on `assr_print` GET `/:id`, keeping the JSON
route's semantics deliberately (an UNRESOLVED scope skips the check, an EMPTY
scope 404s every company-stamped case — those two used to share `[]` and the
merged state failed open). The idempotency read's error now returns 500 with its
reason rather than reading as an absence.

**On the fifth finding, less landed than the framing suggests.** `stopCreated`
and `stopSkippedReason` were added to `TripWiring`'s WIRED arm — and **nothing
reads them**. `git grep stopCreated` at origin/main `de99056d5` returns six hits,
all inside `backend/src/scm/routes/delivery-planning.ts`: the type, the comment,
the assignment and the two response keys. No frontend, no test. The dispatcher
still sees a plain success. The orphan-TRIP half is untouched: a trip is still
found-or-created with no stop for it, and `/lorry-capacity` still counts it. That
defect was already on the record twice before this PR — in this file under the
stale-stop sweep entry (*"Deliberately NOT done — and this one is a second,
separate defect, now named"*) and in `docs/modules/delivery-tms.md` as *"Known
gap, inherited and documented (BUG-HISTORY 2026-07-22)"*. What this PR changed is
that the API stops asserting something false; the operator is still not told.

**The class, and the check that should have caught it** — the company-scoped
WRITE class, written up in this file as *"Every company-scoped WRITE in the system
was missing its company predicate"*. That entry's own Symptom paragraph names
these three by hand — *"Five instances were found and fixed by hand on 2026-08-13
(payment-vouchers POST, grns PATCH, assr_print GET)"* — so this defect is
referenced in the ledger without ever having been entered in it; this is the entry
it was pointing at. The existing check that should have caught the voucher is
`backend/tests/companyScopeHardening.test.ts`, cited as the precedent in
`docs/modules/payment-voucher.md`: it covers the CANCEL path (*"the cancel cannot
reverse another company's GL entry"*) and not the POST path 350 lines above it —
one of a pair was tested and the pair was called done, which is the same shape as
the reads/writes mistake one level up. The swallowed idempotency error belongs to
a different class and is in neither sweep: **a failed read must never read as an
absence when the absence is what authorises the write.**

**Ref** — 2026-08-13, PR #2086 (`fix/company-scope-writes-and-swallowed-errors`).
Entry written 2026-08-14 from the merged diff and from origin/main. Module guides
updated in the same commit as this entry: `docs/modules/payment-voucher.md`,
`docs/modules/grn.md`, `docs/modules/service-case.md`,
`docs/modules/delivery-tms.md`.

---

## Editing a fabric description saved, and reached no picker in the system [medium]

**Symptom** — owner, 2026-08-13: *"Description 好像是直接可以更改。如果可以更改的话，
到时候可以 save 得到吗？"* It saved. The Fabric Converter table showed the new text
at once; every fabric picker on every Sales Order kept the old one indefinitely,
and nothing reported a problem.

**Root cause (traced, not guessed)** — the description is the ONLY place a
colour's NAME is written: `colourLabelOf(code, description)` takes everything
after the code, which is how `PC151-01 SAND` comes to be called *SAND*. But the
name a salesperson reads when picking fabric comes from the MIRRORED row in
`scm.fabric_colours`, not from the `scm.fabric_trackings` cost ledger. That
mirror is written in exactly two places in
`backend/src/scm/routes/fabric-tracking.ts` — at create (`:133`) and at CSV
import (`:296`) — and never again: the description PATCH did not touch it, and
**both mirror upserts carry `ignoreDuplicates: true`**, so even re-running the
sync skips a colour that already exists. There was no path by which the edit
could ever have arrived.

**Fix** — the PATCH's `.select()` returns `fabric_code` alongside `id` (the row
has just been proven to be this company's, so no second read is needed) and
updates `scm.fabric_colours.label` in place through the SAME `colourLabelOf`, so
the two cannot derive different names, scoped to the company and to the
`colour_id` that IS this fabric's code. Best-effort and REPORTED, never fatal:
the cost ledger the operator was editing has already been written, so a library
hiccup must not turn a saved edit into an error. The response gains `pickerLabel`
(what the picker will now say) and, on failure only, `pickerWarning`.

**The class, for next time** — an edit that appears to work and reaches nobody is
worse than one that refuses, and a denormalised mirror with two write sites and
no equality assertion is the standing invitation. Nothing in the tree fails if
the ledger and the mirror diverge again; this fix does not add such a test, and
that gap is the residue. Also unfixed and named in the PR: the Series cell has
the same disease for a different reason — the picker groups by
`seriesOf(fabric_code)`, so editing the stored `series` column cannot move
anything, and no amount of syncing will fix it.

**Ref** — 2026-08-13, PR #2081 (`fix/fabric-description-reaches-picker`). Entry
written 2026-08-14 from the merged diff. **Module guide: none exists.** No file
under `docs/modules/` quotes `backend/src/scm/routes/fabric-tracking.ts`, and the
working-agreement checker's own path→module index maps it to no guide. Per
CLAUDE.md that is the gap to close rather than a licence; writing
`docs/modules/fabric-library.md` is outside a write-up PR and is named here so it
is not lost.

---

## A destructive production merge tool shipped as an unreviewable binary blob [medium]

**Symptom** — `gh pr diff 2082` renders the whole 280-line script as
`Binary files /dev/null and b/backend/scripts/merge-duplicate-fabric-colours.mjs
differ`, and the PR's file list reports **0 additions and 0 deletions** for it
against 86 for the workflow. `git grep` cannot read it either:
`git grep -n isCanonicalShape origin/main -- backend/scripts/` prints only
`Binary file … matches` — no line number, no content. A tool that repoints fabric
colours across 15 line tables, 8 `variant_key` stock tables, the stored
`description2` every PDF prints, the model colour whitelist and the cost row, on
production, went through review with no reviewable diff.

**Root cause (traced, not guessed)** — a raw NUL byte (`0x00`) sits inside a
template literal in the source, at byte offset 7202 of 15230:

```js
const k = `${r.fabric_id}\x00${canonId(p)}`;
```

— an actual NUL character in the file, not the two-character escape `\0` and not
`\\u0000`. Git classifies a blob as binary on finding a NUL in its scan window, so
every diff, grep and review surface downstream declines to show the file. No
`.gitattributes` entry is involved: `git show origin/main:.gitattributes` carries
one rule, `BUG-HISTORY.md merge=union`. At runtime the NUL is a legal string
character and the Map key works, so nothing failed, nothing warned, and the file
is invisible to every future `git grep` audit that sweeps for writers of
`scm.fabric_colours`.

**Fix** — none shipped, and recording that is the point of this entry. The
one-character remedy is to write the separator as the escape `\\u0000` (byte-identical
key, plain-ASCII source) or as any non-NUL separator.

**A second defect, still on `main` today: the number.** The script's header says
*"THE CASES, from a prod run on 2026-08-13 — 68 of them"*, and
`.github/workflows/merge-duplicate-fabric-colours.yml:3` repeats *"68 of them on
prod"*. PR #2084, merged 68 minutes later, states that the detector producing
that figure did not exclude already-retired rows and that the live pair count is
**3**. Both 68s are still there. CLAUDE.md is explicit — *a number in a comment is
a fact with an expiry date, and you own keeping it true* — and this one expired
inside the hour, in a header a future operator reads to decide whether to run a
destructive job.

**The class, for next time** — the stale-number rule has no automated check, and
`docs/bug-classes.md` does not exist in this repository, so the only enforcement
is reading. The binary half has no class entry at all: nothing in CI asserts that
a file under `backend/scripts/` is diffable text, which is exactly why a 280-line
production-mutating script could be merged unread. A one-line guard over
`git diff --numstat` (a source file reporting `-` for both counts is not text)
would have caught it at the PR.

**Ref** — 2026-08-13, PR #2082 (`feat/fabric-colour-dedupe-tool`). Entry written
2026-08-14 by reading the file's bytes on origin/main `de99056d5`, since the diff
does not show them. No module guide covers `backend/scripts/`.

---

## The confirm gate demanded a spec the customer had not chosen yet, so real orders could not be booked [high]

**Symptom** — a salesperson with a real customer and a real deposit could not
create the Sales Order. From 2026-08-08 the DRAFT→CONFIRMED gate demanded every
goods line's category-required variant axes — sofa Seat Height + Fabrics,
bedframe Divan/Leg/Gap/Fabrics — date or no date, in the server gate and three
client surfaces. Those are precisely the facts a customer comes back to give
later. On `/scm/sales-orders/new/from-products`, which has no variant editors by
design, the client silently downgraded the whole cart to a DRAFT instead, because
a direct-CONFIRMED create would have been refused outright.

**Root cause (traced, not guessed)** — a correct fix aimed at the wrong gate.
HC-SO-2607-008 (a bedframe line `Y103-(Q)` confirmed with no selections at all)
was answered by adding the axis check at CONFIRM. The owner narrowed it the same
week, 2026-08-13: *"只要是没有 proceed 这一张订单，其实都不一定是需要填写的，除非它是
proceed 了"* — an order that has not been PROCEEDED does not have to be
spec-complete; the moment it is proceeded, it does. Setting a Processing Date IS
proceed, and that rule already existed and was never in question
(`so-variant-check.ts`, gated through `shared/so-save-problems.ts`, together with
the colour-KIV rule of 2026-07-24 and the address/postcode/delivery-date
completeness the same date requires). So the 2026-08-08 change added no rule; it
moved an existing deadline earlier than the owner wanted, and left two gates
enforcing one rule.

**Fix** — the variant check is REMOVED from
`backend/src/scm/lib/so-confirm-gate.ts` entirely rather than softened to a
warning: `variants` is off `SoConfirmLineFacts`, off the row type, and out of the
`mfg_sales_order_items` SELECT, so the gate cannot read a variant even by
accident. `SalesOrderNew.tsx` goes from `if (!asDraft || processingDate)` to
`if (processingDate)`; `MobileNewSO.tsx` from `if (!asDraft && (procDate ||
!isEdit))` to `if (!asDraft && procDate)`; `SalesOrderNewFromProducts.tsx` drops
the `asDraft: needsCompletion || undefined` downgrade, which would now only
strand a real order in Draft for no reason. Confirm again means "this is a real
order for a real customer"; proceed means "this is buildable". The test file pins
the boundary from both directions, including `no problem this gate can raise is
ever about a variant`.

**Left behind, verified at origin/main `de99056d5`** —
`missingConfirmVariantAxes` (`backend/src/scm/shared/so-variant-rule.ts:127`) now
has **no production caller anywhere**. `git grep` finds it in its own definition,
two test files, one comment in `backend/scripts/check-so-noncatalog-lines.mjs`,
this ledger, and the stale guide row this commit fixes. It is a live export whose
confirm-vs-proceed distinction no longer decides anything, and it is still
maintained by `so-variant-rule.exemptions.test.ts`.

**The class, for next time** — two gates for one rule is how these drifted apart,
and the PR names that as the reason for deleting rather than relaxing. The check
that should have caught the 2026-08-08 change is the owner rule itself, which
lives in `docs/modules/sales-order.md` — and the guide was updated to MATCH the
new gate rather than to question it, so for five days the documentation
corroborated the bug. A module guide that is updated to agree with a change is
worth nothing as a check; it is worth something only when it is read BEFORE the
change, which is the order CLAUDE.md asks for.

**Ref** — 2026-08-13, PR #2072 (`fix/variant-exemption-required-itemcode`). Entry
written 2026-08-14 from the merged diff. Module guide: the Confirm-gate table in
`docs/modules/sales-order.md` carried a `variants_incomplete` row describing the
removed rule in full — the last non-test description of it in the repository —
for a day after the code stopped implementing it. **It was corrected on
2026-08-14 by the documentation audit, PR #2129**, which also recorded that
`missingConfirmVariantAxes` has zero production callers. Nothing further is owed
there; what this PR owed was that correction in its own diff.

---

## Documentation audit, 2026-08-13/14 — what the docs claimed and the code does not [high]

**Scope note.** This entry is a CORRECTION RECORD, not a bug fix. It is filed
here because the standing rule at the head of this file makes this file the
system's memory, and because two of the items below are LIVE, UNFIXED defects
found while testing doc claims against `origin/main` `0c2a4e88`. Nothing in the
accompanying change touches code — it is docs-only on purpose, so the diff is
reviewable as one thing.

**Symptom** - the owner, 2026-08-13: *"直接去查看源代码，不要再查看它的文档了，那些
文档已经很有问题了。"* Tested every load-bearing claim in the module docs, the
COEs, `README.md` and `CLAUDE.md` against the tree that ships today. Fourteen
claims were false in the present tense. Two of them describe behaviour that is
broken in production right now.

**Root cause** - three mechanisms, all mechanical, none of them carelessness:

1. **A hand-resolved 13-branch squash merge (#2121, `d33ac743`) kept the wrong
   side of several conflicts, in code AND in the doc, in one operation** — which
   is why the doc could not catch the code. `git log -S` on the exact strings
   names `d33ac743` as the commit that reintroduced them. It left
   `docs/modules/sales-order.md` carrying BOTH halves of an unresolved conflict,
   printed back to back: two contradictory definitions of the Processing-Date
   column in one paragraph, and a duplicated `elapses (so-field-policy).` line.
2. **A register written to survive a rename did not survive the rename it was
   written for.** `sales-order.md`'s "column registry" — authored in #2106 on a
   branch predating the rename branch — named the RETIRED column
   `internal_expected_dd` as *"the only storage this concept has. Use this one"*
   and closed with *"it is `internal_expected_dd`, full stop."* The same batch
   merged the migration that retired it.
3. **A doc that CACHED a production measurement as a durable sentence.**
   `docs/autocount-sync-coverage.md` warned *"Re-run the workflow before quoting
   these; they move with the data"* two lines above quoting them itself as
   settled state, in bold: toggle `off`, outbox *"zero rows of any status"*,
   *"No ERP document has ever reached AutoCount."* All three were falsified the
   next day by the two `skipped` rows recorded at the top of this file.

**Fix** - fourteen documents corrected, each with a dated correction block rather
than a silent edit, because the fact that the first version was believed is the
lesson. Full list in the PR body. The two LIVE defects found are recorded here so
they are not lost when the docs read clean:

**LIVE #1 — the Processing-Date rename is not finished, both proceed paths are
dead, and this is live in production.** Mig `0286` renamed
`scm.mfg_sales_orders.internal_expected_dd -> processing_date` and **applied on
prod at 2026-08-13T13:46:59Z** — Deploy run `31705868668`, `backend` job:
`APPLIED 0286_scm_processing_date_one_name.sql (6 statements)`. The old column is
gone. Six literals in `backend/src/scm/routes/mfg-sales-orders.ts` were left
behind by #2121's conflict resolution and no longer resolve:

| line | literal | effect |
|---|---|---|
| `:5922` | `.select('proceeded_at, internal_expected_dd, …')` | 42703 fails the whole query; the error is discarded, `curRow` is null, every gate below evaluates against nulls |
| `:5925` | row type declares the old name | agrees with the dead SELECT, so nothing type-complains |
| `:5938` | `stored: curRow?.internal_expected_dd` | always null |
| `:5958` | `patch.internal_expected_dd = resolved.date` | writes a column that does not exist |
| `:7187` | `effOf('internal_expected_dd')` | the camel→snake map at `:6715` is `['processingDate','processing_date']`, so the key cannot exist — `PATCH /:docNo` with `proceededAt` returns 422 `PROCEED_NEEDS_DATE` on an order that HAS a Processing Date |
| `:5059` | `body.internalExpectedDd` on create | no live client sends it — `SalesOrderNew.tsx:1646`, `MobileNewSO.tsx:1827/1898` and the create's own INSERT `:5254` all use `processingDate`. `autoProceed` is therefore always false: an order created WITH a Processing Date is created un-proceeded, the exact inverse of the owner's pinned rule *"只要有 Processing Date，就代表他 Proceed 了"* |

`backend/src/scm/shared/so-processing-date.ts` already exports
`SO_PROCESSING_DATE_COLUMN = 'processing_date'` and
`SO_HEADER_LEGACY_PAYLOAD_KEYS.internalExpectedDd -> 'processingDate'`. The fix
is to read those. **NOT FIXED — needs its own diff.**

**LIVE #2 — the delivery board's `job_date` field was deleted by the same merge,
and the doc still documents it.** `9fa8e0ff` added `job_date` so synthetic ASSR /
DP / project rows stop carrying their leg date in the SO's Processing-Date field.
`e1263558` (squashed into `d33ac743`) **removed every one of those lines** —
`git show e1263558 -- backend/src/scm/routes/delivery-planning.ts` deletes
`job_date: null`, `job_date: leg.date` (×2) and `job_date: date`. On `0c2a4e88`,
`grep -rn 'job_date' backend/src` returns one stale comment and no field;
`delivery-planning.ts:1169/:1333/:1470` still write `processing_date: leg.date`.
`docs/modules/delivery-tms.md` described the deleted version as shipped, and
`frontend/src/mobile/MobileDeliveryPlanning.tsx:177` and
`backend/src/scm/shared/so-processing-date.ts:28` still describe it as live.
**NOT FIXED — needs its own diff.**

**Lesson** - **a conflict resolution is a rewrite, and nothing re-derives the
invariant afterwards.** All three mechanisms above are the same shape: work that
was correct on its own branch, merged by hand against work that was also correct
on its own branch, wrong together, with no compiler and no test able to object
because every one of these bindings is a STRING — a PostgREST select list, a
`Record` key lookup, a doc table. The pattern that DOES work is already in this
repo and is proven: make the parameter required and let the compiler enumerate
the call sites. Six such parameters were swept and are required on `main` today.
A string literal has no such enumerator, which is exactly why
`so-processing-date.ts` exists — and why six sites that do not use it are the
finding.

**Also measured, and stated so it is not re-discovered:**
- `142` lines in this file carry the literal unsubstituted placeholder `#<PR>`
  in a Ref line, so those entries cannot be walked back to a commit
  mechanically. (`grep -c '#<PR>' BUG-HISTORY.md` on `0c2a4e88` = 142; it reads
  143 after this entry, which quotes the placeholder once as an example.)
- Measured on `0c2a4e88`, before this entry: 2.5 MB, 10,658 lines, 847 entries
  (134 `## ` + 713 `### `). This file's own instruction — *"read it before
  touching a subsystem"* — is no longer executable at that size.
- An independent coverage test on 2026-08-13 found ~15% of in-window `fix`
  commits have no entry here at all, concentrated in cutover / sofa-import /
  fabric-migration work. One of them, `70559354` (#1858), says sofa pillow stock
  *"was thrown away"* — a stock-loss incident with no entry in this log.

**Ref** - `docs/correct-lying-claims`, 2026-08-14. Audited against `origin/main`
`0c2a4e88`. No production database was queried; every figure here is from a
command run on that tree or from a cited commit message.

---
## BUG CLASS - writeback-reads-the-empty-column: the ERP holds it here, the sync reads there [high]

**The shape** — a fact the ERP holds in TWO columns. The UI reads both, so the
screen is right. The AutoCount write-back reads ONE, and it is the empty one.
Nothing on the AutoCount side opens the master, so it surfaces as a foreign key
error at send time — or not at all.

**Why it hides** — the failure is invisible from inside either system. The ERP
row is correct, the screen is correct, the account book simply never receives the
field. Three instances were each found only when a live document failed:
`FK_SODTL_Location` (2026-08-11, header `sales_location` vs per-line
`warehouse_id`), the sofa `supplier_sku` (2026-08-13, "what the supplier calls
it" borrowed as "what AutoCount calls it"), and `FK_SO_SalesAgent` (2026-08-13,
`agent` vs `salesperson_id`). Full incident:
`docs/autocount-writeback-golive-coe.md`.

**Three ways it lands**, decided by the C# and not by the ERP — `Str()` turns a
present-but-null key into `""`:
1. **FATAL-FK** — assigned unconditionally, `""` is not a row in the master
   table, `Save()` throws and the WHOLE document is lost.
2. **SILENT-DROP** — `udf()` drops the null and the UDF is never written. No
   error, no outbox row, no log line.
3. **SILENT-BLANK** — on `/edit` a present-null key OVERWRITES what the account
   book holds.
`Set()` swallows the assignment exception, not `Save()`'s, so wrapping a field in
it buys nothing here.

**The remedy** — do not read a column without asking what writes it. Where two
columns hold one fact, read the same fallback chain the UI reads, and let
`/ensure-masters` open what the book lacks instead of sending a null. The
underlying multiplier is `mapOrPassthrough` returning `null` for an unknown
value: measured against the live book, every target its four maps can emit is
already a real master there and every value they DROP is one the book already
holds — 37 of 37 agent names, 84 of 93 venues.

**Where the class was swept** (2026-08-14, every field on every operation) —
`docs/autocount-field-alignment-audit.md`: 8 more BROKEN fields and 6 AT RISK,
each with the chain (ERP column -> composer -> master opened? -> C# assignment ->
failure mode) and a fix. **Not fixed by that PR** — it changed no source; each
finding gets its entry here when its fix ships. The ERP-side counts come from
`backend/scripts/check-autocount-field-alignment.mjs` +
`.github/workflows/autocount-field-alignment.yml` (read-only, `workflow_dispatch`).

**Ref** — PR #2149, 2026-08-14. Instances already fixed: #2093 / #2095 / #2119
(supplier_sku), #2112 (location), the `salesperson_id` fix in flight.
## Proceed wrote a column migration 0286 had renamed away, and three write paths never asked the both-dates rule [high]

**Symptom** — two faults on the same rule, found together while auditing every
write path that can set or clear the Processing Date.

1. Moving an SO to IN_PRODUCTION could not write the date it was proceeding
   with. `PATCH /:docNo/status` SELECTed `internal_expected_dd`, compared it,
   and assigned `patch.internal_expected_dd` — a column that stopped existing
   when mig 0286 renamed it to `processing_date`. The header PATCH's proceed
   branch read the same dead name through `effOf('internal_expected_dd')`, which
   resolves `undefined` for every order, so that path returned
   `proceed_needs_processing_date` unconditionally. SIX literals in all, the
   sixth quieter than the rest: the create's auto-proceed read
   `body.internalExpectedDd`, a PAYLOAD key no client sends, so `autoProceed`
   was always false and an order created WITH a Processing Date was created
   UN-proceeded — the exact inverse of the owner's pinned rule, with nothing
   anywhere saying so. (The six were catalogued independently by #2149's
   documentation audit while this fix was being written; that audit's CORRECTION
   box is now the RESOLVED box in `docs/modules/sales-order.md`.)
2. Three write paths could store exactly one of the two dates: the CO header
   PATCH, the amendment APPROVE path, and the `/status` proceed. The owner's
   rule is *"processing date 和 delivery date 必须同时有或者同时没有"*.

**Root cause, traced not guessed** — the rule was never in one place. It was
hand-written in FIVE files (SO create, SO header PATCH, CO create, amendment
submit, and one direction inside `so-save-problems`) and absent from three. Five
copies is also why the two directions disagreed: `so-save-problems` asked
delivery→processing under `processing_delivery_must_pair`, while
processing→delivery lived in the completeness block behind
`if (facts.procDate && facts.completeness)` — and neither consignment path
passes `completeness`, so on a CO a Processing Date with no Delivery Date raised
nothing at all. `so-save-problems.ts` said as much in a comment ("the CO header
PATCH runs no pair check of its own") and the comment was correct.

The dead column is the same class one layer down. Mig 0286's own header warns
that `jsonb_populate_record` IGNORES a JSON key that is not a column, so a stale
caller "would not error — the date would just stop saving", and says "the
callers are renamed in this same commit". The `/status` block was not. Nothing
the compiler sees can catch a column name that lives inside a string, so it
built, typechecked and shipped. `routes/so-amendments.ts` had the matching
shape: it IMPORTED `canonicaliseSoHeaderChanges` and never called it, so its
approve-time gates read the raw stored jsonb while `so-revision.ts` (which
applies the change) reads the canonical one — an amendment stored under the
pre-rename payload key walked past the deposit, completeness and date gates and
was applied anyway.

**Fix** — one predicate, `soDatePairRefusal` in
`backend/src/scm/shared/so-processing-date.ts`, called by every path that can set
or clear either date: SO create, SO header PATCH, SO `/status` proceed, amendment
submit, amendment approve, CO create, CO header PATCH, the aggregated
`so-save-problems` report (both directions now), and `unify-processing-date.mjs`,
whose single-column UPDATE now re-asserts `customer_delivery_date IS NOT NULL`
and refuses the transaction rather than writing half a pair. Grandfathering — a
stored unpaired pair the save leaves untouched — moved INSIDE the predicate, so
no caller re-derives it. Clearing the Processing Date now clears the Delivery
Date with it (header and every `line_delivery_date`, via
`p_apply_delivery_date`); the reverse stays a refusal, because cascading it would
clear the Processing Date and become the road around
`scm.so.remove_processing_date`. The `/status` and header-PATCH reads are bound
to `SO_PROCESSING_DATE_COLUMN`; the two request-body reads go through a new
`readSoProcessingDateFromBody`, which takes the canonical `processingDate` and
still accepts the legacy spelling; and `so-amendments.ts` now actually calls the
canonicaliser it imported. The 2990 mirror is the ONE deliberate exclusion — it
replicates rows 2990 already committed, and a refusal there wedges its outbox
retrying forever — and the route now says so in a comment the test asserts.

**Why the test is a source scan.** `tests/soDatePairWiring.test.ts` anchors on
each path's source, with comments stripped, and fails if one stops calling the
predicate; it also fails on any live mention of `internal_expected_dd`. Eleven of
its fifteen assertions fail against the tree this PR branched from. A unit test
over the predicate would have passed throughout the entire bug: the logic was
never wrong, the enumeration was.

**Ref** — 2026-08-14, this PR. Related: **BUG CLASS optional-param-noop** below
(same shape, different mechanism: there the compiler was silenced by `?`, here by
the value being a string).
## Seven high-severity findings from the 2026-08-12 whole-system review, still live on main [high]

Landed together because they came from one pass and no other open PR claimed
them. Three of the fixes are EXTRACTIONS rather than in-place edits, because the
repo's file-size ratchet holds `mfg-sales-orders.ts`, `routes/assr.ts` and
`DataGrid.tsx` to "may only shrink" and it was right to: the SO status-transition
table and the discard guards now live in `scm/lib/so-lifecycle-guards.ts` (they
were being reasoned about apart, which is how the ON_HOLD edge and the DRAFT-only
delete became a way to destroy a delivered order); case visibility + the creditor
strip live in `services/assrVisibility.ts` (a `services/` module is the only
place BOTH the JSON route and the print route can import from); and the DataGrid
layout overlay is materialised in `dataGridLayoutStorage.ts`, next to the shape
it edits. The review was 19 parallel deep reads with an adversarial refutation round
(42 high-severity candidates, 37 confirmed); these are the confirmed ones that
were still true of `origin/main@4851a9ec7` when re-read against the SOURCE on
2026-08-14, and that PRs #2140 / #2127 do not touch. Each was verified by
reading the current code, not by trusting the review's own write-up.

### The P&L drill-down did not apply the filters its own total applies [high]

- **Symptom.** Open the cross-module P&L, click a cost bucket, and the row list
  cannot be made to add up to the number you clicked.
- **Root cause.** `bucketDrilldown`'s project-cost and service-cost queries were
  hand-written second copies of `rawProjectCost` / `rawServiceCost`, and the
  copies carried neither the `company_id` predicate nor the `projects.archived_at
  IS NULL` join. The two sales/PO queries in the same function DID carry the
  company filter, which is what made it look deliberate. So the total was Houzs
  and the list was Houzs + 2990 + the archived FAIR PNL seeds (RM 6,290,856 of
  archived project cost, measured 2026-07-29).
- **Fix.** One `FROM … WHERE` fragment per source (`projectCostFrom`,
  `serviceCostFrom`) with one bind builder, interpolated by BOTH the total and
  the drill-down. A filter added in future cannot reach one and miss the other.
  `backend/tests/reviewHighFindings.test.ts` asserts the two predicates are the
  same text.
- **Ref** — this PR, 2026-08-14. `backend/src/routes/finance.ts`.

### A POS tablet could shed `origin='pos'` in one request [high]

- **Symptom.** None visible — that is the problem. The SO pricing envelope
  refuses a POS-side edit that drops the bill below the order's own total; a
  tablet could walk past it.
- **Root cause.** `POST /api/pos/exchange-web-session` minted a NEW session for
  the same user and deliberately dropped the origin marker, and the comment said
  so ("so the drift gate treats this like an ordinary desktop session"). But
  `origin='pos'` is the whole hinge `isPosTabletCaller` reads, so the four drift
  refusals plus `trustOperatorSelling` and `posTablet` were all gated on a flag
  the caller could discard by asking for a second token.
- **Fix.** The exchange CARRIES the caller's origin. An exchange must never widen
  the session it was exchanged from. Office sessions have no origin to carry and
  are unaffected, so the SSO handoff still works.
- **Ref** — this PR, 2026-08-14. `backend/src/routes/pos.ts`.

### Any sales user could free another rep's held PWP vouchers [high]

- **Symptom.** A rep's RESERVED promo codes disappear from their cart with no
  error anywhere.
- **Root cause.** `DELETE /scm/pwp-codes/reserve` took the client-supplied
  `cart_line_key` as its whole authority. Company scope had been added; owner
  scope had not. Every other writer in that file — the reserve insert, the
  surplus trim, the stray trim, all three reads — pairs company with
  `owner_staff_id`; this one verb did not, and it answers `{ok:true}` whether it
  matched your row, someone else's, or nothing.
- **Fix.** `.eq('owner_staff_id', userId)`, resolved the same way the POST path
  resolves it. An unlinked staff account frees nothing rather than everything.
- **Ref** — this PR, 2026-08-14. `backend/src/scm/routes/pwp-codes.ts`.

### The printable service case ignored the row-level rule the JSON one enforces [high]

- **Symptom.** A visibility-scoped salesperson could render ANY service case in
  their company as a letterheaded document by walking the id — and see the
  supplier identity the JSON route withholds from them.
- **Root cause.** `GET /api/assr-print/:id` had the COMPANY check and stopped
  there. The row-level scope (self + downline + legacy agent-name reach) and
  `stripCreditorFields` lived inline inside `GET /api/assr/:id` and had no second
  caller. Two routes emit the same content; the rule was on one of them.
- **Fix.** The rule is now `assrCaseRowInScope` / `assrCallerIsScoped` in
  `routes/assr.ts`, called by both. Nick 2026-07-15 「这个我要 office, supplier
  看到而已」 is applied to the office print variant too.
- **Ref** — this PR, 2026-08-14. `backend/src/routes/assr_print.ts`, `assr.ts`.

### A voided service case kept aging, kept breaching, and kept emailing people [high]

- **Symptom.** Staff receive SLA escalation mail about cases somebody closed
  precisely so they would stop mattering; backlog and aging tiles count them.
- **Root cause.** There are TWO terminal stages, `completed` and `voided` — both
  stamp `closed_at`, both render as "Closed" — and roughly thirty hand-written
  copies of `stage != 'completed'` named only one. The daily cron then stamped
  `escalated_at`, wrote an activity row and mailed the assignee plus every
  `service_cases.manage` holder. The escalation query also never checked
  `archived_at`.
- **Fix.** `backend/src/services/assrStages.ts` — one `assrOpenStageSql(alias)`,
  applied to all 24 open-case predicates and the three `is_breached` CASE arms.
  The CLOSED side (`stage = 'completed'`, which drives resolved counts and
  average resolution time) is deliberately NOT collapsed: a voided case was not
  resolved. `archived_at IS NULL` added to the escalation candidates.
- **Ref** — this PR, 2026-08-14. `assrStages.ts`, `assrEscalation.ts`,
  `services/assr.ts`, `routes/assr.ts`.

### ON_HOLD was a laundry that turned a delivered order into a deletable draft [high]

- **Symptom.** A DELIVERED or INVOICED sales order can be hard-deleted, taking
  its payment ledger and its entire audit log with it, and leaving the DO and the
  invoice pointing at nothing.
- **Root cause.** Two independent halves. (1) `soStatusTransitionError` returned
  `null` unconditionally on BOTH ON_HOLD edges, so `DELIVERED>DRAFT` — which the
  rank table and `SO_LEGAL_REGRESSIONS` both refuse — was legal in two PATCHes:
  `DELIVERED>ON_HOLD` passes on `to`, `ON_HOLD>DRAFT` passes on `from`. (2)
  `DELETE /:docNo` authorised on `status === 'DRAFT'` alone; its own header
  comment stated the assumption ("a DRAFT has no DO/SI"). The cascade takes
  `mfg_sales_order_items`, `_payments`, `mfg_so_price_overrides`,
  `mfg_so_status_changes` and `mfg_so_audit_log`; `delivery_orders.so_doc_no` and
  `sales_invoices.so_doc_no` are ON DELETE SET NULL.
- **Fix.** Both halves. `ON_HOLD>DRAFT` is refused (every other resume target is
  untouched — nothing legitimately resumes into "not yet written"), and DELETE
  now consults `soHasDownstream` — the same lock CANCELLED already uses — and
  refuses when a payment row exists, failing CLOSED if the ledger cannot be read.
- **Ref** — this PR, 2026-08-14. `backend/src/scm/routes/mfg-sales-orders.ts`.

### Every AutoCount sales-order pull has failed since the Postgres cutover [high]

- **Symptom.** The `sales_orders` mirror has taken nothing, and
  `pull_checkpoint` refetches the same window forever. Invisible: the per-row
  failure is caught and counted, and `runPull` only advances the checkpoint when
  `failed === 0`.
- **Root cause.** `upsertSalesOrder` named SEVEN columns `public.sales_orders`
  has never had — `transfer_to`, `note`, `inv_addr1..4`, `sync_error` — carried
  over verbatim from the D1 schema at the cutover. Postgres answers 42703 and
  refuses the statement. `company_id` (NOT NULL, no default, mig 0083) was never
  written either, so a fixed statement would have hit 23502 on the first new doc.
- **Fix.** The seven phantom columns removed from both the INSERT and the ON
  CONFLICT branch; `company_id` resolved in SQL from the companies master exactly
  as 0083's own backfill did. `SALES_ORDERS_MIRROR_COLUMNS` is exported and the
  test holds the statement to it, because these seven survived every review of
  this file for the whole life of the cutover.
- **Ref** — this PR, 2026-08-14. `backend/src/services/pull.ts`.

### Three front-end findings from the same review [high]

- **A blank signature was stored on every mobile POD.** `MobilePOD` gated the
  payload on `canvas.toDataURL()`, which returns a valid non-empty PNG for an
  untouched, transparent canvas — so `sig` was truthy on every confirm and every
  delivery filed a blank image into `delivery_orders.signature_data`. Worse than
  storing nothing: a blank PNG is indistinguishable from a real POD that failed
  to render, and it is the only customer-side evidence the DO carries. Now gated
  on `hasSignature`, which the pad sets on the first pointerdown. `podKey` and
  `gps` in the same object literal were already gated on real capture.
- **Mobile offered the convert "+" to view-only PO / GRN users.** `MobileApp`
  gated the DO and SI convert targets and fell through to a literal `: true` for
  the other two. `MobileConvertWizard` imports no auth of its own, so nothing
  downstream stopped them; the 403 arrived after the whole wizard was filled in.
  New `canOperatePurchaseOrders` / `canOperateGoodsReceipts` mirror the backend
  area guard, and the chain has no default arm, so a new target that forgets its
  gate will not typecheck.
- **"Show <column>" did nothing on a never-adjusted grid.** `effectiveHidden`
  overlays `defaultHidden` when `order` and `hidden` are both empty, so a mutator
  that writes those fields without materialising the overlay first is writing
  against a layout that does not exist. `showColumn` filtered an empty array;
  `hideColumn` pushed one key and silently un-hid every other default-hidden
  column; `pinLeft` un-hid all of them. One `materialize` helper now writes BOTH
  fields, and all four mutators start from it (`toggleColumn` was half-right and
  is now whole).
- **Ref** — this PR, 2026-08-14. `MobilePOD.tsx`, `MobileApp.tsx`,
  `salesAccess.ts`, `DataGrid.tsx`.

### A finance write reached the other company for every non-scope-to-PIC caller [high]

- **Symptom.** None on screen. `PATCH /projects/:id/finance` updated — or
  CREATED — the other company's `project_finance` snapshot and then ran
  `recomputeAutoCostLines` over their project.
- **Root cause.** The `activeCompanySql` predicate sat INSIDE the
  `isScopedProjectUser` branch, and the comment above it recorded the rest as
  "deferred, tracked separately". In practice that meant no company predicate was
  evaluated anywhere on the path for the majority of `projects.write` holders.
- **Fix.** The project is resolved in the active company FIRST, for every caller,
  and the PIC rule is applied to the row that load returned. Out of company reads
  as "Not found", the same answer as a nonexistent id.
- **Ref** — this PR, 2026-08-14. `backend/src/routes/projects.ts`.
## The sharded-script guard names a script, so it fails on the next rename — third time in one day [medium]

**Symptom** - `npm run test:scale-contract` red on a branch whose only crime was
adding `--coverage` to the script CI shards. `pretest` gates `npm test`, and
`deploy.yml` runs `npm test -- --shard=...`, so a false failure here blocks the
backend deploy.

**Root cause (traced, not guessed)** - the guard exists to stop an `&&` chain
swallowing `--shard` (npm appends run args to the LAST command). It expressed
that by naming the script: first `assert.equal(pkg.scripts.test, "vitest run")`,
then — after #2131 split the suite and #2146 repaired the guard — `assert.equal(
pkg.scripts["test:workers"], "vitest run")`. Both are literals about a CARRIER
that keeps moving. Every rename that satisfied the rule perfectly was reported
as a violation: `test` -> `test:workers` (#2146), `test:workers` ->
`test:coverage:workers` (the coverage ratchet). Three false failures in one day,
each one able to block a deploy.

**Fix** - read the script name OUT of `ci.yml`'s shard line and assert THAT
script contains no `&&`. The invariant is now stated once, about whichever
carrier ci.yml actually uses, and the next rename needs no edit. Mutation-
verified: pointing ci.yml at `test` (the `&&` chain) fails with the offending
script printed; restoring it passes 83/83.

**Lesson** - a guard that pins a literal fails on the improvement it exists to
encourage. Derive the literal from the file you are guarding, and assert the
property. #2146 fixed the instance an hour earlier and the same shape came back
on the next PR — which is the definition of not having fixed the class.

**Ref** - 2026-08-14, alongside the coverage ratchet.

## The sofa purchase orders were never dedicated, and the delivery dates were lost to a renamed key [high]

**Symptom** — 274 of 714 processed bedframe/sofa sales-order lines (38%) have no
dedicated purchase order. Measured live on 2026-08-10 rather than taken on
trust: **400 of 975** `scm.purchase_order_items` rows carry `so_item_id IS
NULL`, of which the existing three-tier backfill can stamp **zero** (Tier 1/2/3
all 0; 392 have no delivered chain and no usable note). Separately **110** of
the 864 migrated PO lines and **48** headers show a blank EXPECTED DELIVERY
although AutoCount has a date on every line, and `backfill-po-expected-at.mjs`
cannot rescue them — its own production dry-run says so in one line: `can be
filled from their own lines: 0; still blank because no LINE carries a date
either: 48`. It derives the header from the LINES, and the lines are the thing
that is null.

**Root cause, traced not guessed** — three faults on the same rows, and the
first theory was REFUTED before any of them was found. It is NOT that the sofa
compartment decoder fails: 184 sofa PO-to-SO pairs share the same AutoCount
ItemCode 184/184 and the same `Desc2` 182/184, and decoding all 126 sofa lines
gives ZERO cases of "the PO fails where the SO succeeds".

1. **`import-ac-outstanding-po.mjs`'s INSERT column list has no `so_item_id`.**
   Not a broken lookup — no column. `grep so_item_id|FromSODtlKey` in that file
   returned nothing. The script that DOES dedicate,
   `import-ac-so-linked-pos.mjs`, then skips a document whole when it already
   exists ("PO docs in file: 366; already in ERP: 267"), so it never went back
   for the 267 the first importer had created. In the whole log of run
   31359369768 the string `009830` appears zero times.
2. **A renamed export key.** The same importer read `l.DelivDate` at three
   sites. The snapshot was re-cut in `a5f51653` (PR #1779) with the key
   `DeliveryDate`: 0 of 338 rows carry `DelivDate`, 338 of 338 carry
   `DeliveryDate`. Reading an absent key is `undefined` in JavaScript, not an
   error, so every line imported blank and nothing anywhere said so.
3. **The line key was computed and thrown away.** `import-ac-so-linked-pos.mjs`
   builds `dtlKey: Number(l.DtlKey)` at three sites; its INSERT has 21 columns
   and none of them is it. `PODTL.DtlKey` is the PRIMARY KEY of AutoCount's PO
   detail table and all 738 keys in the committed snapshots still resolve in the
   live AED_HOUZS book (checked read-only over ODBC), so a durable handle was
   discarded and every later repair has had to re-derive the link by matching.

Both hops work when you walk them. For `HC-PO-009830`:
`soLineByDtl.get("773519")` -> `SO-011207` / `HOK-5530 SOFA`, and
`SOFA_MODEL_ALIAS` 5530->9028 decodes the same `Desc2` to `9028-2A(LHF)` +
`9028-L(RHF)` — exactly the two rows already on that ERP purchase order.

**Fix** — one repair over the same rows, `repair-migrated-po-lines.mjs` +
`.github/workflows/repair-migrated-po-lines.yml`, DRY-RUN by default: it stamps
`so_item_id`, `delivery_date` and `linked_ac_dtlkey` per line and then the
header's `expected_at`, every UPDATE re-asserting the column is still NULL so a
re-run plans nothing. Both importers are fixed too, not only the data: the
date is read through `scripts/lib/ac-po-line.mjs`, the dedication through the
SHARED `scripts/lib/so-line-dedication.mjs` (the taker was extracted from the
one script that had it right), and both now write `linked_ac_dtlkey`
— **#1819's `0273` already added exactly that column**, so this PR adds no
migration of its own; a second column would have been the real mistake.
Recovering which ERP row descends from which AutoCount line lives in `scripts/lib/ac-po-line-match.mjs`
and refuses rather than guesses: a group whose two sides do not split the same
way is refused whole, and so is one whose AutoCount lines disagree on anything
the repair would write.

**The zip's premise was FALSE, and review caught it before it wrote anything.**
The first version of this fix zipped "indistinguishable" rows in `DtlKey` order,
justified as *"identical on every field the ERP stores... any bijection is the
same set of facts."* That is true of the ERP rows and false of the AutoCount
lines, which is the side every written value is read from. Measured against the
committed snapshots: **all 5 surviving buckets (10 AutoCount lines) carry
DIFFERENT `FromSODtlKey`s** — `PO-000290` 60700/60702, `PO-009024`
829179/829180, `PO-009596` 871212/871213, `PO-009746` 796552/796553, `PO-009767`
887681/887682. Delivery dates agree in all 5, so `delivery_date` was never at
risk; `so_item_id` and `linked_ac_dtlkey` were a coin flip on 12 rows. Worse,
`PO-000290`'s two keys resolve to two different PRODUCTS on one order (60700 ->
`SO-000870` "MYLATEX LUMBARIA (K)", 60702 -> `SO-000870` "NB-KHJ57(K)"). The fix
refuses any bucket whose AutoCount lines disagree on `FromSODtlKey` or
`DeliveryDate` and prints both candidates; on today's data that repairs 0 of
those 12 rows.

**The class** — *"the rows are indistinguishable" is a claim about ONE side of a
match, and the side you are copying FROM is the one that has to be checked.*
Two corollaries were fixed in the same pass. The `base` fallback could bind a PO
line for product A to an SO line for product B, defended by a comment claiming
the importer makes the same attempt — it does not: `import-ac-so-linked-pos.mjs`
uses `base` only and never the PO row's own code. (Re-measured on the snapshots
2026-08-11: exactly **1** of 579 resolvable lines is cross-product —
`PO-000290` DtlKey 61216 `NB-KHJ57(K)` -> ERP `CODY-(K)`, pointed by
`FromSODtlKey` at `SO-000870` "MYLATEX LUMBARIA (K)" -> ERP
`LUMBARIA MATT (K)`. So the guard costs one link today and that link would have
been the only wrong write.) That decision is no longer inline prose in the
script: it is `dedicationCandidates()` in `scripts/lib/so-line-dedication.mjs`,
one implementation with its own tests, so the rule and the comment defending it
cannot drift apart again. And the zip's tie-break sorted a serial `id` with
`localeCompare`, so ids `[9,10,11,12]` order as `[10,11,12,9]` and split a
sofa's compartment rows across different AutoCount lines; it sorts numerically
now.

**Guards, each proven by breaking it** (`tests/acPoLineRepair.test.mjs`, 24
tests, all passing): disable the coin-flip refusal -> **3 fail** (18/21 before
the cross-product tests were added); drop the `sameProduct` gate so `base` is a
blanket attempt again -> **1 fails** (23/24); restore the `localeCompare` row
sort -> **1 fails**; point the date accessor back at the old `DelivDate` key ->
**3 fail**. A test that does not fail without its fix proves nothing, so each
was run both ways rather than asserted.

Two smaller faults from the same review: `i.cancelled = false` (three queries)
silently dropped NULL-cancelled SO lines out of a **claim-once** pool, which
both under-repairs and can hand a different line to the next PO row — this repo
reads the column as nullable everywhere else, `check-po-so-links.mjs` (the
checker for this exact link) included, so all three now use
`COALESCE(cancelled, false) = false`. And the APPLY log reported `plan.length`
as the RESULT; it now prints the three affected-row counts the database returns.

**The class, for next time** — *a field you read by name from a file you did not
write is a silent dependency, and JavaScript will not tell you when it breaks.*
Reading a renamed key produced `undefined`, which flowed all the way into a
`NULL` column with no error, no warning and no failing test — the same shape as
the five-copies-of-findColour entry above, one layer earlier. The guard is
`tests/acPoLineRepair.test.mjs`, which asserts the accessor still resolves on
every row of the COMMITTED snapshots (917 rows). A fixture would never have
caught this, because a fixture carries whatever key the test author typed;
revert the accessor to `DelivDate` and that test fails 338 + 579 times. The
second half of the class: *a column missing from an INSERT is invisible to
every reader* — nothing downstream can distinguish "never written" from
"genuinely absent", which is why the second importer's skip-if-exists looked
correct while it was silently the reason nothing ever went back.

**The production DRY-RUN, MEASURED after all the review fixes** — 2026-08-11,
read-only, `APPLY` hardcoded to `0`
([run 31457184673](https://github.com/hello-houzs/Houzs-ERP/actions/runs/31457184673)):

```
migrated purchase orders: 449; their lines: 864
  lines missing so_item_id 374; missing delivery_date 110; missing linked_ac_dtlkey 589
matched: sole 657; split by (qty, Desc2) 127; indistinguishable, zipped in DtlKey order 0
PLAN: 551 line(s) to update - so_item_id 95; delivery_date 83; linked_ac_dtlkey 509
       new dedications by item group: sofa 62; accessory 27; bedframe 6
       45 header(s) to give an expected_at; 17 of them are in the PAST
REFUSED groups: 6      NOT REPAIRED - every line, with its reason: 302
```

Every one of the 551 is printed individually, and the printed list tallies to
exactly `95 / 83 / 509` — the plan is built ONCE and both the log and the writer
consume that same array, so the dry-run cannot claim one thing and write
another. **`indistinguishable, zipped in DtlKey order 0`** is the coin-flip
refusal working: all 5 buckets are refused, plus `HC-PO-009620`.

The earlier `796 / 87 / 99 / 46` were the PRE-FIX figures and, as predicted,
every one moved DOWN. The line-key drop is the largest and is NOT this PR's
doing: 275 of the 864 were keyed by another script the day before (below).

**Dispatching it did not require merging.** A `workflow_dispatch` is resolved to
a workflow by its PATH on the default branch but RUNS the file content at the
requested ref. So the dry-run was dispatched at a throwaway ref that borrowed the
path of `po-so-links-check.yml` — an on-main, no-input, read-only check in the
same PO<->SO domain — whose content at that ref ran this repair with `APPLY`
hardcoded to the literal `"0"` and no input able to override it. The ref was
deleted as soon as the run was read. `repair-migrated-po-lines.yml` itself still
cannot be dispatched until it is on `main`, which remains true and is why the
technique was needed:

```
$ gh workflow run repair-migrated-po-lines.yml --ref fix/po-dedication-and-dates -f target=prod -f apply=0
HTTP 404: workflow repair-migrated-po-lines.yml not found on the default branch
```

**FIVE WRONG LINE KEYS ARE LIVE IN PRODUCTION RIGHT NOW, and they are not this
PR's.** On 2026-08-10 `backfill-ac-line-keys.mjs` ran in APPLY mode against
production (run 31416597720) and wrote 275 purchase-order `linked_ac_dtlkey`
values by a weaker rule: a match on (DocNo, ERP item code) zipped by a `line_no`
it selected as `NULL::int`, so the sort was a no-op and the pairing was whatever
order postgres returned. This repair's `IS NULL` guard skips those 275 — correct,
it must never overwrite a value it did not write — but it now AUDITS them:
**270 agree, 5 DISAGREE.** All 5 are permutations within a document, and the
evidence is the ERP row's own `Desc2`, copied verbatim by the import, matching
the DERIVED line's `Desc2` exactly:

| PO | row | stored | derived | evidence |
|---|---|---|---|---|
| HC-PO-009770 | HAPPI SLEEP SOLITUDE MATT (Q) x3 | 889395/889396/889397 | 889397/889395/889396 | `Desc2` names three different roadshow venues; each row's text matches its DERIVED line |
| HC-PO-009722 | CODY-(Q) x2 | 884635 / 884637 | 884637 / 884635 | `M'GP:10"` vs `M'GP:14"` — swapped; and the two lines carry DIFFERENT `FromSODtlKey` (884180 / 778589) |

A wrong `DtlKey` is not a cosmetic difference: migration 0273's own header says
`AcSyncService` dereferences it on the edit path, and a wrong one makes it
**APPEND** a line to the live account book instead of editing the one the
operator changed. **This repair neither writes nor reverts them** — nothing is
ever deleted here — it reports them for an owner ruling.

**The "589 are decomposed sofa compartments" hypothesis is REFUTED as the
explanation**, though the mechanism is real. That run's `no AC match 589` is
re-derived here as exactly **589** against the same two files and the same
mapping CSV, then given a reason each:

```
464 x the AutoCount document is only in ac-so-linked-pos.json.gz, which the
      code match never opens (it reads ac-outstanding-po.json.gz alone)
 65 x the ERP row is a COMPARTMENT of a decomposed line
 46 x the AutoCount document is in NEITHER committed PO export
 11 x the AutoCount ItemCode has no row in autocount-erp-mapping-1561.csv
  3 x document and item are both mapped, but no line maps to this material_code
by item_group: bedframe 315; sofa 215; accessory 26; mattress 22; others 11
DECOMPOSED COMPARTMENT? asked of every row: yes 173; no 336; unanswerable 80
```

**79% of the gap has nothing to do with item codes.** The dominant cause is
file scope: that script opens ONE of the two committed PO exports, so 464 lines
were invisible to it whatever their SKU — a plain mattress line on such a
document fails identically. The largest `item_group` is **bedframe (315)**, not
sofa, and **0** bedframe rows are compartments. The compartment mechanism is
real and accounts for **173** rows (all sofa — 173 of the 215 sofa lines), which
is 29% of the 589, not the explanation for it.

Note the two compartment numbers differ on purpose: the reason list says 65
because `codeMatchGapReason()` returns the FIRST cause that applies and the
document-level causes are tested first — correctly, since an unopened document
fails whatever the code is. Read as the answer, 65 would understate; the census
therefore asks `isCompartmentSku` of every row independently, and keeps
"unanswerable" (80 rows this repair cannot reach either) distinct from "no",
because an unreachable row is not evidence in either direction.

This repair reaches **509 of the 589** the code match could not.

**Ref** — 2026-08-10 / re-verified 2026-08-11, PR #1905
(fix/po-dedication-and-dates).

## The repository had no linter at all, and 514 `eslint-disable` comments addressed to one that was never there [high]

**Symptom** — not a single incident; a whole family of them. Eleven entries in
this file are defects a type-aware linter reports for free: a floating promise
that leaked a timer and skipped a production frontend release, an `as never`
that silenced a real type error, a condition that could never be false because
the value was already non-nullable. Each was found by a person, after it shipped.

**Root cause** — `git ls-tree origin/main | grep -cE "eslint\\.config|\\.eslintrc"`
returned **0**. There was no ESLint configuration anywhere in the repo, in
either app. Meanwhile `git grep -c eslint-disable` over `backend/src` and
`frontend/src` returns **514 comments across 159 files** — written over months,
addressed to a linter that has never run. They were pure decoration, and worse
than nothing: they read as evidence that a check exists.

**Fix** — type-aware ESLint 9 in both apps (`backend/eslint.config.mjs`,
`frontend/eslint.config.mjs`), sharing one rule set in
`scripts/eslint/houzs-lint-rules.mjs`, where every rule cites the BUG-HISTORY
entry it answers. Wired to CI as `lint (backend)` and `lint (frontend)`.

Every rule is `warn`, deliberately: the gate is `scripts/lint-ratchet.mjs`,
which holds a PER-FILE CEILING that may only fall. The tree starts at
`no-unnecessary-condition` 2,617 / `no-explicit-any` 989 /
`no-floating-promises` 1 / `no-restricted-syntax` 166 in the backend and
1,807 / 538 / 799 / 140 in the frontend, across 309 and 344 files. Failing the
build on 7,046 pre-existing warnings on day one is how a lint layer gets
deleted in week two; pinning them and refusing growth is how it survives. A
file absent from the manifest has a ceiling of ZERO, so a NEW file is held to
the clean standard immediately.

**Proved, not assumed** — each rule was mutation-tested: the defect from its
cited BUG-HISTORY entry was re-introduced and the rule had to fire on it.

**Class** — *a rule that lives only in prose*, docs/bug-classes.md. The
`eslint-disable` comments are the sharpest instance this repo has produced: 514
suppressions of a check that did not exist.

**Two defects in the gate itself, found while landing it** (2026-08-14) —

*The linter's own gate was a binary file.* `scripts/lint-ratchet.mjs` carried two
RAW NUL bytes, at offsets 5023 and 8650, as the separator in its
`` `${file}<NUL>${rule}` `` map keys — the exact shape
`merge-duplicate-fabric-colours.mjs` was fixed for. Git therefore classified it
binary: `git diff --numstat` answered `-` `-` for it, so the PR that introduces
this repo's first linter showed **no reviewable diff for the linter**. Caught by
`backend/tests/noNulBytesInSource.node.mjs`, which is why `backend-typecheck` was
red at 132 of 133 rather than for anything about types. Fixed by writing the
two-character escape `\0`; `` `${rel}\0${rule}` `` is the identical string at
runtime, and the file is text again.

*`--update` wrote ceilings UP.* The block wrote the current `counts` wholesale,
so re-baselining against a moved main raised every ceiling main had grown past —
measured on the merge that brought #2127 in: `categories.ts`
no-unnecessary-condition 5 -> 6, `mfg-products.ts` no-explicit-any 3 -> 4,
`sku-usage.ts` no-unnecessary-condition 1 -> 2, in a run that printed only
"wrote 319 file ceilings" and exited 0. CLAUDE.md, this file's own `_readme` and
the previous re-baseline's commit message all state that it refuses to do that;
none of them was code. It is now: `--update` names every pair that would rise,
writes nothing and exits 1. Mutation-proved — `grns.ts` forced to a ceiling of 10
against an actual 74 gives exit 1 and an unchanged file (same md5). A pair with
**no** committed ceiling still gets a starting number, and every one is now
printed by name, because that is the only direction a number may move up.

The three growths above were then fixed at source rather than absorbed. All
three were folds left over *above* an error early-return #2127 had just added —
`(refs ?? [])`, `(skus ?? [])`, `dup && dup.length` — i.e. the very
absence-reads-as-empty shape that PR removed, re-entering one line below its own
fix. The fourth was `patchMfgProductHandler = async (c: any)`, in a file that
already defines `AppContext` and already uses it; typing it surfaced the `dup &&`
fold that the `any` had been hiding from the type-aware rules.

**Ref** - `eslint-layer`, PR #2137, 2026-08-14
## A repair that writes four production columns needed one environment variable, and checked its own work on the session that did the writing [high]

**Symptom** — `backend/scripts/repair-migrated-po-lines.mjs` writes
`so_item_id`, `delivery_date` and `linked_ac_dtlkey` on
`scm.purchase_order_items` and `expected_at` on `scm.purchase_orders`. Its
entire apply gate was `APPLY=1`. No confirmation phrase, and no verification
that re-read the rows afterwards.

**Root cause** — two habits this repo already pays for:

1. **One variable is the same keystroke whether it is meant or mistyped.** Every
   other gated repair here requires `CONFIRM="I HAVE REVIEWED THE DRY-RUN"`;
   this one predates that shape and was never brought forward.
2. **The writing session is the worst witness that a write landed.** The script
   reported the counts its own UPDATEs returned and stopped there. On
   2026-08-13 that exact reasoning reported "written: 7 of 7" over seven rows
   that had been turned into jsonb STRINGS — the count was right and the data
   was wrong. A count is not a shape.

**Found by** — `scripts/check-release-discipline.mjs`, the gate added in this
PR, on its first run against the tree. It was not reported by a person.

**Fix** — the apply path now requires the spelled-out CONFIRM phrase and exits
2 without it; the workflow gained a matching `confirm` input wired to both the
staging and prod jobs. After the write the script opens a SECOND connection,
reads the rows back, and asserts the VALUES it intended are the values present
(and that no header it filled is still blank), failing the run when they are
not.

**Class** — *a gate that only counts*, docs/bug-classes.md. The check that
caught it is now in CI, so a new write script cannot land without both halves.

**Ref** - `release-discipline`, PR #2138, 2026-08-14

## Three bugs in the AutoCount parity checkers, all in OUR queries, none in the data [medium]

**Symptom** — both read-only checks crashed on 2026-08-10, and the section that
did run reported a disagreement it then disproved on the same line:
`check-autocount-parity.mjs:147 PostgresError: column h.total_centi does not
exist (42703)`; `check-line-supply-trace.mjs:70 PostgresError: invalid input
value for enum scm.po_status: "CLOSED" (22P02)`; and section 1 said "the ERP
links a DIFFERENT PO: 14" while printing examples that were identical on both
sides — `SO-000524: AutoCount says PO-000453, PO-000454; the ERP links
PO-000453, PO-000454`.

**Root cause (traced, not guessed)** — three separate mistakes:

1. **`h.total_centi`** was never a column. The header total is
   `local_total_centi`. Worse than the typo: the query then re-derived
   outstanding as total-minus-payments, a SECOND implementation of a rule the
   ERP already owns. The view `mfg_sales_orders_with_payment_totals` computes
   `paid_total_centi` + `balance_centi_live`, and `balance_centi_live` is what
   the SO list actually renders — that is the number a parity check must
   compare against, or it can disagree with the screen and be right about
   nothing.
2. **`'CLOSED'` is not a member of `scm.po_status`.** The live members are what
   `enum_range` says, not what any SQL tree says — 0042 re-added `DRAFT` after
   2990's 0078 removed it. Comparing a text literal that is not a member is a
   hard 22P02, so one bad literal aborted the whole section.
3. **`SO.UDF_ToPONo` is a COMMA-JOINED STRING** when one order was converted to
   several POs ("PO-009566, PO-009555, PO-009556"). The script did
   `have.has(r.ToPONo)` against a Set of individual doc numbers, which can never
   match a joined string, so every multi-PO order was a false positive — and
   because the "extra PO" counter only incremented on the match branch, it was
   suppressed to 0.

**Fix** — `backend/scripts/check-autocount-parity.mjs` +
`check-line-supply-trace.mjs`:

1. Balance reads `balance_centi_live` from the view, joined on `doc_no` rather
   than selected from directly (the view froze its column set at CREATE VIEW,
   so `linked_ac_docno` is not guaranteed visible through it — see the VIEW-TRAP
   note in `scm/routes/mfg-sales-orders.ts`). Column presence and doc_no
   uniqueness are PRINTED, not assumed.
2. `enum_range(NULL::scm.po_status)` is printed as the first line of the supply
   trace, and every `po_status` comparison is cast to text, so an unknown member
   can never again abort a read-only diagnostic.
3. `UDF_ToPONo` is split on commas, trimmed, and compared as SETS. The outcomes
   are reported separately: exact match, ERP links a superset, ERP is MISSING a
   named PO, ERP links none.

A fourth reporting bug found while fixing them: section 2 of the supply trace
printed `recv X/Y` as the PO LINE's `received_qty` over the SO LINE's `qty` —
two different quantities — which made a PO line legitimately covering several SO
lines read as an over-receipt ("recv 2/1"). It now prints the PO line's own
ordered qty, and a dedicated over-receipt lens counts `received_qty > qty`
against the same line. Its headline count was also taken from a `LIMIT 400`
result set, so it could never exceed 400; it is now a `COUNT(DISTINCT i.id)`
over the whole population, with an explicit adds-up check against the total.

**The class, for next time** — a diagnostic that dies on a schema fact it
guessed is worse than no diagnostic, because the crash reads as "the data is
broken". Every one of these checks now PRINTS the schema fact it depends on
(enum members, view columns, key uniqueness) before using it.

**Ref** — 2026-08-11, PR #1914 (fix/parity-checkers).

## Section 4 of the parity check compared a PO number against a GR number [medium]

**Symptom** — "the two disagree about which receipt: 291" of 449 purchase
orders, with every example printing the PO number on the ERP side:
`PO-009304: the ERP's GRN points at PO-009304; AutoCount says GR-004996,
GR-005018`. A 65% disagreement rate on document flow that was entirely fictional.

**Root cause (traced, not guessed)** — the query read `scm.grns.linked_ac_docno`
as if it held the receipt's AutoCount number. It holds the PURCHASE ORDER's:
`create-migrated-documents.mjs` inserts `g.po.linked_ac_docno` into that column,
which contradicts migration 0276's own `COMMENT ON COLUMN` ("The AutoCount GR
document this row mirrors"). Comparing a `PO-` string to a set of `GR-` strings
can only ever fail. Two further faults were in the same comparison: it used
string equality where one AutoCount receipt legitimately spans several POs
(1,250 of 4,939 do), and it never checked whether the reference data it depended
on had been populated at all.

**Fix** — section 4 now reads `scm.purchase_orders.linked_ac_grn_docnos` (what
`stamp-ac-grn-refs.mjs` writes), cross-checked against the number the migrated
GRN was minted with (`HC-<AC GR>`, or `HC-<AC GR>-<AC PO>` when the receipt
covers several POs), and compares by SET MEMBERSHIP. `migrated_no_stock` GRNs
count as received — they are real documents that carry no movement on purpose.
4a verifies the stamp before any conclusion is drawn and says so if it is empty;
4c extends the chain to purchase invoices; 4d separates "the document exists"
from "the document is linked". Corrected: 427 agree, 10 AutoCount-only,
12 ERP-only, **0 genuine receipt disagreements**.

**The class, for next time** — a column whose CONTENT contradicts its own
`COMMENT` is a trap with a documentation-shaped lid. The comment said GR, the
writer wrote PO, and a reader who trusted either one was wrong. When a check
depends on reference data being populated, verify the population FIRST — an
empty column reads exactly like a total disagreement.

**Ref** — 2026-08-11, PR #1914 (fix/parity-checkers).

## PO -> GRN convert died on `there is no row at position -1` [high]

**Symptom** - `/po-to-gr` returns 500 on the live book. `/so-to-do` on the same
service, same shape of call, succeeds - `DO-011260` and `DO-011262` are the
proof. So the transfer primitive itself works; only the purchase side of it
fails. The message says nothing about purchasing: `there is no row at position
-1`.

**Root cause (traced, not guessed)** - the third argument of
`AddPartialTransferDetail(fromDocType, fromDocDtlKeys, transferMaster)` was
`false` on all four conversions. That flag copies the SOURCE document's header
master - supplier, currency, terms - onto the target. With `false` the GRN is
constructed with no supplier, the purchase detail constructor looks that
supplier up in the master table, `IndexOf` returns `-1`, and the SDK indexes the
row collection at `-1`. The sales classes tolerate `false`, which is why DO and
IV never showed it and why the failure looked purchase-specific rather than
argument-specific.

**Two theories were tested first and both are wrong**, recorded so they are not
re-chased: (1) that a headless process was being refused an "edit transfer
detail" dialog - `DisableShowEditTransferDetailForm()` was added and the
exception did not change by one character; (2) that `PurchaseHeader` failed to
set the supplier - `SalesHeader` does not set one either, and it passes.

**Fix** - `transferMaster: true` on the two PURCHASE conversions (`GR`, `PI`).
The two sales conversions keep `false` deliberately: they are proven in the live
book with it, and this change is not the place to disturb them.

**Lesson** - a boolean whose name is a noun deserves the reflected signature
read before it is passed. The argument had been `false` since the file was
written, and every debugging theory pointed at purchasing because purchasing was
the only side that broke - the difference was in the call, not in the module.

**Ref** - `fix/ac-convert-headless`, 2026-08-12. Compiles clean locally (48,128
bytes); NOT yet exercised against the live book - the swap must run on the host.
## The stock-location gate left "New order from catalogue" unable to raise ANY company-1 order [high]

**Symptom** - on company 1 (Houzs Century), every cart built on
`/scm/sales-orders/new/from-products` was refused at Create with
`422 validation_failed` / `so_state_required` - "Pick the delivery State before
creating this order." There is no State field on that screen, and no way to
reach one without abandoning the cart, so the page could not create an order at
all. Company 2 (2990) was unaffected.

**Root cause** - two correct decisions that were never checked against each
other. The page collects no address BY DESIGN (its own header says "Payments and
address are added on the SO detail after save") and lands CONFIRMED. PR #2112
then made a resolved `sales_location` mandatory at CREATE for the companies in
`LOCATION_REQUIRED_COMPANY_CODES`, gated on `asDraft !== true`. A flow that
collects no State and does not draft satisfies neither arm of that gate.

The gate's own DRAFT exemption was the missing piece and was already sitting
there: `SalesOrderNewGuided` collects no address either and was never affected,
because it lands a draft unconditionally. #2112 recognised the collision on the
from-products page and answered it as UI copy - the page told the operator to
"Switch to Full form" - which is a refusal explained, not an order created, and
it arrived only after the cart was built. (The module guide claimed the page
said so "up front"; it never did. That claim is also fixed.)

**Fix** - the page lands a DRAFT for exactly the companies the location rule
covers, read from the ONE shared list via the new
`companyRequiresStockLocation` in `frontend/src/vendor/scm/lib/so-form-validate.ts`
(twin of the backend predicate of the same name). A draft is never written to
AutoCount, so it owes the account book no Location; the operator adds the
address on the SO detail and confirms there, where the `DRAFT -> live`
transition re-runs the same gate. Nothing is bypassed - the gate is deferred to
the only screen that can satisfy it. Company 2 and every uncovered company keep
landing CONFIRMED, and adding a company to the list now moves this page with it
instead of breaking it. The shared `soStockLocationError` call stays, passed
`asDraft: landsDraft`, so the day this flow stops drafting it is gated
automatically rather than silently minting locationless orders - the same wiring
the guided wizard uses. Page copy and the CTA now say "Save draft SO" and
explain the next step.

**Lesson** - **a gate with an exemption must be checked against every surface,
because the surface that needs the exemption is the one that cannot satisfy the
rule.** #2112 correctly listed all four create surfaces and correctly worked out
that this one could never pass; the step it skipped was asking whether the
exemption it had just written applied. A surface that is told to go and use a
different screen is a surface that has been switched off.

**Ref** - 2026-08-13.

## The State dropdown was cut off after two or three states on every address form [medium]

**Symptom** - the owner, on the Sales Order detail address block: "我的 state 的那个
UI 也是被直接斩断了,然后很难、很辛苦". Opening State showed MALAYSIA, Johor, Kedah
and then nothing - the rest of the 16 states existed but were sliced off at the
card's edge, so picking anything past Kedah meant fighting a list you could not
see.

**Root cause (traced to the declaration)** - `StatePicker.module.css` had
`.panel { position: absolute; top: calc(100% + 4px); z-index: 60 }` inside
`.comboWrap { position: relative }`, i.e. the menu was a normal child of the
field. `position: absolute` escapes layout flow, but it does NOT escape an
ancestor's `overflow` clip - any card, drawer or section between the field and
the viewport that sets `overflow: hidden`/`auto` clips the menu at its own box,
and the SO detail's address card is only ~150px tall below the field. z-index
was never the problem, so the earlier bump to 60 could not have helped. The
component had no `createPortal`, no `position: fixed` and no
`getBoundingClientRect` anywhere - every other picker in this codebase
(`SoLineCard`'s SKU/fabric menus, `SearchableSelect`) had already been converted
to a body portal for exactly this reason, and this one was missed.

**Fix** - the panel is `createPortal(..., document.body)` with
`position: fixed`, and its top/bottom/left/width/max-height are measured from
the input's `getBoundingClientRect()`. A `useLayoutEffect` re-measures on
`scroll` in the CAPTURE phase (the field usually sits in a scrolling card or
drawer, and those scroll events never reach `window` on the bubble path) and on
`resize`, removing both listeners when the list closes or the component
unmounts. When the space below the input cannot hold the list and the space
above holds more, the panel anchors by its `bottom` edge and grows upward
instead. Behaviour is untouched: options still commit on `onMouseDown` +
`preventDefault` so the pick lands before the input blurs, `onBlur` still
closes, and Escape/arrows/Enter are unchanged - a portal moves the DOM node but
React events still propagate along the REACT tree, so hosts that close on a
click in their own subtree (the Warehouse drawer's backdrop) behave as before.
Mobile is untouched: it passes `compact`, which is a native `<select>`.

**Verified** - reproduced in an isolated harness (a `overflow: hidden` card,
the shape of the real address block): pre-fix, exactly two states rendered;
post-fix the full 280px scrollable list paints over the card edge, flips above
the input near the viewport bottom, and picking still reports
`("Penang", "Malaysia")`. 13 new tests in `StatePicker.test.tsx`; the 7
placement ones fail on the pre-fix tree.

**Lesson** - **`position: absolute` is not an escape hatch from `overflow`; only
leaving the subtree is.** Three menus in this repo were portalled one at a time,
each as its own bug report, because the fix was applied to the component that
was complained about rather than to the class. When a shared control is
converted, grep for its siblings (`grep -L createPortal` over the components
that render a floating panel) before closing the ticket.

**Ref** - `fix/state-picker-portal`, 2026-08-13

## Two ways the sofa write-back could pick a different item for the same sofa [high]

Found while giving the four ambiguous sofa models a single canonical item. Both
are the same class: one fact derived in two places that were allowed to disagree.

**1. A compartment resolved differently from its own collapsed build.**
`resolveAcItemCode` had a fallback that sent a compartment (`9028-1A(LHF)`)
through the model base code, widening the candidate list with every AutoCount
model the cutover folded onto that ERP model (`SOFA_MODEL_ALIAS`). So a
compartment of 9028 saw `HOK-5530 SOFA` through the alias and took it on the
HOK preference, while `9028-1S` itself sees only the two brand items and falls
through. Resolving one line at a time and resolving the built document gave two
different AutoCount items for one sofa.

**Fix** - the SHAPE is now decided before the resolver runs, so the resolver
does no sofa reasoning at all: a folded line arrives as `<model>-1S`, an
unfolded one as its own compartment code, and each resolves to what it is. The
alias widening stays, restricted to base codes, which is the only shape it was
ever meaningful for.

**2. A run of ONE compartment stopped folding.** The new shape rule reads the
DtlKeys — compartments sharing one key are one line in the book and fold;
distinct keys are already separate lines and do not. A run of length one always
satisfies "all keys distinct", so every single-piece build silently stopped
folding. The visible damage was in the refusal tests: four of them went quiet,
passing lines through instead of refusing a bad Desc2, because a passthrough
line is never handed to the code that refuses.

**Fix** - the distinct-keys test requires at least two compartments.

**A third was caught in review before it shipped.** The first version of the
shape rule was "does the line have a key". A new order gets its keys back from
the create, so its very first edit would have folded two real account-book lines
into one. The owner spotted it: *"如果他有 delete 东西等等，就算是建立新的
order，他就会整个 SKU 换掉，不是吗？"*

**Lesson** - **when a pipeline decides a shape, nothing downstream may re-derive
it.** Every one of these came from the resolver holding its own opinion about
what a sofa is, alongside the collapse that had already decided. The fix that
actually holds is not a better opinion, it is deleting the second one.

**Ref** - `feat/ac-sofa-default-code`, 2026-08-13

## A new workflow was wired to two secrets that do not exist, by copying the one workflow that already was [medium]

**Symptom** - the first dispatch of "Re-queue skipped AutoCount documents" died
immediately:

```
Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the Houzs Supabase REST creds).
env:
  SUPABASE_URL:
  SUPABASE_SERVICE_ROLE_KEY:
```

Both empty. Not misconfigured — absent.

**Root cause** - two things, and the second is the one that will repeat.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` exist nowhere in this repository:
not at repo level, not in Production, Staging, or the third environment. What
does exist is `DATABASE_URL`, used by **286** workflows, and
`SOURCE_SUPABASE_URL` / `SOURCE_SERVICE_ROLE_KEY`, which are a different thing
again — they point at the 2990 SOURCE system.

The script needed a PostgREST-shaped client, correctly: it imports the real
`enqueueSoCreate` from `src/` instead of re-implementing it, so it must hand
that function the client it expects. It then reached for PostgREST CREDENTIALS,
which is a different requirement, and looked for a precedent. There are exactly
two workflows in the repo referencing those secrets, and it found the other one:
`recompute-2990-so-allocation.yml`, broken for the same reason and never run.
The one that works, `recompute-so-allocation.yml`, is three characters away by
name and reaches the same kind of function through
`backend/scripts/lib/pgrest-shim.mjs` over `DATABASE_URL`.

**Fix** - the re-queue script builds its client with `pgrestShim(pg, 'scm')`.
Nothing else changed; the enqueue cannot tell the difference. `CLAUDE.md` now
states the rule under "Never ask the owner to run a query" — DATABASE_URL is the
credential, the shim supplies the shape — and names the file not to copy.
`recompute-2990-so-allocation.yml` carries a header saying it is broken, why,
and how to fix it, so the trap cannot be sprung a third time.

**What the audit ruled out** - the owner was sure the credentials existed
("Supabase 还有 Service Role Key 我之前 create 过了, 一定有"), and they are
probably right: they are Cloudflare WORKER secrets, a store GitHub Actions
cannot read. Both statements are true at once, which is why the first search
came back with a flat "they do not exist" that read as wrong. That answer was
also under-verified when first given — two of at least four stores had been
checked. `wrangler secret list` could not settle the Worker side either: the
authenticated account (`27cd35c9...`) does not match the `account_id` in
`wrangler.toml` (`816e4573...`), which is its own unresolved issue.

**Lesson** - **a precedent is evidence only if it ran.** "Another workflow does
it this way" was true and worthless: that workflow had never executed. When
copying an access pattern, prefer the one with successful runs behind it, and
where a repo has 286 examples of one thing and 1 of another, the 1 needs a
reason. Related: this system's state is spread over GitHub repo secrets, three
GitHub environments, Cloudflare Worker secrets and `scm.app_config`, and nothing
enumerates them — the same shape as the write-back toggle that could not be
answered from documents until the health check learned to read it.

**Ref** - `fix/requeue-use-database-url`, 2026-08-13

---

## Fixing the cause of a refused write-back did not bring the document back [high]

**Symptom** - `HC-SO-2608-002` was refused with `MissingLocationError` and
written to `scm.autocount_outbox` as `skipped`. The owner then set the delivery
address, so the order carries `sales_location = PG WAREHOUSE` and the stated
remedy - "set the warehouse on the line, or the sales location on the document"
- was satisfied. Re-running the health check on 2026-08-13 afterwards: the same
two `skipped` rows, unchanged, nothing pending. The order was never going to
reach AutoCount, and nothing in the ERP said so.

**Root cause** - a `skipped` row is TERMINAL and no path re-asks the question.
`enqueueSoCreate` is called from exactly two places in `mfg-sales-orders.ts` -
the create itself, and the `DRAFT -> live` transition - and an ordinary edit is
neither, so re-saving the order never re-attempts the create. The obvious
fallback does not fire either: `enqueueEdit` bails on
`if (!composed.linkedAcDocNo) return false;`, because a document that never
reached AutoCount has no counterpart to edit. So the queue recorded the
divergence correctly, named the remedy correctly, and then had no way to act on
the remedy once it was applied. Both stuck documents (`HC-SO-2608-001`,
`ItemCodeError`, and `HC-SO-2608-002`) were in this state.

**Fix** - `backend/src/scm/lib/autocount-requeue.ts` +
`backend/scripts/requeue-autocount-skipped.mjs` + the *AutoCount write-back -
re-queue a refused document (DRY-RUN gated)* workflow. It re-runs the SAME
`enqueueSoCreate` / `enqueuePoCreate` the route runs, against the document as it
is now - never the stored payload, which is `{}` on a refusal and would be the
pre-fix order even when it is not. The script runs under `tsx` and imports the
real enqueue from `src/`, the same way `recompute-2990-so-allocation.mjs` and
three other workflows already reuse canonical service code, because a second
composer in `.mjs` is the one outcome that could push a document the real
composer would have refused. DRY RUN is the default and is not a prediction:
`captureWrites` runs the real enqueue and records the write instead of
performing it, so the dry run and APPLY differ only in whether the row lands.
A re-queued skip keeps status `skipped` (0277's CHECK admits four statuses and
every one would be a lie) and has its reason prefixed
`[re-queued <when> -> outbox <id>]`; the health check now reports those rows
separately so they stop reading as backlog.

**Lesson** - **a queue that records a refusal owes you a way to withdraw it.**
Every refusal in this module was designed with care - the reason is durable, it
names the remedy, and the health check prints it - and the whole chain still
dead-ended, because "the operator fixes the cause" was assumed to re-enter the
system through a door that only opens on create. When a check writes down "fix
X and try again", the "try again" is part of the feature, not the operator's
problem.

**Ref** - `feat/autocount-requeue-skipped`, 2026-08-13.

---

## An order with no delivery State saved happily, then AutoCount refused it for having no stock location [high]

**Symptom** - the owner's second AutoCount write-back test, `HC-SO-2608-002`,
was accepted by the ERP and then sat in `scm.autocount_outbox` as `skipped`:

```
refused, nothing sent (MissingLocationError): 2 line(s) carry no stock location
and none can be inherited from the document ... AutoCount rejects a document
line whose Location is not in dbo.Location
```

The salesperson had already been told the order was saved. Both of the first
two test orders died this way.

**Root cause** - the SO's warehouse is the header's free-text `sales_location`,
and that value is DERIVED from the customer's State:
`deriveSalesLocationFromState` (`mfg-sales-orders.ts`) looks the State up in
`state_warehouse_mappings` and returns **null when the State is unmapped or
absent**. Create then wrote `sales_location: derivedSalesLocation ?? null`
without ever asking whether the result was usable. Both test orders had no
delivery address, so no State, so no warehouse, so no `Location` - and
`composeCreateSo` runs with `requireLocation`, because AutoCount's
`FK_SODTL_Location` rejects the empty string. The ERP was accepting a class of
order it already knew the account book would refuse, and only saying so
afterwards, in a queue nobody watches.

**Fix** - a create-time gate, company 1 only (owner 2026-08-13: *"Company 1
(Houzs Century) 开单必须有 State。Company 2 (2990) 不需要。其他公司也不必填"*).
`backend/src/scm/lib/so-location-gate.ts` holds the rule; the company list is
one array of `companies.code` values, so adding a company is a one-line change.
It gates on the DERIVED warehouse rather than on the State being present - an
unmapped State derives nothing either - and reports the two causes with
DIFFERENT messages, because they have different owners: a missing State is the
salesperson's to fix, an unmapped State is an administrator's. Wired at the two
and only two places that enqueue an AutoCount create: the create path
(`asDraft !== true`) and the `DRAFT -> live` status transition. Drafts stay
freely saveable - the scan pipeline's guess is not an order yet. Mirrored on
the four create surfaces through the shared `so-form-validate.ts` so the
operator hears it before losing their typing.

**Lesson** - **a gate the downstream system enforces must be enforced at the
point of entry, not discovered at the point of transmission.** The refusal was
correct, well-worded and completely useless where it landed: hours later, in an
outbox row, addressed to nobody, about an order the salesperson believes is
done. The same shape is waiting behind every other `requireLocation`-style
precondition in `autocount-writeback.ts` - each one is a rule the ERP can check
while the human is still on the screen.

**Ref** - PR #2099, 2026-08-13.

---

## A sofa and a pillow were sitting in the fabric catalogue, and nothing on the write path could have stopped them [medium]

**Symptom** - a prod probe on 2026-08-13 (`probe-fabric-leftovers.mjs`) found two
rows in `scm.fabric_trackings` that are not fabrics: `SOFA 5535` described as
"5535 (3+L)", and `SQUARE PILLOW` described as `SQUARE PILLOW (16" X 16")`.
Owner: 「为什么sofa 和square pillow在fabric convert里面？」.

**Root cause (traced)** - they were not typed into the Fabric Converter. Both are
verbatim rows of `backend/_hk.json`, the 153-row dump of the HOOKKA fabric master
committed on 2026-06-23 (12f94a9c) — identical code, identical description,
identical derived id (`SOFA_5535` / `SQUARE_PILLOW`, which is
`fabric-tracking.ts`'s own `code.toUpperCase().replace(/\s+/g,'_')` minting
rule). Two AutoCount product items had been opened as "fabrics" in the source
system, and the wholesale seed carried them into Houzs because neither write path
into that table — `POST /fabric-tracking` nor `POST /fabric-tracking/bulk-upsert`
— looks at what a fabric code IS. `fabricCode` non-empty was the whole
validation. Deleting the rows would not have closed it: re-running that import,
or any spreadsheet whose product column lands under `fabric_code`, puts them
back. (`align-fabric-trackings.mjs` was ruled out as the origin — its CREATE loop
only materialises codes that are already active rows in `scm.fabric_colours`, and
that table is fed only from `fabric_trackings` itself or from hand-curated lists.
It can perpetuate a stray row, not mint one.)

**Fix** - `nonFabricCodeWord()` in `fabric-tracking.ts` refuses a fabric code
whose HEAD is a product-category word, on both write paths (400 `non_fabric_code`
on create; a per-row `errors` entry on bulk-upsert, so the rest of an import
still lands). The word list is the one
`backend/scripts/probe-fabric-leftovers.mjs:43` used to produce the owner's two
rows off the live table. The rule tests the CODE ONLY: nine of those 153 genuine
fabrics describe themselves as "SOFA FABRIC KOONA VELVET PEARL", so a
description test would have refused every one of them. `PATCH /:id/active` and
`DELETE /:id` are untouched, so the two rows already in prod stay fixable.

**Lesson** - **a seed from another system is a write path, and it inherits every
gap in the one it goes through.** The Converter's create form was never going to
be typed full of product codes; the bulk endpoint behind it was handed a whole
foreign master in one call, and the only thing standing between that file and the
price-tier join was a non-empty check. **And when the guard has to reject
something, judge the field that carries identity (the code), not the field that
carries prose (the description) — the prose was full of the exact word.**

**Ref** - 2026-08-13, this PR. Probe: `probe-fabric-leftovers.mjs` group A.

## Proceeding an order stamped a click time and set no start date, so an order could be in production with no day the factory starts [high]

**Symptom** - an order could reach IN_PRODUCTION carrying `proceeded_at` and a
NULL `internal_expected_dd`. The owner's rule says that state cannot exist:
*"只要有 Processing Date，就代表他 Proceed 了。Proceed 的日期是他填入 Processing
Date 的日期。没有 processing date 就代表没有 proceed。"* Production queues by the
Processing Date, so such an order is proceeded and in no queue.

**Root cause** - every proceed path wrote the wrong column. `PATCH
/:docNo/status` -> IN_PRODUCTION set `patch.proceeded_at = new Date()` and no
date; CREATE auto-proceed did the same (`proceeded_at: autoProceed ? ... :
null`) for any complete, deposit-paid handover that carried no Processing Date;
`PATCH /:docNo` `proceededAt` gated the proceed but never asked for a date.
Proceed was modelled as an event with a timestamp when it is a STATE - having a
date. Same era, same file: the deposit for that one act had two predicates,
`meetsProceedGate`'s inline ratio and `meetsProcessingDatePaymentGate`. They
agreed only because a previous PR had walked both onto
`processingDateThresholdFor`; before that they were two thresholds, and a 2990
order was refused at the Houzs 30% (2026-07-31).

**Fix** - proceeding RESOLVES a Processing Date and writes it
(`resolveProceedProcessingDate`, `order-rules`): the order's own date if it has
one, else a date on the request, else a 422 `proceed_needs_processing_date`. No
path defaults to today - a guessed start date is a real order in the real queue
on the wrong day, with nothing to show it was guessed. A date the status route
writes clears the FULL Processing-Date gate table, read live off the row, so the
proceed route cannot become the way around it. A create with no date now yields
an UN-proceeded order rather than a dateless proceeded one. The two deposit
predicates collapsed into `meetsDepositGate`, which both the Proceed gate and the
aggregated save report read; a test asserts the report refuses exactly when the
gate does. `proceeded_at` is still written and still read - the stock allocator
sorts by it - it is simply no longer what makes an order proceeded.

**Lesson** - **when a state has a defining field, do not also record the moment
someone claimed the state.** Two markers for one fact drift the moment any path
writes one and forgets the other, and the half-written row looks valid to every
reader that checks only its own marker.

**Ref** - PR (branch `proceed-is-the-date`), 2026-08-13.

## The server enforced "both dates or neither" in one direction only [medium]

**Symptom** - the New/Edit SO form refuses a lone date in either direction
(`so-form-validate.ts:94`, `hasP !== hasD`), but a Delivery Date with no
Processing Date could still land on a row. `probe-so-date-xor.mjs` counts them
live, split by direction.

**Root cause** - the shared server gate `collectProcessingGateProblems`
(`so-save-problems.ts`) only ever asked for the DELIVERY half, and only inside
`if (facts.procDate && facts.completeness)` - so a delivery date with no
processing date raised nothing at all, on any path. The SO create and header
PATCH routes each short-circuit on `processing_delivery_must_pair` before
reaching the helper, which hid it; the consignment header PATCH
(`consignment-orders.ts:1296`) and the amendment approver
(`so-amendments.ts:605`) have no such short-circuit and passed a lone delivery
date straight through.

**Fix** - the helper now reports the missing direction as
`processing_delivery_must_pair`, carrying the SAME grandfather the past-date
rules use (`origProcDate` / `origDelivDate`): it fires only when THIS save
changed one of the two dates, so a stored unpaired date an unrelated edit leaves
alone still saves. That matters against live data - a 2026-08-13 backfill paired
117 orders from AutoCount and 19 stayed honestly unpaired because AutoCount has
no delivery date for them either.

**Lesson** - a validation that exists on both the client and the server is only
as strong as its server half, and "the routes already check it" is not the same
as "the shared rule checks it". Two of five callers of this helper had no
short-circuit of their own.

**Ref** - `fix/date-pair-server-side`, 2026-08-13

## Every readiness and cutover number the owner was shown counted a different population than the screens he compared them against [medium]

**Symptom** - the ops scripts and the app disagreed about which orders are
"processed". Nothing threw; the numbers were simply about a different set of
orders than the ones on screen, and the gap widened the moment the Processing
Date moved.

**Root cause** - "has a Processing Date" had two storages and the two halves of
the system picked different ones. Every screen reads
`scm.mfg_sales_orders.internal_expected_dd` - it is what the UI writes, what
`soProcessingLocked` reads (`mfg-sales-orders.ts`) and what MRP reads
(`mrp.ts`). Ten `backend/scripts/` diagnostics instead asked
`proceeded_at IS NOT NULL`, and `proceeded_at` is stamped only at the
IN_PRODUCTION transition, so it always named a NARROWER set. `unify-processing-date.mjs`
then migrated 519 company-1 orders' dates into `internal_expected_dd` on
2026-08-13, leaving both companies at zero split - which made the scripts
authoritative-looking and wrong at the same time, because the proceed rule the
owner keeps restating ("只要有 Processing Date，就代表他 Proceed 了") is now
answered by a column none of them read.

**Fix** - re-pointed the ten diagnostics that were asking "does this order have
a Processing Date". Deliberately NOT re-pointed, because they are asking a
different question and are named as such in the code: the three allocator
explainers (`check-status-disagreement-why`, `check-bedframe-sofa-status-truth`,
`check-stock-vs-autocount`) and section 7 of `check-cutover-metrics`, all of
which reproduce the gate `so-stock-allocation.ts` actually applies - and that
allocator still gates on `proceeded_at`. They must move in the SAME change that
moves it, or they stop describing production. `check-migration-fidelity` also
stays: it verifies what the IMPORTER transcribed into `proceeded_at`, not
whether an order is proceeded.

**Lesson** - **when one fact gets a second storage, the diagnostics are the last
place anyone looks and the first place the split becomes invisible.** A readiness
report has no test and no user to notice it is off; it just prints a smaller
number with the same confidence. The tell was already in the tree - the app's
own comment at `mfg-sales-orders.ts:455` says the lock stopped requiring
`proceeded_at` "because that is stamped only at the IN_PRODUCTION transition" -
and no sweep carried that same reasoning across to the scripts.

**Ref** - `fix/proceeded-at-diagnostics`, 2026-08-13

## A guard that says "all clear" because it could not look [high]

**The shape, named** — a Supabase read destructures `data` (or `count`) and
DROPS `error`, so a query that FAILED arrives as `data ?? []` / `count ?? 0` —
i.e. as **an absence** — and the absence is the very thing that authorises the
next write. This is the sibling of the ZEROING shape already recorded in this
file (discarded-error read → `?? []` fold → money column written as 0). Same
destructure, different consequence: the zeroing shape writes a wrong NUMBER,
this one writes a document that should have been REFUSED.

**The rule, in one line** — *a failed read must never read as an absence when
the absence is what authorises the write.*

**The worked example: payment vouchers double-posted to the GL.** `POST
/payment-vouchers/:id/post` asked whether a journal entry already existed for
the voucher with `const { data: existingRows } = await sb…`. On a read failure
`existingRows` is `undefined`, `?? []` makes that "no journal entry exists", the
idempotency check passes, and the handler posts a **SECOND** journal entry
against the same voucher — the supplier payment hits the GL twice, and nothing
anywhere logs why. Fixed 2026-08-13; the read now returns 500 with the
database's own message rather than deciding the voucher is unposted.

**Why grep-by-name never finds these.** The dangerous ones are not spelled
`existingRows`. They are helpers with reassuring names — `soHasDownstream`,
`piLocked`, `findServiceLineCodes` — whose contract is "returns the refusal, or
null if the document is free". `null` is the answer for BOTH "I looked and there
is nothing" and "I could not look", and only one of those may end in a write.
Grep for the SHAPE (`const {` … `data` … no `error`), then keep only the reads
whose empty result authorises something.

**Measured 2026-08-13 at `origin/main` 2bde7bd9** — `backend/src` holds **1791**
`const { data` destructures outside tests, of which **972 bind no `error` at
all** (**959** of those in `backend/src/scm`), plus **23** `const { count`
destructures with no `error`. The class is endemic; the subset that matters is
the one where the absence authorises a write. `sweep/swallowed-error` converted
**12** of them (8 `data`, 4 `count`) — every GUARD HELPER in SCM whose all-clear
verdict lets a mutation through:

- `scm/lib/downstream-lock.ts` — `liveCount` + `grnHasDownstream`. The owner's
  2026-08-10 rule ("已经转到下游的单据, AutoCount 不许取消/改动") is enforced here for
  SO / PO / DO / GRN at ~30 call sites. One dropped `count` and a **shipped SO
  was cancellable again**. Now refuses with `downstream_check_failed`; call
  sites already 409 on any refusal, so nothing else changed.
- the four route-local clones of that same guard, which the shared module never
  absorbed: `pcoHasDownstream` (`purchase-consignment-orders.ts`),
  `coHasDownstream` (`consignment-orders.ts`), `pcReceiveHasDownstream`
  (`purchase-consignment-receives.ts`), `noteHasDownstream`
  (`consignment-notes.ts`).
- `purchase-invoices.ts` `piLocked` — a failed read answered "not locked", so a
  **PAID or CANCELLED invoice became editable**.
- `scm/lib/service-line-guard.ts` `findServiceLineCodes` — the catalog read is
  the half that catches a payload lying about `item_group` AND code prefix. A
  failed read returned `[]`, indistinguishable from "all clear", and the SERVICE
  line went into a Delivery Return, which **writes phantom stock IN**. Now
  returns `{ ok: false, reason }`; the four DR call sites refuse on it.
- `scm/lib/allowed-options-check.ts` `loadProductAndModel` /
  `loadProductsAndModels` — the file's own header had **named this bug in
  writing since 2026-08-01** ("the discarded error becomes `product = null`,
  which this gate reads as allowed") and left it in place. A duplicated code
  across companies returns PGRST116, not a row; the variant gate then stopped
  checking instead of stopping the line. Now carries `lookupError`, and all 8
  call sites in `mfg-sales-orders.ts` / `consignment-orders.ts` 409 on it.

**Deliberately NOT fixed here, and why** — the **post-insert over-receipt /
over-invoice / over-return verifiers** (`grns.ts` `verifyGrnOverReceipt` +
add-line, `purchase-invoices.ts` `verifyGrnLinesNotOverInvoiced` + add-line,
`purchase-returns.ts`, `purchase-consignment-receives.ts`,
`purchase-consignment-returns.ts` — 8 sites). They carry the same swallow with a
worse consequence: a failed read leaves an over-quantity row COMMITTED. But
`verifyGrnOverReceipt` states an explicit policy — *"Best-effort: a verification
read failure must not block the receipt"* — and making them fail closed means
409-ing legitimate receipts on a transient blip. That is a policy the owner
should choose, not a bug fix. Note the policy comment is also **inaccurate**: it
describes the `try/catch`, and a PostgREST error is RETURNED, not thrown, so the
`catch` never sees the case it claims to cover. Corrected in place.

**Checked and found FAIL-CLOSED — no change needed** (recorded so nobody
re-opens them): `scm/lib/validate-item-codes.ts` (a failed read makes every code
unknown → 409), `scm/lib/check-stock-availability.ts` (a failed balance read
makes every line short → blocks), `scm/lib/so-confirm-gate.ts`'s catalog read
(failed → every code non-catalog → refuses), `scm/lib/amendment-command.ts:147`
(a failed post-23505 lookup throws `command_enqueue_failed`, it does not enqueue
twice). Duplicate-code checks backed by a real unique index —
`threepl-companies.ts` code mint, `warehouse.ts` rack seeding — degrade to a
23505 and a wrong error message, never a duplicate row; left, and listed.

**Lesson** — **a helper whose return type cannot express "I could not look" will
eventually answer "nothing found", and the caller will spend that as
permission.** Every guard fixed here returned `X | null`, and every one of them
was correct code for the happy path. The type was the bug. Where a guard's
verdict authorises a mutation, give the failure its own value — a refusal, a
`lookupError`, an `ok: false` — and let the call site decide; do not let it
share a representation with "clear to proceed".

**Ref** — `sweep/swallowed-error`, 2026-08-13. Backend only; **no migration**.
Tests: `downstream-lock.test.ts` (new failed-read cases),
`service-line-guard.test.ts` (new file),
`product-lookup-company-scope.test.ts` (the "silently passes" case now pins the
reported PGRST116 instead).

## Four repair scripts whose SECOND run destroys what their first run created [high]

**Symptom** - a production PLAN of `normalize-fabric-codes.mjs` on 2026-08-13
proposed 200 rewrites. Every one of them left the CODE unchanged and shortened
the LABEL: `J9226-01 SAND` -> `J9226-01`. The whole diff was a colour name being
erased, on the same rows a previous apply had just put right. Caught before
apply; a sweep for the shape then found three more.

**Root cause** - the script derives the label from the name it parses out of the
CODE. Before 2026-08-11 the name lived there (`J9226-1 SAND`), so run one
produced code `J9226-01` and label `J9226-01 SAND` - it MOVED the name out of the
code and into the label. Run two parses a now-clean code, finds no name, and
rebuilds the label without one. The script's own output had destroyed its own
input, and nothing in it read the label back.

That is the class, and the sweep asked one question of every writing script in
`backend/scripts`: what does the SECOND run do? Three more answered badly.

- **`retier-sofa-tiers.mjs`** shifts the 2026-08 sofa price bands by POSITION -
  `PRICE_1`->`PRICE_2`, `PRICE_2`->`PRICE_3`, old `PRICE_3` soft-deleted. The
  seat grids, binding matrices and flat lanes are value-guarded and inert. The
  combo block is not guarded at all: it selects every live row in the batch and
  shifts it. A second run pushes the band the first run promoted to `PRICE_2` on
  to `PRICE_3`, and DELETES the band it promoted to `PRICE_3`.
- **`backfill-sofa-special-orders.mjs`** writes the legacy `string[]` shape of
  `custom_specials`, unioned with whatever the column already holds. The declared
  shape is `Array<{ description, surchargeSen }>`
  (`mfg-pricing-recompute.ts:117`) and the recompute writes that whenever a line
  is edited. A second run over a recomputed line runs `String()` over each object
  and stores `["[object Object]"]` - a surcharge breakdown that carries money,
  replaced by a placeholder.
- **`backfill-so-dates.mjs`** wrote `proceeded_at`, `customer_delivery_date` and
  `line_delivery_date` with no predicate at all. All three are columns people
  change: a customer moves a delivery date, and a Super Admin CLEARS the
  Processing Date (`scm.so.remove_processing_date`) to pull an order back out of
  Proceed. A second run silently reverted every one of those decisions - and it
  has been applied on production three times already (runs 31304117373,
  31322311557, 31349208508; `docs/autocount-cutover-ledger.md`). Worse, it would
  re-manufacture the `proceeded_at`-vs-AutoCount agreement that
  `unify-processing-date.mjs` uses as its migration key, so a date somebody had
  deliberately removed could then be promoted into `internal_expected_dd` as if
  the source had proved it.

**Fix** - one per shape, and each one keeps the first run's behaviour identical.

- `lib/fabric-code.mjs` gains `nameFromLabel()`: the label is a name SOURCE, not
  only an output. Only a label whose own series+number canonicalise to the same
  id may donate, so a stale label can never move a name onto a different colour;
  `stripNote()` cuts the `[MERGED into X]` stamp off first so the stamp can never
  become the name. `backend/tests/fabricCodeRerun.test.ts` is the regression - it
  runs the transform twice and asserts the second pass is a fixed point.
- `retier-sofa-tiers.mjs` REFUSES a second run, in both modes. The receipt is in
  the data, not a flag file: the 2026-08 combo batch has no soft-deleted rows
  before the shift and does after, so one soft-deleted row in the batch stops the
  script and prints why.
- `backfill-sofa-special-orders.mjs` refuses any row whose `custom_specials`
  holds a non-string element - the pricing engine's own output - and prints them.
- `backfill-so-dates.mjs` re-asserts `IS NULL` inside every UPDATE, and refuses
  any document whose `scm.mfg_so_audit_log` names one of these dates. Both guards
  are copied from `unify-processing-date.mjs`, which had already reasoned this
  out for the same columns.

**Lesson** - **a repair script's own write is part of its next run's input, and
"keyed on IS NULL" is only safe when nothing but the script can produce that
NULL.** `unify-processing-date.mjs` states the sharper version of the rule and is
the model to copy: a key a legitimate human action can restore - a Super Admin
removing a Processing Date - is not a key, it is a trap. The two safe shapes are
a key the write itself destroys (`jsonb_typeof = 'string'` -> NULL; a `-1S` line
re-coded away) and a value re-derived from an immutable source. Everything else
either converges by construction or has to refuse. A writing script has to state
its re-run behaviour in its own header, because "is it safe to run this again"
was a question nobody could answer without reading the whole file - and three
times this month somebody answered it wrong.

**Correction, 2026-08-13.** This entry originally claimed that "every script in
`backend/scripts` that writes now states its re-run behaviour in its own
header". It did not, and saying so stopped anybody checking. Measured by
`npm --prefix backend run audit:release-discipline` on the day this was written:
**162 scripts write, and 67 of them carry no re-run note.** They are listed, one
by one, in `backend/scripts/release-discipline-grandfathered.json`, and a NEW
writing script without one now fails CI. The rule is real from here; the claim
that it was already universal was not.
either converges by construction or has to refuse. Every script in
`backend/scripts` that writes now states its re-run behaviour in its own header,
because "is it safe to run this again" was a question nobody could answer without
reading the whole file - and three times this month somebody answered it wrong.

## MRP and the Inventory page disagree about whether a DRAFT or SHIPPED order still demands stock [med, LEFT OPEN]

**Symptom** - not a report from staff; found by grep on 2026-08-13 while
collapsing duplicated constant lists. The "which sales orders are still live"
set exists in THREE sizes across two files and nothing reconciles them.

**Root cause (traced)** - `routes/mrp.ts` and `lib/so-stock-allocation.ts` treat
SIX statuses as terminal - CANCELLED, CLOSED, SHIPPED, DELIVERED, INVOICED,
DRAFT. `routes/inventory.ts` declares TWO sets of its own and neither matches:
`GET /reservations` (:1424) has FIVE, missing DRAFT; `GET /products` (:494) has
FOUR, missing DRAFT and SHIPPED. So a DRAFT order counts as open demand on BOTH
Inventory surfaces and as finished everywhere else, and a SHIPPED order does the
same on one of them - feeding committed_scheduled / available / surplus, the
numbers the Inventory page puts in front of staff.

The comment above `mrp.ts`'s set asserted the opposite - "the /inventory/
reservations SO_DONE drops its claims" - listing that endpoint as one of the
consumers already aligned when SHIPPED was added on 2026-08-01. It was never
checked because checking it meant opening a second file that had no link to the
first, and the second file turned out to hold two answers rather than one. Same
disease as the delivery-agent entry below: a citation standing in for a
mechanism.

**Fix (partial, deliberately)** - the SIX-status set is now
`backend/src/scm/shared/so-terminal-states.ts`, read by `mrp.ts`,
`so-stock-allocation.ts` (as `SO_TERMINAL_STATES_PGREST`, which renders the
PostgREST `not.in` string byte-identically) and eight audit scripts via
`scripts/lib/so-terminal-states.mjs`, pinned by
`tests/soTerminalStatesMirror.test.ts`. Fourteen copies across ten files, under
four names, became one. The false claim in mrp.ts's comment is corrected in
place.

**LEFT OPEN for the owner** - `inventory.ts`'s sets are NOT collapsed into the
shared file, and each now carries a comment saying so and why. Note there are
TWO of them in that one file: `GET /products` (:494) has four statuses and
`GET /reservations` (:1424) has five (it adds SHIPPED), so the page answers "is
this order open" differently in two places of its own. Widening either changes committed / available / surplus on a
page staff act on; that is a business decision about whether a DRAFT order
reserves stock, not a tidy-up. Those two are now the only survivors, and each
says in code where the others are.

**Lesson** - **when two lists of the same fact differ, find out which is right
BEFORE merging them.** The tempting move here was to import the shared set into
`inventory.ts` and call the class fixed. That would have silently changed
numbers on a live page under cover of a refactor - the opposite of the point.

**Ref** - PR sweep/duplicated-list-drift, 2026-08-13.

---

## The delivery agent's DO pipeline never counted COMPLETED, because it kept its own copy of the status list [med]

**Symptom** - the Delivery Agent brief's `doPipeline.byStatus` reported every
delivery-order bucket except COMPLETED. Nothing errored; the bucket was simply
absent, which reads identically to "there are none".

**Root cause (traced)** - `services/agents/delivery-agent.ts:539` declared its
own `DO_STATUSES` with the comment "the DO lifecycle (delivery-orders-mfg.ts
state machine)" and eight values. The state machine it names has NINE
(`delivery-orders-mfg.ts`, the `PATCH /:id/status` guard): the copy had lost
COMPLETED. `collectDoStatusCounts` issues one count per member of that list, so
a status missing from the list is a status never queried.

Found while sweeping the duplicated-constant-list class, and it is that class
exactly: two declarations of one fact, one of which is the authority and one of
which nobody re-checked. The same sweep found the DO "has shipped" set written
out by hand in ELEVEN files across two different spellings - five states, and the
same five plus COMPLETED - which is how `check-stock-truth.mjs` came to measure
delivered COGS over a set that excludes completed deliveries while
`check-doc-line-vs-movement.mjs` measures lines-vs-movements over one that
includes them, with neither output mentioning the difference.

**Fix** - `backend/src/scm/shared/do-shipped-states.ts` is now the only
declaration: `DO_SHIPPED_STATES` (the write trigger, COMPLETED deliberately
absent - nothing ships INTO completion, so listing it would arm a second
deduction on that hop), `DO_STOCK_OUT_STATES` (the read predicate, = shipped +
COMPLETED), `DO_PRESHIP_STATES` and `DO_STATUSES`. `delivery-orders-mfg.ts`,
`consignment-notes.ts`, `lib/reconcile-ledger.ts` and `delivery-agent.ts` import
it; the seven `.mjs` audits import `scripts/lib/do-shipped-states.mjs`, pinned to
the TS file by `tests/doShippedStatesMirror.test.ts` the way
`phoneNormaliseMirror` and `variantAxesMirror` pin theirs. The agent's pipeline
gains its COMPLETED bucket; every other call site keeps the exact list it had.

**Left, deliberately, for the owner** - `lib/reconcile-ledger.ts` scans the
5-state set, so a COMPLETED delivery order whose OUT never landed is invisible
to the ledger-integrity sweep. Widening it to `DO_STOCK_OUT_STATES` would change
what System Health reports, which is not a change to make while collapsing a
duplicated list. Noted in the code at the constant.

**Lesson** - **a comment naming the file it copied from is not a link to it.**
Both drifted copies said, in words, where the truth lived; neither could notice
when the truth moved. Import it, or pin it with a test - a citation is not a
mechanism.

**Ref** - PR sweep/duplicated-list-drift, 2026-08-13.
## BUG CLASS - unverified-completeness-claim: "every call site", unchecked [high]

**The shape** - a PR asserts it covered a whole POPULATION — "every desktop +
mobile call site", "all four arms", "system-wide", "everywhere" — and it did
not. The claim is prose, so nothing reads it: `tsc` cannot see it, vitest
cannot see it, and a reviewer who could check it would have to re-derive the
population by hand, which is the work the sentence was written to save them.
The claim is believed exactly because it is confident, and the half of the
population nobody enumerated keeps the old behaviour.

This is the FIRST-ORDER version of `optional-param-noop` below. That class is
about the compiler being unable to enumerate call sites; this one is about the
AUTHOR not enumerating them either, and saying otherwise.

**Worked example** - PR #1763, as traced in the entry below: thirteen call
sites, five untouched, the sentence "every desktop + mobile call site", and four
days of DIVAN ONLY lines demanding a mattress Gap. Note that the false claim
lived in the PR BODY, not the title — the title says only "DIVAN ONLY lines do
not require a mattress Gap". Any check that reads titles alone misses it.

**How common** - the detector in `scripts/lib/completeness-claim.mjs`, run over
all 3,231 commits reachable from `origin/main` **as of 2026-08-13**, fires on 30
titles (0.9%) and 438 title-or-body messages (13.6%): roughly one merged PR in
seven makes a claim of this shape. Before this gate, none of them was checkable.
Those figures are a snapshot of that date and will drift; re-run the detector
over `git log` before quoting them.

**The remedy** - `.github/workflows/completeness-claim.yml`. When a PR title or
body claims completeness, the body must carry a fenced block tagged
`enumeration` holding the command that ENUMERATES the population and that
command's output:

````
```enumeration
$ git grep -n "missingVariantAxes(" -- backend/src frontend/src
backend/src/scm/lib/so-variant-check.ts:56:    const missing = ...
...
```
````

CI **re-runs the command against the PR head and diffs the output**. That last
part is the whole design: a pasted list can be stale or invented, so the check
reproduces it rather than trusting it. The author's own sentence becomes a test,
and the diff names the members of the population the PR did not cover.

The command is never handed to a shell — a PR body is untrusted input written by
anyone who can open a PR. It is tokenised in-process and restricted to
`grep` / `rg` / `git grep` / `git ls-files` / `node -e` one-liners over this
checkout, with a per-program flag allowlist (`rg --pre`, `rg -z`, `rg -L`, and
any option before a git subcommand are refused by name), a scrubbed environment
so no secret is reachable, `--permission --allow-fs-read=<repo>` for node, and a
60s timeout. See the header of `scripts/check-completeness-claim.mjs`.

**The escape, and why it is loud** - a PR may carry the label
`completeness-not-claimed`. The check then passes, prints the offending phrases
back with their line numbers, and asks for the wording to be changed. It waives
the PROOF, not the problem: the sentence is still in the PR and a reader six
months from now will still read it as a promise.

**Ref** - `completeness-gate`, 2026-08-13

## BUG CLASS - optional-param-noop: an optional argument that decides something [high]

**The shape** - a parameter is OPTIONAL, and its ABSENCE changes an answer: a
gate, an exemption, a scope, a threshold, a default that is not neutral. Every
call site that does not pass it keeps the OLD behaviour, with no compile error,
no failing test, and no runtime signal. The rule exists, is correct, is tested,
and applies only where somebody remembered to reach it.

**Worked example, and why the class is written down** - `itemCode` on
`missingVariantAxes` / `missingConfirmVariantAxes`
(`backend/src/scm/shared/so-variant-rule.ts`). PR #1763 (2026-08-09) added the
DIVAN ONLY gap exemption keyed on it and declared "itemCode threaded through the
backend gate and every desktop + mobile call site". It was not: the parameter
arrived as `itemCode?: string | null`, and FIVE of the thirteen call sites that
existed at that commit did not pass it —
`git grep -n "missingVariantAxes(\|missingConfirmVariantAxes(" 4f30a063 -- backend/src frontend/src`
lists all thirteen, and these five carry only two arguments:
`scm/lib/so-confirm-gate.ts:116`, `scm/shared/inventory-adjustment.ts:38`,
`pages/scm-v2/SalesOrderNew.tsx:1419`,
`pages/scm-v2/SalesOrderNewFromProducts.tsx:273`, and
`vendor/shared/inventory-adjustment.ts:42`. (This entry said "two" until
2026-08-13; the count was never enumerated, which is the same failure as the
claim it describes.) The backend confirm gate — the one that blocks a Processing
Date — was among them and was not closed until #2072 on 2026-08-13, so those
lines went on demanding a mattress Gap for a product that has none for FOUR
DAYS. The
2026-08-10 exemption for adjustable beds / trundle combos / double-decker bunks
was half-applied through the same hole. `git blame` shows the two halves of one
ternary, one updated and one not, four lines apart. The full trace is in the
DIVAN ONLY entry below.

**The remedy** - make the parameter REQUIRED, so the compiler enumerates the call
sites. Where "no value" must stay expressible, the caller passes an explicit
`null`: that reads as a decision instead of an oversight, and the safe reading of
`null` is asserted. Precedent already in the tree: `scopeToCompanyId`
(`scm/lib/companyScope.ts`) takes the company id as a REQUIRED positional
argument "so a caller cannot omit it and silently get every company - this
codebase has pooled Houzs and 2990 data twice for exactly that reason".

**Where the class was found and fixed** (sweep 2026-08-13, `backend/src` +
`frontend/src`; 1,197 functions carry an optional parameter, 36 of them on a
predicate/gate, and these are the ones whose absence flips the decision toward
the permissive side):

- `resolveExpectedBatchBySoItem` (`scm/lib/dropship-batch.ts`) - `opts?.onMultiPo`
  defaulted to `'latest'`, the PERMISSIVE direction. `'block'` is audit H3, which
  exists to REFUSE an ambiguous batch: a sofa line bound to two live POs gets one
  PO's number stamped on the OUT while the GRN may arrive under the other,
  stranding the drop-ship COGS at 0 forever. Three of the five callers omitted it.
  Now a required `{ onMultiPo }`; every call site states which question it asks.
- `validateItemCodes` (`scm/lib/validate-item-codes.ts`) - the catalog-membership
  REFUSAL gate. Unscoped it admits a code that exists only in the other company's
  SKU master (17 codes collided on production 2026-08-01); the scoped pricing read
  then prices the line at 0 and the order dies as `pricing_drift`.
- `findServiceLineCodes` (`scm/lib/service-line-guard.ts`) - the SERVICE-on-return
  409 gate. `mfg_products.code` is unique per company, so unscoped the same
  payload is cleared or refused depending on whose catalog row is found first.
- `resolveCandidateDoIds` (`scm/lib/do-line-remaining.ts`) - the invoiceable /
  returnable DO picker's cross-company leak guard (added after the 2026-08-10
  audit). A leak guard a third caller can switch off by saying nothing is a
  default, not a guard.
- `validatePasswordStrength` (`services/passwordStrength.ts` and its identical
  `frontend/src/lib/` copy) - `email?` gated the username-as-password check.
  Omit it and `Weisiang329-Strong!` passes every other rule and is accepted.

**Fix** - all six parameters are now required (`null` still expressible, and its
meaning asserted). Backend + frontend typecheck clean; no live call site was
missing an argument, which is the point - the hole was open, not yet fallen into,
and the compiler now holds it shut. Each carries a test that fails WITHOUT the
parameter: `backend/src/scm/lib/optional-param-noop.test.ts` (two companies, same
payload, opposite answers), `dropship-batch.test.ts` ('latest' and 'block'
disagree on one fixture, so no default can be right for both),
`services/passwordStrength.test.ts`, and `product-lookup-company-scope.test.ts`.
The compile half is pinned with `@ts-expect-error`, which `npm run typecheck`
reports as TS2578 the moment a parameter is made optional again.

**Deliberately LEFT, with the reason** - an optional parameter is fine when its
absence is the SAFE (stricter) direction AND a comment says so. Verified and kept:
`assertNotMirrored(docNo, fn, c?)` (no context - guard stays ACTIVE, stated),
`isLocked(..., unlockOverride = false)` (default keeps the lock),
`scmAreaGuard(area, opts?)` (`openRead` / `readInheritsFrom` absent = stricter),
`checkSiOverRemaining(..., excludeByDoItem?)` (absent = tighter cap),
`resolveForcedUnitCostSen({ operatorCostSen? })` (falls to weighted-avg then
last-known, never 0), `validateItemCodes`'s own `opts.requireActive` (opt-in
tightening; DO/SI/DR keep existence-only semantics on purpose).
`meetsProcessingDatePaymentGate(..., companyCode?)` is LEFT although its default
is the looser 30%: `processingDateThresholdFor` argues the case in full and the
blast radius was measured on prod (of 63 live SOs with a Processing Date, moving
2990 to 50% newly refuses zero). Also left: the ~40 read loaders carrying
`companyId?: number | null`, which are governed by companyScope's documented
degrade rule and are a different sweep - listed in the PR, not touched here.

**Lesson** - **an optional parameter is a silent default, and a default on a gate
is a policy.** When a new fact starts deciding something, adding it as `x?:` says
"apply this rule where convenient". Required says "apply it everywhere, and the
compiler will tell you where everywhere is." The failure mode has no symptom at
the call site that is wrong: it looks exactly like code written before the rule
existed, because it is.

**Ref** - `sweep/optional-param-noop`, 2026-08-13. Origin: PR #1763 and the
`fix/variant-itemcode-required` follow-up.

---

## Every company-scoped WRITE in the system was missing its company predicate [high]

**Symptom** - no operator-visible symptom, which is the point. A caller switched
to Houzs could `PATCH` a 2990 work order, delete a 2990 invoice line, cancel a
2990 stock transfer or edit a 2990 payment by id, and the write succeeded
silently against the other company's books. Five instances were found and fixed
by hand on 2026-08-13 (payment-vouchers POST, grns PATCH, assr_print GET); this
entry is the sweep that measured how many more there were.

**Root cause** - a 2026-08-10 audit hardened the READS and stopped there, on the
reasoning that a scoped read gates the write that follows it. It does not. The
SCM supabase client is the SERVICE ROLE, so RLS is bypassed and nothing
re-evaluates ownership between two PostgREST round trips: the read 404s on a
foreign id, and the update that follows still names the row by primary key with
no `company_id` at all. Two more shapes hid in the same blind spot - a
parent-ownership predicate (`so_doc_no`, `purchase_invoice_id`, `trip_id`,
`work_order_id`) reads like a scope check but only proves the row is on that
DOCUMENT, not that the document is in your books; and a cross-company module
(TMS trips / delivery planning) was written with NO predicate rather than the
wider `scopeToAllowedCompanies` one, so a dispatcher granted one company could
edit the other's trips.

Measured 2026-08-13 across `backend/src/scm/routes` + `backend/src/routes`: 634
`.from()` write statements target a table carrying `company_id`; **294 of them
carried no company predicate on their own statement**.

**Fix** - the sweep put the predicate on the statement that writes, at the sites
reachable with a client-supplied id and no other company gate, and named the
deliberately-shared ones in comments so the next sweep does not "fix" them:
`currencies` (one global `code` PK - the master IS shared), the TMS fleet masters
(`lorries` / `lorry_maintenance` - one vehicle, one workshop history), and
`lorry_service_records`. `single()` was replaced with `maybeSingle()` wherever a
new predicate can legitimately match zero rows - `single()` renders that honest
404 as a 500.

**Lesson** - **when RLS is bypassed, "the read is scoped" is not a security
property of the write.** Every statement carries its own boundary or it has none.
Hardening a module's reads and calling the module done is how this survived an
audit that was looking straight at it - the audit asked "can this caller SEE the
other company's row", and the answer was no, while "can this caller CHANGE it"
was never asked. If a sweep fixes one half of a read/write pair, the other half
is not follow-up work, it is the same bug.

**Ref** - `sweep/unscoped-write`, 2026-08-13. Convention now in `CLAUDE.md`
(Coding conventions) and `docs/MULTICOMPANY-MODULE-MAP.md`.

## The Processing Date has surfaces that read it by NAME, and every one of them fails in silence [high]

**Symptom (latent, not yet fired)** - the owner, 2026-08-13, after saying it more
than three times: *"你确保你的 process 里,把 internal expected date、processing
date 和 process date 都直接整合变成一个,不要再搞多个了。因为每一次讨论到
processing date 的时候,你就有各种各样的 bug,原因就是因为你有太多个了。"* The DATA
was unified the same day (#2077 / #2079 moved 519 company-1 orders out of
`proceeded_at`; both companies now report zero split). What was left was the
naming - and a rename is only safe once the surfaces that read this date through
a STRING have been found, because those do not break loudly. Measured on
`origin/main` at 8b4853fa: 344 occurrences of `internal_expected_dd` /
`internalExpectedDd` across 73 files, 211 of `proceeded_at` / `proceededAt`
across 48. (The 269/161 in the brief was an undercount.)

**Root cause** - three separate mechanisms, one failure shape.

1. **The 2990 mirror drops what it does not recognise.** `lib/mirror-map.applyMap`
   is `for (const [k, v] of Object.entries(row)) if (m.destCols.has(k)) out[k] = ...`
   - destCols comes from the destination table's `information_schema`. An
   unknown key is not copied and nothing is raised. 2990 is a SEPARATE
   REPOSITORY on its own deploy schedule, and its pg_cron drainer can still be
   carrying rows queued before either deploy, so after a Houzs rename the old
   column keeps arriving, gets dropped, `/api/sync/so-mirror` returns 200, and
   the Processing Date stops appearing on every company-2 SO. The board, the
   edit lock, MRP and the AutoCount PDate push all read it.

2. **A stored payload keeps the key it was written with.** `scm.so_amendments.header_changes`
   is a jsonb authored at REQUEST time and read at APPROVE time, days later and
   across any number of deploys. `lib/so-revision.applySoAmendment` walks it and
   `continue`s on any key absent from the amendable allow-list; `routes/so-amendments.ts`
   gates the date-pair re-check AND the deposit gate on the same string literal.
   After a payload-key rename a pending amendment approves cleanly, audits
   cleanly, skips both gates and writes nothing at all. This is the worst of the
   three: a Processing Date that was requested, reviewed and signed off, and then
   silently did not happen.

3. **A name meaning three things.** `routes/delivery-planning.ts` stuffed a job
   leg date into a field literally called `internal_expected_dd` on the board's
   SYNTHETIC rows - ASSR service legs, manual DP jobs, PMS project windows. Those
   are not sales orders: no deposit gate, no supplier PO, no edit lock, so they
   have no processing date at all. That is a THIRD meaning of the name on rows
   that cannot have one, sitting in the same union as the real thing.

**What was NOT the problem, checked rather than assumed.** A queued AutoCount
outbox payload is composed in AUTOCOUNT vocabulary - `payload.body` is the
AcSyncService document (`DebtorName`, `DocDate`, `UDF.{BRANDING,VENUE,ToPONo,PDate}`,
`Details[]`), and the only ERP identifiers that survive into it are
`writeback` / `lineWriteback` / `fromDoc` / `selfDoc`, which name a table and
`doc_no` or `id`. No ERP column name for a business field is frozen in a queued
row, so an ERP rename cannot strand one and no payload migration is needed.
`mastersOf` reads the UDF block for `BRANDING` and `VENUE` only; `PDate` is a
date, not a dropdown master. The COMPOSE side is what breaks, and silently -
`SO_HEADER_COLS` is a string select list, `soEditHeader` reads a bare `Record`,
and `composeCreateSo` is handed `header as never`.

**Fix** - `backend/src/scm/shared/so-processing-date.ts` is now the ONE place the
name lives (it is not a fourth name: it invents no word, it exports the column
and payload key that already exist). Bound to it: the outbox select list (one
template literal + `as const` - supabase-js parses the select at the type level
and string concatenation with `+` widens to `string`, which comes back as
`GenericStringError`),
`soEditHeader`'s untyped read, and `AcSoHeader`'s field via a computed property
key. `mirror-map` gains `aliasCols`, applied ONLY when the old name is gone from
the dest table and the new one is present - so it is a proven no-op before a
rename and the fix the day of one, which is what makes registering it early
safe. `canonicaliseSoHeaderChanges` rewrites legacy stored keys onto today's on
both `header_changes` read sites. The delivery board's synthetic rows now send
`internal_expected_dd: null` and carry their leg date as `job_date`.

**Blast radius of the board change, checked before making it.** Nothing on the
board reads `internal_expected_dd` for a synthetic row: the "Internal Est."
column was removed in the owner's 2026-08-04 column pass, the HC fields drawer
(whose `procLockActive` reads it, and which would otherwise have called a
past-dated service leg "processing locked") is offered on `so` rows only -
`DeliveryPlanning.tsx` routes project / dp / assr rows to different menus - and
the mobile run-sheet's `effDateOf` reaches `effective_delivery_date` first, which
every synthetic row sets to the same leg date. So the field was write-only on
those rows and nulling it is behaviour-identical.

**Left loud on purpose.** `tests/scaleRouteDrift.test.mjs` `deepEqual`s a
hard-coded column list against the route's `HEADER` expression - it is the
tripwire and it is meant to fail; note it appends `, proceeded_at,
paid_total_centi, balance_centi_live` as its own literal, so retiring
`proceeded_at` needs an edit there too. `amendment-lane.classifyHeaderKey`
THROWS on an unknown key (submit-time only). `frontend/src/vendor/scm/lib/so-field-policy.test.ts`
parses the backend policy table by REGEX ON QUOTED LITERALS, so a renamer must
NOT replace those rows with a constant - the row would vanish from the parse.
`mfg-sales-orders`'s `SORT_COLS` silently falls back to `so_date` on an unknown
sort key, but the Processing Date is not in that set today.

**Still unbound, and named so the next person does not have to find them again.**
`so_internal_expected_dd` is a DERIVED response field stamped by
`routes/sales-invoices.ts` and `routes/delivery-orders-mfg.ts` and read as a
string by four frontends, including `MobileModuleList`'s
`pick(r, "soInternalExpectedDd", "so_internal_expected_dd")` - rename one end
only and a "Processing" column blanks with no error.
`SalesOrderDetailListing.tsx` reads `opt(r, 'internal_expected_dd')` off the
flattened header. The grid `key: 'processing_date'` in three lists is a SAVED
LAYOUT key persisted per user (migration 142) - it is already the unified name
and must not move.

## The word "processingDate" meant three different facts in the scan payloads, and an audit had already been fooled by it [medium]

**Symptom** - no runtime failure. The damage shows up as repeated bugs around
the Sales Order's Processing Date, and as documentation that confidently
describes the wrong thing: `docs/ocr-prompt-audit.md` C-2 stated that "scan-so
never reads a receipt's `paidAt`/swipe date", which was false when written.
scan-so has always read each receipt's printed transaction date; it just called
that field `processingDate`, so it did not read as a receipt date to the person
auditing it.

**Root cause** - one word, three unrelated facts, all reachable from the same
scan payload:

1. `ExtractedSlip.processingDate` - the HANDWRITTEN SLIP'S OWN DATE (the day the
   rep wrote the order). Read by the duplicate probe as `slipDate`, a local
   variable that already used the honest name.
2. `ExtractedPayment.processingDate` - a CARD TERMINAL'S PRINTED TRANSACTION
   DATE, coalesced in `planReceiptPayments` and clamped by `resolvePaidAt` into
   the payment-ledger row's `paid_at`. This one moves money to a date.
3. `processingDate` proper - the Sales Order's Processing Date,
   `scm.mfg_sales_orders.internal_expected_dd`, the factory-start date.

Nothing in the types, the prompt or the docs distinguished them, so the next
person picks whichever one autocomplete offers.

**Fix** - (1) is now `slipDate` and (2) is now `receiptTxnDate`, across the
Claude vision prompt (extraction rule 6, the `payments[]` rule, both OUTPUT
schema blocks), the `ExtractedSlip` / `ExtractedPayment` types, `normalizeSlip`,
the duplicate probe, `PlanReceiptPaymentsInput.slipProcessingDate` →
`slipDate`, the planner's `paidAt` resolution, the two tests, and the frontend
types the wire shape flows into (`ScanOrderModal`'s `ExtractedSlip` /
`ScanPrefill`, `ReconciledPrefill`, `MobileScanPrefill`). Only the third fact is
still called `processingDate`. `CARRIED_NOT_INVERTED` carries `'slipDate'`, and
its test now also asserts `'processingDate'` is NOT in the array, so the entry
cannot silently drift back to the overloaded name.

**Back-compat** - stored `so_scan_samples.extracted` / `corrected` blobs still
carry the old key, and the few-shot pool feeds those blobs into the prompt
verbatim, so the model can echo `processingDate` back. `normalizeSlip` reads
`slipDate ?? processingDate` and `receiptTxnDate ?? processingDate`. Without
that, a scan whose example pool predates the rename would lose its receipt date
and book `paid_at` at today.

**Deliberately NOT done** - no value was moved. The rename exposed a real
two-surfaces-one-field divergence, left exactly as it was with comments saying
so: `MobileNewSO` seeds the SO's Processing Date from `slipDate` (the day the
rep WROTE the slip), while desktop derives it from Delivery − 6 weeks and never
reads the slip's date. Both then invert the SO's Processing Date back into the
slip's `slipDate` when building a `corrected` blob. **All of it is latent, not
live:** `MobileNewSO`'s `scanPrefill` prop is never supplied by any
`setScreen({t:"new-so"})` call site (the live mobile path,
`createDraftFromPrefill`, sends `internalExpectedDd: null`), desktop's
`soScanPrefill` handoff has a reader and no writer, and the `corrected` blob is
inert because `slipDate` is in `CARRIED_NOT_INVERTED`. It fires the moment
someone re-wires either handoff - which this module has done before. Written up
in `docs/modules/scan-to-so.md` §2b rather than fixed inside a rename.

**Lesson** - **a name that fits three facts will eventually be read as the wrong
one, and the first casualty is the documentation, not the code.** The audit
entry that got this wrong was written by someone reading the prompt carefully;
the name defeated them. Renaming is not cosmetic when the old name is what makes
a reviewer stop looking.

**Ref:** `pd/overloaded-names`, 2026-08-13. Naming only - no behaviour change,
no migration, no API path change. **NOT verified:** no real slip was
round-tripped through a live model, so the vision model's compliance with the
renamed OUTPUT keys is reasoned from the prompt, not observed.

## The Processing Date answered to three names, and the column was the last one still disagreeing [medium]

**Symptom** - not a crash; a recurring class. Owner, 2026-08-13, after saying it
more than three times: *"你确保你的 process（就是整套系统）里，把 internal expected
date、processing date 和 process date 都直接整合变成一个，不要再搞多个了。因为每一
次讨论到 processing date 的时候，你就有各种各样的 bug，原因就是因为你有太多个了。
这三个 date 其实都是指向同一个东西。"* Every prior incident on this concept -
the blank Processing date on the SO read views (`#1179`), the legacy column drop
that blocked every deploy (`0189`/`#1191`), the two grant-loss outages behind it
(`0190`, `0191`), the amendment path that could set the date with no gate - has
the same shape: someone reached for the wrong one of several names.

**Root cause** - the DATA had already been unified on 2026-08-13 (519 company-1
orders moved out of `proceeded_at`; both companies report zero split). What was
left was vocabulary. One field was called `internal_expected_dd` in the database,
`internalExpectedDd` in the API payload, `so_internal_expected_dd` on SI/DO list
rows, and "Processing Date" by the UI label, the API's own `processingDate`
reads and every human in the building. 344 occurrences across 73 files, and the
next reader picks whichever one their file happens to use.

**Fix** - `migrations-pg/0284` renames
`scm.mfg_sales_orders.internal_expected_dd` to `processing_date` and does the
consignment twin identically, and the same commit renames every code reference,
the payload key (`internalExpectedDd` → `processingDate`), the row-stamp key
(`so_internal_expected_dd` → `so_processing_date`) and every doc that states a
present-tense fact about the column.

Three things had to be handled that a naive `ALTER TABLE` would have got wrong,
all of them verified against a PGlite replica rather than reasoned about:

1. **The view.** `scm.mfg_sales_orders_with_payment_totals` projects the column.
   The `ALTER TABLE` **succeeds** - Postgres re-points the stored rewrite rule by
   attribute number - but the view's own output column keeps the OLD name, so the
   base table has `processing_date` while the view still only answers to
   `internal_expected_dd`, and the first route that selects the new name off the
   view 500s. Closed with `ALTER VIEW … RENAME COLUMN`, a catalog rename: grants
   (service_role AND the Hyperdrive prod role that 0191 had to go hunt for) and
   owner were re-checked after and are unchanged. **A rename must never reach for
   DROP VIEW → CREATE VIEW** - that is the path that cost prod twice in July.
2. **The consignment collision.** `scm.consignment_sales_orders` carried BOTH the
   live `internal_expected_dd` and a dead legacy `processing_date` (mig 0153;
   0189 dropped the mfg twin and left this one). The rename fails outright until
   the dead one is dropped. The first draft of the migration dropped it with a
   plausible-looking `DROP COLUMN IF EXISTS` - which on a SECOND run would have
   dropped the freshly-renamed LIVE column and destroyed every consignment
   Processing Date. The replica's idempotency pass caught it; the guard now
   requires BOTH names to be present, i.e. a genuine collision to clear.
3. **The name is also stored inside data.** `scm.so_amendments.header_changes`
   is a jsonb blob keyed by the camelCase PAYLOAD name, and `applySoAmendment`
   skips any key not in `AMENDABLE_HEADER_FIELDS`. A Processing-Date amendment
   submitted before the deploy and approved after it would have been **silently
   dropped** - approve succeeds, the date never moves, the audit line does not
   even mention it. 0284 renames the key inside `header_changes`,
   `old_header_snapshot`, and `mfg_so_audit_log.field_changes` (where an
   un-migrated row would print the raw token `internalExpectedDd` instead of
   "Processing date").

`scm.apply_so_header_cas` (mig 0173) needed no change, and that was CONFIRMED
rather than assumed: it builds its `SET` list from `pg_attribute`. Worth knowing
for the next reader, because it fails quietly - it feeds the patch through
`jsonb_populate_record`, which IGNORES a key that is not a column, so a caller
left on the old key would not error, the date would just stop saving.

**Lesson** - **a concept with more than one name is a bug that has not fired
yet.** Unifying the DATA is only half; while the column, the payload key and the
label disagree, every new reader gets a coin flip, and this codebase paid for
that flip at least four separate times. Renaming is cheap, and the expensive part
is not the `ALTER TABLE` - it is finding the places the name is stored as a
VALUE (jsonb keys, audit rows) and the places a rename leaves *stale but not
broken* (the view's output column). Those are exactly the two that fail silently.

---

## Stat cards summed the server page while a stuck column funnel decided what was on screen [high]

**Symptom** - reported by the owner as two separate faults: *"this 2 PO could
not find"* (`PO2608-007`, `PO2608-005 revise`) and *"PO outstanding not
tally"*. Both POs were present, `SUBMITTED`, uncancelled. Every pill count and
every money total was independently correct against the database - 60 POs,
RM 164,349.70, pills 13 + 0 + 43 + 4 = 60.

**Root cause (traced)** - a DATE funnel was active on the table. The
per-column funnels are client-side **and persisted per user** (`dt:filters:*`,
added 2026-07-29 because *"filters kept resetting on reload"*). A filter set
once survives every reload, and past the first reload it no longer reads as a
filter - it reads as a broken list. The stat cards summed the SERVER page and
knew nothing about the funnels, so the screen showed **5 rows worth RM 9,112.50
under a card reading RM 164,349.70**, and the two "missing" POs - dated 08-03
and 08-10 - were three rows below the filter. Two contradictory numbers on one
screen are indistinguishable from a bug, which is exactly how it was reported.

**Fix** - `DataTable` gained `onFilteredRowsChange`, named and shaped to match
the `DataGrid` prop it mirrors so a page swapping components does not relearn
the contract (#2092, Purchase Orders). The same shape was live on Purchase
Invoices, Sales Invoices and Delivery Orders, so #2097 lifted the logic into
`hooks/useVisibleRows`, retrofitted Purchase Orders onto it rather than leaving
a hand-copied block in four pages, and every tile now describes the rows on
screen and says `Filtered` while a funnel narrows them. #2097 also corrected a
stale comment shipped in #2092 that claimed the test compared array identity
when the code compares length - length is right, because the table returns a
fresh array on every recompute.

**Lesson** - **persisting a filter changes what it means.** A filter the user
set this minute is understood; the same filter three reloads later is invisible
state that reframes every number beside it. Anything that survives a reload
must keep saying so on screen - which is what the `Filtered` label now does.
A second lesson, from the pair: the follow-up was needed only because the first
fix was written inline in one page. Fix the shape, not the instance.

**Ref** - PR #2092 and PR #2097, 2026-08-13. Entry written 2026-08-13 during a
documentation audit, not at merge time.

---

## The first sales order after the write-back went live was refused, and the documented remedy could not be applied [high]

**Symptom** - `scm.autocount_writeback` was switched to `"1"` on 2026-08-13 and
the first real order saved, `HC-SO-2608-001`, never reached AutoCount. It was
not lost: the outbox held one row, status `skipped`, reason

```
refused, nothing sent (ItemCodeError): 1 line(s) have no single AutoCount
ItemCode: line 1 - ERP item code '9028-1S' maps to 2 AutoCount items and the
document names no supplier to choose between them
```

**Root cause** - the refusal itself is correct and by design (D10: `9028-1S` is
`AMN-SF9028 SOFA` under supplier 400-A004 and `DSL-9028 SOFA` under 400-D004,
and a sales order names no creditor to choose between them). The defect is that
its documented escape hatch was unreachable. `resolveAcItemCode` checks
`opts.bindings` FIRST and returns immediately on a hit, so a
`scm.supplier_material_bindings` row is supposed to settle any ambiguity. But
`bindingsFor` was called with the RAW line codes -
`lines.map((l) => l.item_code)` at `autocount-outbox.ts:514` runs before D9 -
while the resolver runs AFTER D9, on a collapsed line whose `item_code` is a
SYNTHESISED `<model>-1S` (`autocount-sofa-collapse.ts:356`). So the query asked
for `9028-1A(LHF)` and `9028-2A(RHF)` and the lookup asked for `9028-1S`. The
two never met, and no binding row for a sofa model was ever fetched.

Consequence: the four sofa models whose ERP code is ambiguous in the cutover map
- 9028, 9058, 5152, 5080 - refused every sales order containing them, and no
amount of data entry could fix it. Measured: 117 of 1427 ERP codes in the map
are ambiguous; the other 113 are non-sofa, where the binding path did work.

**Fix** - `bindingsFor` expands its query with each line's sofa base code
(`splitSofaCode(code)` -> `<model>-1S`), so the map contains the key the
resolver will actually ask for. A no-op for non-sofa lines, where
`splitSofaCode` returns null. Regression test asserts the refusal without a
binding AND the successful send with one; it fails on the pre-fix tree.

**Lesson** - **when a pipeline rewrites its own keys, every lookup keyed off
them has to be built from the same stage.** The binding map was assembled from
pre-collapse codes and consumed post-collapse, one function apart, and both
halves read correctly in isolation. Nothing failed loudly: the outbox row said
`ItemCodeError`, which is a true statement about the collapsed code and gives no
hint that the override never had a chance to fire. The health check made it
worse by printing "line identity missing - backfill linked_ac_dtlkey" for it,
because it matched on the shared `refused, nothing sent` prefix that all four
refusal classes produce - fixed in the same batch.

**Ref** - `fix/sofa-binding-lookup` + `fix/outbox-health-skip-detail`, 2026-08-13

---

## R8 shipped with a route, hooks and a UI control, and without its table [medium]

Not a defect fixed so much as a defect FINISHED. The 500 half is the entry
below ("Combo Pricing 500'd on every load"); this records completing the
feature, because the next person will otherwise re-derive why a table appeared
for code that already existed.

**What was missing** - only `scm.sofa_combo_anchor`. The route
(`GET /anchors`, `PUT /anchors/:baseModel`, `loadComboAnchor`,
`mirrorAnchoredCombo`), the query hooks (`useSofaComboAnchors`,
`useSetSofaComboAnchor`) and the UI control
(`vendor/scm/components/SofaComboTab.tsx:245-253`) all came across from 2990 when
the module was vendored. The table did not. Verified on production 2026-08-12:
`to_regclass('scm.sofa_combo_anchor')` = NULL.

**Fix** - migration `0283_scm_sofa_combo_anchor.sql`, per-company from the start
rather than retrofitted the way 0087 had to convert four masters.

**Why applying it to a live business was safe** - an EMPTY table means no model
is anchored, `mirrorAnchoredCombo` is never reached, and every combo write
behaves exactly as before. Creating it is inert; behaviour changes only when a
human sets an anchor. That is what made this a migration rather than a rollout.

**The trap the migration header exists to prevent** - `sofa-combos.ts:452`
upserts with `onConflict: 'company_id,base_model'`, so the unique constraint must
be exactly that pair. Anything else and every `PUT` fails with `42P10`, not 404.
This is the SAME failure that shipped in `special_addons` earlier the same day:
0087 replaced a single-column unique with a per-company one, `/save` kept
upserting `onConflict: 'code'`, and every Save returned 500 for weeks. Writing
the constraint to match the caller was the whole lesson of that bug, applied
here before it could happen again.

**Lesson** - **when a module is vendored, the schema is part of the module.**
Code, hooks and UI crossed the boundary; one table did not, and nothing noticed
because the only symptom was a console line on a page that otherwise worked.

**Ref** - `feat/sofa-combo-anchor-table`, 2026-08-12

---


## Cross-tenant stock-transfer cancel, and a per-company report that returned both companies [high]

**Symptom** - two holes of the same class, found 2026-08-13 by an external
full-module code audit and each verified against the source before being touched.

1. `PATCH /stock-transfers/:id/cancel` had no company scoping anywhere: the
   before-read was `.eq('id', id)` and the CANCELLED flip was
   `.update(...).eq('id', id).neq('status','CANCELLED')`. A caller in company A
   holding company B's transfer UUID could cancel B's POSTED transfer — and the
   handler then calls `reverseMovements(sb, 'STOCK_TRANSFER', id, ...)`, so B's
   stock moved back. **This is a WRITE**, unlike the seven read-side `/:id/linked`
   leaks fixed the day before.
2. `GET /inventory/reconcile` called `reconcileLedger(sb)` with no second
   argument, so the operator-facing report returned BOTH companies' GRN, DO,
   transfer and consignment document numbers and statuses.

**Root cause (traced, not guessed)** - both are missed call sites, not missing
mechanisms. The 2026-07-22 owner audit scoped every sibling flow;
`stock-takes.ts:437-440` carries that fix with a comment naming this exact class
("the sibling /cancel /reverse /post already do requireActiveCompanyId; align")
— the stock-transfer cancel was simply never aligned. And `reconcileLedger`
(`scm/lib/reconcile-ledger.ts:46-51`) has ALWAYS taken `companyId?`, with its
own comment stating the operator endpoint is per-company "so the report can't
surface the other company's doc numbers"; only `systemHealth.ts:297` is meant to
run cross-company. The guard existed and the caller skipped it.

**Fix** - the cancel now takes `requireActiveCompanyId` and scopes BOTH the
before-read and the flip, returning `NOT_THIS_COMPANY` (404) on a foreign id;
`/reconcile` passes `activeCompanyId(c)`. Verified: backend typecheck clean,
companyScopeHardening passes (16 tests).

**What this is really about** - the day before, a documentation sweep found 7
cross-company leaks and I reported "7 bugs, none in the money path, this is not
a bad system". That was a statement about what MY question could find. A sweep
that asks "do the docs match the code" surfaces documentation defects; it does
not go looking for missed guards. The audit that asked "find the bugs" returned
**56 cross-company scope misses, 27 of them high**. Same codebase, same day,
different question. **The size of a finding set is a property of the question,
not of the system** — and a clean result from one lens must never be reported as
a verdict on the whole.

**Ref** - docs/staging-truth-and-map-refresh, 2026-08-13

---

## The route-locator generator read a mention of `/api/*` as an opening block comment [medium]

<!-- area: Repo tooling: tests, ratchets, generators -->
<!-- ^ TAGGED because no keyword table can place this one. It is about a
     GENERATOR, and it necessarily says "route" a dozen times, so the Fleet
     pattern (fleet|lorry|driver|trip|route|...) outscores the tooling one on the
     body even though both match the title once. Widening a pattern to fix it
     would drag in every entry that mentions a route. -->

**Symptom** - `docs/generated/route-locator.md` reported "986 route registrations
across 128 files". The tree holds 1,021 across 136. Eight whole route files were
absent, including `so-mirror.ts` (a pre-auth 2990 mirror) and `public-images.ts`
(a pre-auth R2 proxy) — exactly the kind of endpoint someone greps this artifact
to find.

**Root cause (traced, not guessed)** - `stripComments` in
`gen-route-locator.mjs` cut the `//` line comment LAST, after testing for a
`/*` block opener. So a line like `// Mounted at '/api/sync/so-mirror' ...
above the /api/* wall` had its `/api/*` read as an opening block comment;
`inBlock` then stayed true to end of file and every route below it vanished. The
five SCM routers found this way (`addons`, `maintenance-config`, `pos-cart`,
`public-images`, `so-mirror`) all carry a header comment mentioning a wildcard
path. Proved by re-running the generator's own `stripComments` over each file
and printing the first line it swallowed.

**Fix** - cut the line comment before looking for `/*`. Regenerated: 986 -> 1021
registrations, 128 -> 136 files.

**What this is really about** - the artifact was regenerated earlier the same day
and reported as repaired in `docs/staging-bench-rot-coe.md`. Regenerating proved
the generator RAN; nobody checked that its output matched the tree. A generated
file can be current and wrong at once, and "I regenerated it" is not the same
claim as "it is correct". The sibling check that would have caught it —
comparing the artifact's file list against the routers on disk — did not exist
and still does not.

**Ref** - docs/staging-truth-and-map-refresh, 2026-08-13

---

## Every /:id/linked endpoint resolved another company's documents [high]

**Symptom** - the Smart Buttons fan-out (`GET /:id/linked`) returned the linked
GRN / invoice / return / receive numbers for ANY document id, regardless of which
company the caller was in. Seven endpoints, one shape.

**Root cause (traced, not guessed)** - on every one of the seven SCM routers that
expose `/:id/linked`, the list and detail reads are company-scoped
(`scopeToCompany`) and the writes use the strict
`requireActiveCompanyId` + `scopeToCompanyId` pair — but the `/linked` read was
written as a bare `.eq('id', id)` with no scope at all. Two of the module guides
(`purchase-return.md` §6, `purchase-consignment-order.md` §7) claimed "every read
is company-scoped", which is how it survived review: the doc asserted a guard the
code never had.

The guide-verification sweep reported TWO leaky endpoints because two agents each
saw only their own router. Grepping `get('/:id/linked'` across
`backend/src/scm/routes` found **seven**: grns, mfg-purchase-orders,
purchase-consignment-orders, purchase-consignment-receives,
purchase-consignment-returns, purchase-invoices, purchase-returns.

**Fix** - all seven scoped. Five read an anchor row by id and now wrap it in
`scopeToCompany`; two (mfg-purchase-orders, purchase-consignment-orders) only fan
out by parent id, so they gained an explicit ownership check before the fan-out,
answering 404 — an unreachable row must not confirm its own existence.
Verified: backend typecheck clean; companyScopeHardening + assrCompanyScope pass
(24 tests); all seven re-grepped and each now carries `scopeToCompany` inside its
handler.

**Exposure** - low but real: ids are UUIDs, so this needed a leaked or guessed id
rather than enumeration. It returned document NUMBERS and ids, not amounts.

**Ref** - docs/staging-truth-and-map-refresh, 2026-08-13

---

## A voided service case still escalated, still emailed, and still counted as open [high]

**Symptom** - a case closed as `voided` (the terminal alt-outcome added
2026-07-29) kept behaving as if it were open: the daily 02:00 SLA sweep escalated
it and emailed its assignee, it inflated the "active backlog" tile and every
ageing bucket, and it sat in assignees' inboxes and overdue lists.

**Root cause (traced, not guessed)** - `voided` was added to the Stage union and
`statusForStage` maps it to "Closed" (`services/assr.ts:63-67,:88`), but every
consumer predicate still spelled "open" as `stage != 'completed'`. Grep found
**twelve** such predicates, not the two the audit first reported:
`assrEscalation.ts` (the escalation WHERE), `routes/assr.ts` x9 (backlog count,
period counts, stage-history join, per-creditor open/breached, unassigned,
breached tile, the three ageing buckets, per-agent breached) and
`routes/inbox.ts` x3 (my-cases, overdue, stuck-in-stage).

**Fix** - all twelve now read `stage NOT IN ('completed', 'voided')`. The
`= 'completed'` counters that define "closed" were deliberately LEFT ALONE:
folding voided into them changes what those tiles mean, which is a product
decision, not a bug fix. Verified: backend typecheck clean; assrCompanyScope,
assrSearch, assrCreateCategory and assrEscalation suites pass (21 tests); zero
`stage != 'completed'` left in `backend/src`.

**Ref** - docs/staging-truth-and-map-refresh, 2026-08-13

---

## Composed mail validated and stored Cc/Bcc, then never sent them [high]

**Symptom** - a staff member composes a mail in Mail Center with Cc or Bcc
recipients. The thread renders them as recipients, but they never receive the
mail. No error anywhere: the send succeeds for To.

**Root cause (traced, not guessed)** - POST /compose collects and validates
ccList/bccList (mail-center.ts) and stores ccAddresses on the message row, but
the sendEmail call passed only to/subject/html/text/purpose/from/replyTo/
companyCode/attachments - no cc, no bcc. The reply path passes both, so only
compose was affected. Found by the 2026-08-12 module-guide code-read sweep
(the guide claimed "a single Resend call carrying arrays" for all sends);
verified by reading the call site, then fixed.

**Fix** - compose's sendEmail now passes cc/bcc in the reply path's exact shape.
Verified: backend typecheck clean. Still open (own task): attachment-bearing
sends do not set outboxRetry:false, so a failed attachment send is re-drained
body-only by the */5 cron.

**Ref** - docs/staging-truth-and-map-refresh, 2026-08-12

---

## A COE named the wrong root cause because it quoted a repo comment instead of the run history [medium]

**Symptom** - the staging COE, the roadmap, `deploy-staging.yml` and a
BUG-HISTORY entry all stated that the Staging `CLOUDFLARE_API_TOKEN` had been
failing "since the day it was set, 2026-07-01". The owner rejected it on sight:
*"staging environment 怎么可能没有 set 过 cloudflare"*, *"之前 staging 都没问题的"*.

**Root cause (traced, not guessed)** - `deploy-staging.yml`'s trigger comment,
written 2026-07-31, inferred the start date from the secret's `updated_at`
(2026-07-01) plus the fact that the workflow was failing. Nobody opened the run
list. `gh run list --workflow deploy-staging.yml` shows Deploy (Staging)
succeeding on that same token for four weeks — last success run 30470280714,
2026-07-29 16:20 UTC — and the first failure, run 30518266259 at 2026-07-30
06:00, already carries `Invalid access token [code: 9109]`. The credential died
on Cloudflare's side; the GitHub secret was never touched.

The COE then quoted that comment as evidence and built a **"ruled out"** row on
it, marking "the token was working and was revoked recently" as REFUTED — the
one thing that was actually true. The contradiction was already inside the same
document (it stated the last good deploy as 2026-07-29, four weeks after the
date it claimed the token had never worked) and was explained away with an
invented earlier credential rather than chased.

**Fix** - corrected in all four places, with the old claim left visible rather
than silently overwritten, since a wrong "ruled out" row is what stops the next
person re-checking. Added as lesson 3 of the COE: *an inherited note is not
evidence — copy the CHECK, not the conclusion.*

**Ref** - `docs/staging-truth-and-map-refresh`, 2026-08-12

---

## The codebase-map generator died 11 hours after it was written, and froze the inventory for three weeks [medium]

**Symptom** - `docs/generated/codebase-map-facts.md` — the artifact
`CODEBASE-MAP.md` defers to precisely because generated numbers "cannot drift" —
claimed 122 route modules, 164 pg migrations and a highest migration of `0163`.
The tree held 135 route modules, 279 pg `.sql` files and `0281`. The file that
exists to be authoritative about migrations was missing 116 of them.

**Root cause (traced, not guessed)** - `gen-codebase-map.mjs:162` read
`backend/vitest.config.ts` by hardcoded name, to derive table 2's "read by
backend vitest" column. `#925` (2026-07-22 10:03) renamed that file to
`vitest.config.mts` as part of a toolchain upgrade. `#963` had written the
generator at 2026-07-21 22:28 — so it crashed with `ENOENT` from **eleven hours
and thirty-five minutes after it was born**, before writing any output. It had
produced exactly one generation, and that generation stood as current.

Nothing caught it because `audit:map` IS the same script with `--check`, so the
drift check crashed identically — and it is documented as deliberately NOT a CI
or deploy gate, for the good reason that a stale doc must never block a deploy.
The control case confirms the mechanism rather than contradicting it:
regenerating all three artifacts found `route-capability-matrix.csv` and its
summary byte-identical, because `audit:routes` gates them; the two that had
rotted, `codebase-map-facts.md` and `route-locator.md`, are exactly the two
nothing gates.

**Fix** - the generator resolves the vitest config across `.mts` / `.ts` / `.js`
and, if none exists, exits with a message naming the candidates instead of an
ENOENT stack — so the next rename says which filename to add rather than silently
freezing the inventory. Both stale artifacts regenerated. Class and lesson in
`docs/staging-bench-rot-coe.md`.

**Ref** - `docs/staging-truth-and-map-refresh`, 2026-08-12

---

## Staging carried no build stamp, so two weeks of green nightly E2E proved a two-week-old build [high]

**Symptom** - `Staging E2E (smoke)` reported `success` every night from at least
2026-08-04 to 2026-08-11, ~90s each, running real login / SO-list / company-
isolation proofs. Staging had not been built from `main` since **2026-07-29
16:20 UTC**, by then 775 commits and 59 production migrations behind. Every
assertion was true and none of them were about current code.

**Root cause (traced, not guessed)** - two independent facts had to meet.
(1) The Staging `CLOUDFLARE_API_TOKEN` **worked for four weeks and then died**:
last successful deploy 2026-07-29 16:20 UTC (run 30470280714), first failure
2026-07-30 06:00 (run 30518266259), already carrying `Invalid access token
[code: 9109]` while the GitHub secret's `updated_at` stayed 2026-07-01 — so the
credential was revoked or expired on Cloudflare's side. On 2026-07-31 `main` was
correctly removed from the trigger so the permanent red would stop training
people to ignore red — after which the workflow simply stopped being invoked,
because the `staging` branch it still triggers on last moved 2026-07-14.
(2) `staging-e2e.yml` also runs on a nightly `schedule`, which needs no deploy.
It pointed at the still-running old stack and passed. Nothing made the gap
visible: prod stamps `--var GIT_SHA:${{ github.sha }}` and has a watchdog
comparing it to `main` every 15 minutes, but `deploy-staging.yml` never added
the stamp, so staging `/health` answered `{"ok":true,"sha":null}`. Reproduced on
demand: run 31566944717, dispatched from `main` on 2026-08-12, passed typecheck,
tests and build and failed at `cloudflare/wrangler-action` — the token is still
bad.

**Fix** - `deploy-staging.yml` now stamps `--var GIT_SHA`, and `staging-e2e.yml`
reports the deployed commit against the commit it checked out, warning when they
differ or when the stamp is absent. Deliberately a warning, not a failure: the
suite proves an environment, and failing it while the deploy is paused would
recreate the permanently-red workflow the pause was right to remove. Restoring
`main` to the trigger is blocked on the owner issuing a new token. Full write-up
and the ruled-out theories: `docs/staging-bench-rot-coe.md`.

**Ref** - `docs/staging-truth-and-map-refresh`, 2026-08-12
## A shebang made a test suite unparseable on Windows only, and one error was counted as two failing files [low]

**Symptom** - `npx vitest run tests/soFeeLineRepairRow.test.ts` failed on every
local (Windows) run with a bare parse error and nothing collected:

```
FAIL tests/soFeeLineRepairRow.test.ts
SyntaxError: Invalid or unexpected token
Test Files 1 failed (1) / Tests: no tests
```

CI ran the same file green on every shard (run 31597783021, shard 4/4:
`✓ tests/soFeeLineRepairRow.test.ts (7 tests) 1160ms`). A full local `npm test`
therefore ended in failures that were not real - the corrosive part, because it
teaches people that local test results are noise.

**Root cause (traced, not guessed)** - not a byte-level defect in the test file,
which was the obvious reading and the wrong one. The test file is clean: no BOM
(first bytes `2f 2f 20`), UTF-8 round-trips byte-identical, no lone surrogates,
no control characters, uniform CRLF, and its only non-ASCII bytes are em-dashes
in comments.

The parse error was in the module it imports.
`backend/scripts/repair-so-fee-line-integrity.mjs` began with
`#!/usr/bin/env node`. On Windows vitest **inlines** that module and wraps its
source in a function before `vm.runInThisContext` - the stack lands in
`VitestModuleEvaluator._runInlinedModule` - so the `#!` is no longer at byte 0
and V8 rejects it outright. Linux externalizes the same module, where node strips
the shebang itself. Toolchain versions were identical and lockfile-pinned on both
(vitest 4.1.10, vite 8.1.5, @cloudflare/vitest-pool-workers 0.18.6): the only
variable was the OS.

Two things made this read as a byte problem. It dies at **load**, so it surfaces
as a failed FILE with zero tests, no assertion and no line number - exactly what
a bad byte looks like. And a full run reported **2 failed** for this single
error: vitest counts the failed suite and, separately, the `SyntaxError` arriving
as an Unhandled Rejection, which it attributes to whichever file was running when
it landed ("This error originated in ... It doesn't mean the error was thrown
inside the file itself"). So the hunt for a second corrupted file was a hunt for
something that did not exist.

**Fix** - delete the shebang. It bought nothing: every caller runs the script
through node (`so-fee-line-integrity.yml:79`, and the script header's own APPLY
example), never as an executable, and the file carries no exec bit. A comment
where the shebang was records why, so it is not re-added by someone matching the
~200 sibling scripts that do carry one. Verified: local Windows 7/7 tests pass,
the script still imports and evaluates under plain node, and the full local suite
is **264 files / 3766 tests, zero failures** - so there was never a second file.

The import graph of all 161 backend test files was swept for modules beginning
with `#!`; this was the only one. The other test-imported `.mjs` all live in
`scripts/lib/` and carry none - that is the existing convention for a module a
test consumes - and the `scripts/*.mjs` pulled in with `?raw` are read as text,
never parsed, so their shebangs are harmless.

**Lesson** - **a green CI and a red local run on the same commit is a statement
about the environment, not about the file.** Diff the environment first
(here: the OS), and read the error's own stack - `_runInlinedModule` said the
failure was in an inlined dependency, not in the suite named in the FAIL line.
Corollary for this repo: a `.mjs` under `scripts/` that any test imports must not
carry a shebang. Second corollary: one load-time throw can be counted as two
failing files, so a failure count is not a count of broken files.

**Ref** - #2062, `fix/vitest-shebang-parse-0812`, 2026-08-12

---

## Nobody with `scm.so.attribute_other` could create a Sales Order, and the picker they were told to use was empty [high]

**Symptom** - the owner (IT Admin) fills in a new Sales Order, the Salesperson
field reads "Lim (me)", and **Create Sales Order** returns
`422 A salesperson must be assigned before this order can be confirmed`. The
Salesperson dropdown contains exactly one option - that same "Lim (me)" - so
there is nothing else to pick and no way out of the refusal.

**Root cause (traced, not guessed)** - two independent faults that happen to
alias each other, both measured against PRODUCTION on 2026-08-12.

**(1) The roster is joined on a column that is almost always empty.**
`filteredStaffList` cross-referenced `scm.staff.email` against the emails of
Houzs users in the Sales / Management departments. On production:

```
scm.staff: 140 rows · 18 with an email · 102 with user_id
active rows: 102 · 98 of them have NO email at all
Houzs users in Sales/Management: 47
staff rows whose email matches one of them: 0
```

Zero. The filter's "falls open" guard only fires when the ALLOWED set is empty,
and it was not empty (47 users have emails) - so the filter ran, matched nothing,
and emptied the picker. `staff.user_id` is the link that does exist, and
`staff.ts` has always exposed it as `userId`; the frontend's `StaffRow` interface
simply never declared it.

**(2) An omitted salespersonId stamped NULL instead of the caller.**
`selfStaffMatch` looked the caller up by staff id, then email, then name - all
three against that now-empty list - so it missed, and the page rendered the
UI-only `__self__` sentinel. `SalesOrderNew.tsx:1555` drops that sentinel on
submit, *"so the backend keeps its own caller-based resolution rather than
choking on a fake id"*. But `mfg-sales-orders.ts:3427` read
`canAttributeOther ? (body.salespersonId ?? null) : callerStaffId` - the
caller-based resolution existed only on the self-scoped branch. An omitted id
therefore stamped NULL, and `collectSoConfirmProblems` refused the order.

**The cohort is inverted, which is why it went unreported:** a self-scoped
salesperson hits `: callerStaffId` and is fine. Only a caller holding
`scm.so.attribute_other` - owner and IT Admin, via `*` - could not create a
confirmed order at all.

**The IT Admin DOES have a staff row.** `Lim`, `user_id = 4`, active, `email`
NULL. The backend's `resolveOwnerStaffId` joins on `staff.user_id` and finds it;
only the frontend's three lookups missed it. The page was telling the user they
had no sales identity while the backend could see one.

**Fix** - match on `user_id` on both sides. `StaffRow` declares `userId`;
`selfStaffMatch` tries it FIRST (the same key the backend resolves by, so the two
can no longer disagree about whether the caller has a staff row); the roster
filter admits a staff row whose `userId` is in the Sales/Management cohort, with
email kept as the fallback for the 18 rows that carry one. And the create path
falls back to `callerStaffId` when `salespersonId` is ABSENT - an explicit null
still means null. That is not the phantom risk the surrounding comment guards
against: `resolveOwnerStaffId` returns the caller's REAL staff row, never the
bridge's pinned SYSTEM uuid.

**Correction 2026-08-13 (audit) - "an explicit null still means null" is not what
the code does.** The stamp is
`canAttributeOther ? ((body.salespersonId as string) ?? callerStaffId ?? null) : callerStaffId`
(`mfg-sales-orders.ts:3537`). `??` is nullish coalescing: it falls back on `null`
AND on `undefined`, and `body` is a raw `c.req.json()` bag (`:3299`) with no zod
step that could distinguish the two. So an explicit `null` falls back to the
caller as well. That is load-bearing rather than academic - MOBILE sends an
explicit null. `MobileNewSO.tsx:1090` maps its `__self__` sentinel to `null`,
while desktop `SalesOrderNew.tsx:1619` sends `undefined` (dropped by
JSON.stringify). Both work; only one of them works for the reason this entry
gives. The same wrong distinction is written into the route comment at `:3535`.

**Only the DESKTOP surface got the user_id key.** `MobileNewSO.tsx:1179`'s
`selfStaffMatch` still matches by email, then name - no `userId`, no staff id -
so the IT Admin (email NULL) still misses there and the page still seeds the
`__self__` sentinel. Mobile never had the roster filter (no `filteredStaffList`),
so its picker is not empty and the admin can pick themselves by hand; and the
backend fallback above means a submitted null is stamped correctly. But the
mobile confirm gate `!outgoingSalespersonId && !selfStaffMatch`
(`MobileNewSO.tsx:1772`) fires on exactly that state, so an attribute_other
caller who does not re-pick is still refused - client-side now, with a clearer
sentence. Desktop and mobile are one product (CLAUDE.md); this pair is still
split.

**Lesson** - **joining two systems on a human-typed field is a join that will
silently return nothing.** Both halves of this were the same mistake: email was
chosen as the key because it reads like an identity, while `user_id` - the
actual foreign key, present on 102 of 140 rows and already on the wire - went
unused. When a filter can empty a required picker, it needs to be keyed on
something the data is guaranteed to carry.

**Ref** - `fix/salesperson-roster-and-self`, 2026-08-12

---

## The codebase-map generator had been crashing for three weeks, so the map quietly rotted [medium]

**Symptom** - `docs/generated/codebase-map-facts.md` still claimed **122 route
modules** against a real 135, and **164 migrations / highest 0163** against a real
281 / 0281. Its own header says it is "regenerated from the tree so it cannot
drift", and `CODEBASE-MAP.md` points every new reader at it as the mechanical
layer that is safe to trust.

**Root cause (traced, not guessed)** - `gen-codebase-map.mjs:162` read
`backend/vitest.config.mts`. That file was renamed to **`vitest.config.mts`** by
#925 (the Vitest 4 / Vite 8 toolchain upgrade). Every run since has died before
writing a line:

```
Error: ENOENT: no such file or directory, open '...backend/vitest.config.mts'
    at read (backend/scripts/gen-codebase-map.mjs:50:13)
    at backend/scripts/gen-codebase-map.mjs:162:22
```

So this was never "nobody bothered to regenerate it". The generator threw, and
`audit:map` is **deliberately** not a CI or deploy gate (a stale doc must never
block a deploy - the sibling `audit:routes` gate jammed prod twice in one day).
Nothing was left to surface the crash, so the doc froze on 2026-07-21.

**Fix** - the config is located by trying `.mts` / `.ts` / `.js` in turn instead
of pinning one name, and throws a message naming the problem if none match.
Regenerating yields 135 route modules, 1038 endpoint registrations, 142 desktop
routes.

**Lesson** - **a generator that crashes is indistinguishable from a generator
nobody runs, and the artifact looks equally authoritative either way.** The
generated layer exists precisely so numbers cannot be wrong; that guarantee is
only as good as the generator still running. A doc-only generator should not gate
a deploy - but its failure has to reach somebody.

**Ref** - `fix/converter-hide-retired`, 2026-08-12

---

## The Fabric Converter listed 88 supersede tombstones as if they were fabrics [low]

**Symptom** - the owner opened the Fabric Converter and read `AVANI-01`
immediately above `AVANI-01 [merged into AVANI-01 on 2026-08-11]`, and the same
for AVANI-02..08, BO315-1-PEARL, BO315-11-METAL and dozens more - "why does my
code have this twice?". The `Fabrics (827)` badge counted them too.

**Root cause (traced, not guessed)** - the rows are correct. They are the losers
of the 2026-08-11 merge pass, kept with `is_active = false` and a note recording
what absorbed them, exactly as the never-delete-only-retire rule requires.
`GET /fabric-tracking` returns `is_active` but does not filter on it, and neither
the Converter page nor the Maintenance Fabrics panel filtered either - so 88 of
~830 rows were tombstones presented as live fabrics.

**Fix** - `useFabricTrackings` gains `includeRetired`, filtering in a `select` so
both views derive from ONE cached fetch. The Maintenance panel passes false; the
Converter hides them behind a `N retired hidden` checkbox.

**The default is a deliberate change to the 2026-06-12 spec**
(`fabric-queries.ts:164`: "rows stay on the converter"). That spec's intent -
retiring is not deleting, and the rows stay manageable - still holds: they are one
click away. But it was written before a merge pass put 88 tombstones in the list,
and a master list that reads as if every code is duplicated serves nobody. Flagged
for the owner to veto if the original default was load-bearing.

**Ref** - `fix/converter-hide-retired`, 2026-08-12

---

## Defect Done/Replace buttons never showed for Nancy — state-routing read the wrong payload path [high]

**Symptom** - owner, 2026-08-11, logged in as Nancy on a Pulau Pinang defect (SETIA SPICE CONVENTION CENTRE): the Done / Replace buttons did not appear, even though her My Pending correctly listed that event.

**Root cause (traced)** - the state-based reviewer split (PR #2050) made the frontend `canReview` read the project state from `detail.data.state` (desktop) / `data.state` (mobile), but the project detail nests the project under `detail.data.project` (`getProjectDetail` does `SELECT p.*`; the component already does `const p = detail.data.project`). So `state` was always `undefined` -> `inRegion` always false -> Nancy (`isNancy && inRegion`) never qualified, and Shukor (`isShukor && !inRegion`) even qualified on Penang. The BACKEND My Pending routing was correct (it filters on `p.state` in SQL, validated on prod), which is why Nancy saw the event but couldn't act.

**Fix** - read `detail.data.project.state` (desktop) / `data.project.state` (mobile). Two-token path fix on both surfaces.

**The class** - a nested payload field read one level too shallow returns `undefined`, not an error, and `region.has("")` is a quiet false, not a crash. When a new gate reads detail data, verify the shape (`detail.data.project.X`, not `detail.data.X`).

**Ref** - `fix/defect-review-state-path` 2026-08-11.

## Combo Pricing 500'd on every load, for a table that was never created here [medium]

**Symptom** - opening Products -> Combo Pricing puts
`GET /api/scm/sofa-combos/anchors 500` in the console every time. Nothing staff
do is blocked, which is why it went unreported: combos create and edit normally.

**Root cause (traced, not guessed)** - `scm.sofa_combo_anchor` **does not exist
in this database**. Verified against PRODUCTION on 2026-08-12:
`to_regclass('scm.sofa_combo_anchor')` returns NULL, while `sofa_combo_pricing`
is present and carries 270 rows for company 1 (173 of them supplier-scoped).
R8 (the anchor mirror) came across from 2990 with its route AND its frontend
query (`useSofaComboAnchors`, `staleTime: 30_000`) but without its table, so the
handler has 500'd on every Combo Pricing page load since it was vendored.

Combo writes survive by accident, not by design: `loadComboAnchor` destructures
`{ data }` and drops `error`, so a missing table reads as `null` = "not
anchored" and the write proceeds unmirrored.

**What migration 0114 already knew, and the half it got wrong.** 0114 records
the same to_regclass check and concludes "no migration needed; the route scoping
is a harmless no-op". The table fact was right. The conclusion was scoped to the
question being asked - whether the MULTI-COMPANY SCOPING change was safe, which
it was. Nobody asked whether the ENDPOINT works without the table.

**Fix** - `GET /anchors` returns `{ anchors: [] }` when, and only when, the error
is `42P01` (relation does not exist). An absent table means nothing is anchored,
which is what an empty list says; a 500 answers the caller's question no better.
Every other error still surfaces as 500, so a genuine permission or connection
fault cannot hide behind the branch. The feature stays dark. Creating the table
remains open and is the owner's call - see `docs/modules/combo-pricing.md` section 6.

**Lesson** - **"no migration needed" answers a schema question, not a code
question.** When a table is deliberately skipped, every route that names it has
to be checked, because the code that reads a table does not stop existing when
the table does.

**Ref** - `docs/sofa-combo-anchor`, 2026-08-12

---

## Removing a shared add-on from one Specials list retired it on the other [high]

**Symptom** - the owner opened Products -> Maintenance -> BEDFRAME -> Specials and
found SOFA add-ons in it (`5537 Backrest`, `Separate Backrest Packing`,
`Seat Add On 4"`). The only control the panel offers for that is **Remove**, and
using it would have retired those add-ons on the SOFA list too - silently, on Save,
with no warning naming the other category.

**Root cause (traced, not guessed)** - `special_addons.categories` is an ARRAY, so
one code can carry `['SOFA','BEDFRAME']` and appear in BOTH panels. The panel edits
only its own slice and rebuilds the whole-table snapshot as
`otherRows + draft` (`Products.tsx:4530-4534`), where
`otherRows = allRows.filter(r => !inCat(r) && !draftByCode.has(r.code))`. A shared
row is `inCat`, so it is excluded from `otherRows`; `removeRow` takes it out of the
draft; it therefore appears in NEITHER arm and vanishes from the snapshot. The
`/save` handler then deactivates every live code the snapshot omits (by design -
"retire, don't delete"), so the row goes `active = false` for every category at once.
`categories` has no editing control anywhere in the file - it is only read
(`inCat`), copied (`rowToSpecialInput`) and stamped on new rows
(`categories: [category]`) - so there was no non-destructive way to do what the
owner wanted.

**Fix** - Remove now branches on membership. A row carrying other categories is
DETACHED from this one (kept in new `detached` state with the category filtered out,
carried explicitly into the snapshot alongside `otherRows`) and the confirm names
where it survives; only a row belonging to this category ALONE is a real retire and
keeps the danger styling. No order is touched either way - the code stays live, so
every SO line naming it still resolves.

**Lesson** - **a delete control over a many-to-many membership must say which
relationship it is deleting.** The snapshot-and-retire mechanism was correct on its
own terms; the defect was a button labelled "Remove" that meant "remove everywhere"
on rows the panel itself only half-owned.

**Ref** - `fix/special-addons-save-sort-categories`, 2026-08-12

---

## Saving Specials 500'd on a constraint migration 0087 had already replaced [high]

**Symptom** - Products -> Maintenance -> Specials, press **Save**: the panel shows
"The system hit a problem. Please try again", and the console carries
`POST /api/scm/special-addons/save 500`. Editing individual rows and creating new
ones worked; only Save failed, so the whole effective-dated Save + History mechanism
was unusable on both the Bedframe and Sofa pools.

**Root cause (traced, not guessed)** - `special-addons.ts:362` applied the snapshot
with `.upsert(upsertRows, { onConflict: 'code' })`, but
`0087_master_codes_per_company.sql` had already run:

```sql
ALTER TABLE scm.special_addons DROP CONSTRAINT IF EXISTS special_addons_code_unique;
ALTER TABLE scm.special_addons ADD CONSTRAINT special_addons_company_code_unique UNIQUE (company_id, code);
```

The single-column unique on `code` no longer exists, so PostgREST's
`ON CONFLICT (code)` has nothing to match and Postgres raises `42P10 there is no
unique or exclusion constraint matching the ON CONFLICT specification`, which the
handler wraps as `500 apply_failed`. Only `/save` uses `onConflict`; POST uses a
plain `.insert()` and PATCH an `.update()`, which is exactly why Save alone broke.
The Save feature (mig 0032) predates 0087, and nothing re-read it when the
constraint was made per-company - so this has been broken since 0087 was applied,
and stayed hidden because Save is pressed rarely. A sweep of every `onConflict` in
`backend/src` found this to be the ONLY one naming a bare `code`; the rest already
key on `id` or a `company_id,...` tuple.

**Fix** - `onConflict: 'company_id,code'`, and the handler now resolves the company
with `requireActiveCompanyId` (409 when unresolved) the way PATCH and DELETE already
do. That second half is load-bearing, not tidiness: `company_id` was previously
stamped only `if (cid != null)`, and a NULL never conflicts in a unique index - so
with the corrected `onConflict` an unresolved company would have INSERTED a second
copy of every add-on instead of updating it.

**Lesson** - **a migration that changes a unique constraint must be followed to every
`onConflict` that names it.** `ON CONFLICT` is the one place where a constraint's
exact column list is written out in application code, and nothing type-checks it
against the database.

**Ref** - `fix/special-addons-save-sort-categories`, 2026-08-12

---

## The Resolution Method dropdown was the only place on the screen still speaking slugs [low]

**Symptom** - on one ASSR screen the same field read two ways. The solution
summary said `Supplier Service`, the status card said `Supplier Service`, the
printed document said `Supplier Service` - and the dropdown you actually pick
from said `supplier_repair`.

**Root cause (traced)** - `InlineEdit` rendered each option's slug as its own
label. Mobile already mapped its options through the shared `resolutionLabel`
formatter, so only the desktop control leaked the raw value.

**Fix** - `InlineEdit` takes an optional `optionLabel`; the resolution dropdown
passes `resolutionLabel`, so picker, summary, card and paper are one
vocabulary. The unknown-value fallback option goes through the same formatter,
so a legacy slug is worded rather than shown raw. The default is the identity
function, so every other `InlineEdit` dropdown is untouched.

**Lesson** - a display formatter applied on three surfaces out of four is not a
formatter, it is a convention waiting to be broken. The one surface that skipped
it was the only one users type into.

**Ref** - PR #2040, 2026-08-11. Entry written 2026-08-13 during a documentation
audit, not at merge time.

---

## Two master-data foreign keys the write-back could never satisfy [high]

**Symptom** - on the live book, `/create-po` returns a bare 500 and the whole
purchase order is lost. Separately, opening a brand-new SKU fails, so the first
ERP document naming a new product would never reach AutoCount. Neither is
visible in the HTTP response: both are `500`, and the constraint name only
exists in `C:\Temp\ac-sync-service.log` on the host.

**Root cause (traced, not guessed)** - two different foreign keys, one shape.

1. **`FK_PO_PurchaseAgent`.** A purchase order's agent lives in
   `dbo.PurchaseAgent`, a **different master** from the sales agent, reached
   through a different SDK command. `ensure-masters` only ever opened SALES
   agents, so it reported `agent:OTHERS` as **already existing** while
   `/create-po` was being refused on that very value - the report was true and
   irrelevant. Found by reading the service log after the QA run of 2026-08-12;
   `AutoCount.GeneralMaint.PurchaseAgent.PurchaseAgentCommand` was found by
   reflecting the installed assemblies, because `sdk-api-reference.txt` does not
   mention PurchaseAgent at all.
2. **`FK_Item_ItemGroup`.** `ItemGroup` is a foreign key, not a label. The
   importer set it from the payload and the payload never carries one, so every
   new item was refused. Proved by calling `/ensure-masters` twice: the same
   item fails with `FK_Item_ItemGroup` and then succeeds with a group supplied.

**Fix** - `ensure-masters` accepts a `PurchaseAgents` list and opens it through
`PurchaseAgentCommand`; `mastersOf` routes the agent by whether the payload
carries a `CreditorCode`, which is the one field only a purchase document has.
Items default to `ItemGroup = OTHER`, which exists in `AED_HOUZS` for exactly
this. Three regression tests cover the routing. The whole foreign-key chain, and
the values known to exist, are now in `docs/modules/autocount-writeback.md`
section 7m so the fifth one is a lookup rather than another discovery.

**What this is really about** - these are the **third and fourth** foreign keys
found this way, after `FK_SO_SalesAgent` and `FK_SODTL_Location`. Each was
invisible until the previous one was satisfied, so every "fixed it, retry" bought
exactly one attempt. The evaluation book enforced none of them.

**Lesson** - **"the master exists" is only true about the master you asked
about.** A sales agent and a purchase agent share a name, a meaning and nothing
else. When a lookup says a dependency is present and the dependent call still
fails, check that you looked in the same table the constraint points at.

**Ref** - `fix/ac-deploy-verify-db`, 2026-08-12

---

## /health was the only gate on a service swap, and it opens no database [high]

**Symptom** - the AutoCount write-back service was rebuilt and swapped on the
host. `/health` answered `{"ok":true,"book":"AED_HOUZS"}` and the deploy
reported DONE. The service was in fact unable to reach the account book at all:
the very next real request came back **500 `Error Locating Server/Instance
Specified`**. Nothing staff-facing broke only because the write-back toggle is
still off.

**Root cause (traced, not guessed)** - `/health` answers from CONSTANTS. It
proves the process is listening and which book it was COMPILED for; it opens no
session, so it cannot say whether the connection line works. `deploy-on-host.ps1`
used it as the sole post-swap gate, so a build carrying a server name the host
cannot resolve passed verification. The name came from `setup.json`
(`192.168.1.198\A2006`) while the host actually resolves `.\A2006` - the value
LINQPad has been using all along. Proved by calling `/ensure-masters` on the
host with an empty payload: 500 with that message, while `/health` stayed green.

**Two things the same investigation turned up.** `setup.json` names database
**`AED_DEMO`**, not `AED_HOUZS` - a build that trusted it would point the live
write-back at the wrong book, which is the same shape as the earlier
`DONE - built against AED_TESTING`. And the SQL bridge (`tempdb.ac_src_bridge`),
documented as holding "the CLEAN source", holds **31,897 chars with no
`/ensure-masters` and no fail-closed auth** - it is stale, and a rebuild from it
would have shipped the old service again.

**Fix** - the post-swap gate is now `/health` AND `/ensure-masters` with an
empty payload, which opens the session on its first line and creates nothing; a
non-200 rolls back automatically and prints the `-Server` hint. The deploy also
asserts the PORT before it builds: fixing the BEL byte made
`C:\Temp\ac-svc-port.txt` readable for the first time, so a stray file carrying
the old 8899 would now silently move the service off the port cloudflared
fronts - the script refuses rather than swapping. Verified: dry run with no port
file proceeds on 8900, dry run against a file saying 8899 refuses and swaps
nothing.

**Lesson** - **a health check that shares no code path with the work is not a
health check.** Ours proved liveness and a compile-time constant, and was
trusted for connectivity it never touched. Gate a deploy on the cheapest call
that actually exercises the dependency.

**Ref** - `fix/ac-deploy-verify-db`, 2026-08-12

---

## A BEL byte in the service's port path, and the escape sequence that would have killed the rebuild [medium]

**Symptom** - none, and that is the point: nobody can see it. The AutoCount
write-back service documents its port as "a FILE, not a constant" so it can be
moved without a recompile, after 8899 turned out to be pinned inside `http.sys`
by an orphaned listener. The file it reads has never once existed.

**Root cause (traced, not guessed)** - `AcSyncService.cs` carried a raw **0x07
BEL byte** where `\a` belongs. `grep` and every editor render `C:\Temp` + BEL +
`c-svc-port.txt` as `C:\Tempc-svc-port.txt`, which reads as a missing backslash
and invites a "typo" fix; `od -c` is what showed the byte. In a C# verbatim
string that BEL is part of the path, and BEL is not a legal Windows filename
character, so `File.Exists` can never be true and the port silently falls back
to 8900 forever. Three occurrences: the header comment and both halves of the
`Url` initialiser. `docs/autocount-migration-record.md` carried the same wrong
path as ordinary text, so the doc and the code agreed - on a filename that
cannot exist. **The API key path one line below was clean**, which is the only
reason the service authenticates at all.

**A second defect found by automating the same procedure.** The connection line
is substituted into ORDINARY C# string literals, so a named SQL instance
(`HOST\INSTANCE`) is an unrecognised escape sequence: **CS1009 at all three
sites**. The documented `-replace` recipe has no escaping step, so a hand-written
`dbline.txt` compiles only if whoever wrote it happened to double the backslash.
Found by dry-running `deploy-on-host.ps1` with a named instance.

**Fix** - the BEL bytes replaced with a literal `\a` and the doc's table
corrected. New `deploy-on-host.ps1` does the whole rebuild in one command,
escapes backslashes and quotes when it assembles the line from `setup.json`,
**refuses to swap an exe that did not compile**, **rolls back by itself** if the
new exe does not answer `/health` with the expected book, and deletes the
password-bearing `AcSyncService.build.cs` in a `finally`. Deploy doc now leads
with the script and records the CS1009 trap for the manual path. Verified: clean
compile at 46,592 bytes before and after the fix, and a dry run against a
`DRYRUN\SQLEXPRESS` instance that fails CS1009 unescaped and compiles escaped.

**Lesson** - **a path that reads as a typo may be a byte.** Two reviewers and a
documentation pass agreed with a filename no filesystem could hold, because
every tool that renders text renders a BEL as nothing. When a file "does not
exist" and the path looks right, dump the bytes.

**Ref** - `fix/ac-host-deploy`, 2026-08-11

---

## The fabric rename split the code away from its price tier, and cut six colour numbers in half [high]

**Symptom** - none visible, twice over. Staff saw the Fabric Converter still
showing `AM275-2-BEIGE` with an empty Series column after the library had been
tidied; the owner asked "两边一定要一样的啊". Nothing on screen said that 492
document lines had stopped resolving to a price tier, or that six colours were
now called things like `NOVENA-100` with a colour name of "3".

**Root cause (traced, not guessed)** - three faults, one shape: a rule written
twice, and a table edited on the wrong side.

1. `scm.fabric_trackings.fabric_code` and `scm.fabric_colours.colour_id` are THE
   SAME STRING by construction - `fabric-tracking.ts:74-82` mints a tracking row
   and mirrors it into the library. The Converter is the master. The 2026-08-11
   normalisation edited the library and repointed 494 live `variants.fabricCode`
   values onto the new strings, leaving the master untouched. That column is the
   join key for the price tier (`mfg-sales-orders`, `mfg-purchase-orders`,
   `consignment-orders`, `po-pricing`, `mfg-pricing-recompute`), and a miss does
   not error - `mfg-sales-orders` says so in its own comment: every fabric falls
   to the PRICE_2 default and "a failed read would pick a REAL combo at the WRONG
   tier and write that cost to the header as fact". Measured on production: 492
   orphaned lines across 76 codes (run 31478813584).
2. The colour number was read as `\d{1,3}`. `NOVENA-1003` therefore parsed as
   colour 100 with a NAME of "3", and run 31470428224 wrote `NOVENA-100` labelled
   `NOVENA-100 3` - plus LAMB VELVET-2005, GORGE-3003, POLAR-5002, MERINO-4005
   and MERINO-4010.
3. `align-fabric-trackings` then kept its OWN copy of the series rule, still at
   `\d{1,3}`, so after (2) was fixed its plan still called `NOVENA-1003`'s series
   `NOVENA-1`. The same duplication also made it match tracking codes by
   flattening the LABEL, which can never match a brand prefix - all 303 of
   `ARMANI ...`, `AGAZZI ...`, `HIVE ...` were reported as "the library does not
   know this code" when the library knew every one.

**Fix** - #2018 widens the number to four digits and refuses a "name" made only
of digits, because that is always a number the split cut off;
`repair-split-colour-numbers.mjs` restored the six written rows by fingerprint
(label = code + digits only), 0 live lines were on them. #2032 moves the whole
rule into `lib/fabric-code.mjs` so no script keeps a copy - two copies caused two
of the three faults. #2033 casts the tier columns (`scm.fabric_price_tier` is an
enum; a bound string is text, and the first apply died on it and rolled back) and
matches through the shared parser, so a brand prefix resolves in one step. #2009
then aligned the master: 386 codes rewritten, 220 series filled, 88 duplicates
deactivated (never deleted - `fabric_trackings.is_active`), 122 master rows
created for library colours that had none. Orphaned lines 492 -> 15, no code
carried by more than one active row, no library colour without an active master
row (run 31489281011).

**What caught it** - reading a `MODE=plan` output against production before every
apply. Fault (1) surfaced because the owner looked at the Converter screen; (2)
and (3) surfaced in plans that would otherwise have written them, and (3) twice.
The pattern to keep: these scripts are plan-by-default, and the plan is meant to
be read, not skimmed.

**Ref** - #2009 / #2018 / #2032 / #2033, 2026-08-11.

## Adding a SOFA to an existing order queued nothing for AutoCount - an early return past the hook [high]

**Symptom** - none visible: the order saves, the compartments appear, and the
account book simply never hears about them. It would have surfaced after go-live
as sofas silently missing from AutoCount on orders that were otherwise syncing.

**Root cause (traced, not guessed)** - `POST /:docNo/items` has TWO insert paths.
The ordinary one inserts a row and calls `queueAcSoEdit`. The SOFA branch inserts
its N compartment rows, reconciles the free gift, re-derives the delivery fee,
records the audit row, recomputes allocation - and then
`return c.json({ item: firstRow }, 201)`. There is no `queueAcSoEdit` anywhere
between the insert and that return.

The same shape as the `convertSosToPosCore` gap already in this ledger: an early
return past the hook. It survived `tests/autocountWritebackWiring.test.ts`
because that suite greps the ROUTER FILE as a whole for its anchors, and the
anchor is present - in the other branch.

**Fix** - the sofa branch queues an edit before returning, declaring every row
the insert returned so the whole build can go as new lines. The pin is a test
that slices the branch out of the router source and asserts the call is INSIDE
it - a file-wide grep cannot tell one branch from another.

**Ref** - feat/ac-ensure-masters, 2026-08-11.

## Every ERP-created Sales Order and Purchase Order would have failed in the live account book, on a foreign key nobody had hit [high]

**Symptom** - none yet, and that is the point: the write-back has never been
switched on, so this would have surfaced as EVERY create failing on the first
day of go-live, on the owner's own P0 slice.

**Root cause (traced, not guessed)** - read off the AutoCount host's own log,
which the cutover file server happens to publish:

```
2026-08-11 11:54:59  /create-so  (no Location on either line)
  -> AutoCount.Data.ForeignKeyException  FK_SODTL_Location
     "dbo.Location", column 'Location'
2026-08-11 11:57:43  /create-so  (Location "KL" on both lines)  -> saved
```

`AcSyncService`'s create path applies the key unconditionally
(`Set(() => d.Location = Str(it, "Location"))`) and `Str` turns an ABSENT key
into `""`, which is not a row in `dbo.Location`. Meanwhile the ERP composer
could not send a location at all: `SO_ITEM_COLS` and `PO_ITEM_COLS` never
selected `warehouse_id`, so every `ErpLine.location` was `undefined` and the
omit-don't-null rule (correct for an edit) dropped the key on every create.

The omit rule arrived with a comment asserting it was "a NO-OP on the create
routes ... so one rule serves both". The two paths need OPPOSITE rules, and the
comment was wrong in the direction that fails every create.

**Fix** - the composer resolves a location per line: the line's own
`warehouse_id` -> the `scm.warehouses` CODE -> `LOCATION_MAP`; then the
document's `sales_location` (a PO has none, its ship-to warehouse being per
line); then REFUSES with `MissingLocationError`, a visible skipped row, rather
than sending `""`. An edit still omits the key, because a blank would erase the
location the account book owns. `composeSoState` / `composePoState` now compose
`create` LAZILY - an edit builds the same state object, and eagerly composing a
create it will never send refused the edit for the create's reasons.

**Mutation-verified**: removing the refusal fails exactly the two tests that
assert it; removing nothing else changes. 84 tests pass across the two suites.

**Ref** - feat/ac-writeback-sofa-collapse, 2026-08-11.

## The AutoCount write-back could not express an edit, a cancel or a create for most of the ERP's documents, and the gaps were invisible [high]

**Symptom** - the owner's go-live criterion 1 is "every document type syncs to
AutoCount - SO, PO, DO, GR, PI, SI - on create, convert AND edit, not just
create". A matrix of the 24 cells (6 doc types x create/convert/edit/cancel)
found 10 wired, 4 partial, 9 missing. `AcSyncService` could edit all six types
and cancel all six; the ERP could ask for two edits and four cancels. Nothing
reported the difference, and one test's NAME asserted the opposite.

**Root cause (traced, not guessed)** - four separate causes, not one:

1. **A type narrowing.** `enqueueEdit`'s `docType` was declared `'SO' | 'PO'`
   (autocount-outbox.ts) and `composeEdit`'s first parameter likewise, so
   `case "DO"`, `"IV"`, `"GR"` and `"PI"` in `AcSyncService.Edit()` were fully
   built and unreachable from the ERP. `AcSyncService.Cancel()`'s `"IV"` and
   `"PI"` cases had never been called by anything.
2. **A missing column.** An edit addresses a detail row by AutoCount's `DtlKey`,
   and 0273 put `linked_ac_dtlkey` only on the two line tables the ERP can
   CREATE in AutoCount. The four downstream line tables had no column to read a
   key from, so every downstream edit would have been refused for a reason that
   looked like data and was actually schema.
3. **A guard with no else.** `convertSosToPosCore` - the converter behind
   `POST /from-sos` AND the MRP agent's `createDraftPosFromPicks`, i.e. every PO
   the ERP raises from a Sales Order - recorded its audit row and queued
   nothing. It was not covered by the confirm-time hook either, because it
   writes `'SUBMITTED'` directly whenever a warehouse resolves, so
   `PATCH /:id/confirm` never runs for these. The same shape appeared four more
   times: a parentless DO / GRN / SI / PI fell out of an `if` writing no outbox
   row at all, not even a `skipped` one, so a document that can never exist in
   the account book left no trace of the fact.
4. **A test that asserted a set and checked a list.** `tests/autocountWriteback
   Wiring.test.ts`'s "every SO mutation path queues an edit" and "every PO
   mutation path queues an edit" each pinned a handful of named anchors. Five
   real mutation paths were outside them: the admin price `override` (which
   writes `unit_price_centi`, an AutoCount field), `applySoAmendment` and
   `applyPoAmendment` (the sanctioned ways to change a CONFIRMED document),
   `bulk-supplier-date`, and `convert-from-so`.

**Fix** - migration 0280 adds `linked_ac_dtlkey` to the four downstream line
tables; `AcDocType` replaces the two narrowings; `queueAcDoEdit` /
`queueAcGrnEdit` / `queueAcSiEdit` / `queueAcPiEdit` are wired to all sixteen
downstream header/line routes; SI and PI cancel are wired inside their atomic
CANCELLED branches; the five uncovered SO/PO paths queue an edit; the SO->PO
converter queues a create gated on the status literal that was inserted; and
`recordParentlessCreate` writes a visible `skipped` row for the four document
shapes AutoCount cannot hold. Every edit is an EDIT - no path expresses a change
as delete-and-recreate, which would also destroy AutoCount's own `DocTransfer`
links.

`tests/autocountWritebackCells.test.ts` is built the other way round from the
test that failed us: it READS the `case` labels out of `AcSyncService.cs`'s
`Cancel()` and `Edit()` switches and asserts the ERP asks for exactly that set,
so a service capability the ERP cannot reach fails automatically. **17 of its 18
tests fail against the pre-fix tree; 18 of 18 pass with the fix.**

**Ref** - feat/ac-writeback-remaining-cells, 2026-08-11.

## A console was reported missing a seat height, which it cannot have [low]

**Symptom** - owner, 2026-08-11: *"divan only 没有 gap 的 你也可以看有些 sku 是没
有的"*. Three lines (`HC-PO-009553`, `HC-PO-000596`, `HC-SO-012736`) reported
`missing Seat Height` on a `-Console` piece.

**Root cause** - `missingVariantAxes` already exempts `gap` for DIVAN ONLY and
the whole base block for a divanless frame, but had no notion of a sofa piece
with no seat. A console is the table BETWEEN two seats. The AutoCount sketch
proves it rather than assuming it: on `PO-009553` both seat boxes carry a figure
(26" and 32") and the console box is deliberately blank.

**Fix** - `isSeatlessPiece`, matching `CONSOLE`/`CT` on the compartment suffix,
exempts `seatHeight`. Deliberately narrow: **STOOL is not exempt**, because a
stool is something you sit on and no line reports one missing - exempting it
would be a guess with no case behind it.

**Not changed, and worth a follow-up:** the app's own confirm gate
(`src/scm/shared/so-variant-rule.ts`) still asks an operator for a console's
seat height. Pre-existing, but it is the same rule and should move together.

**Lesson** - "the field is empty" and "the field does not apply" look identical
in a completeness count. Three of the remaining gaps this week were the check
asking for something the product does not have: a STOOL's compartment, and now a
console's seat.

**Ref** - fix/console-has-no-seat, 2026-08-11.

## The sofa completeness checks failed a whole build on one line's remark, and over-reported by a third [med]

**Symptom** - `COMPARTMENT` read 32 incomplete on purchase-order sofa and 41 on
sales-order sofa, with 30 lines in scope flagged "placeholder, never decoded".
Chasing them found documents that are demonstrably correct.

**Root cause (read from the data, not the message)** - both checks test
`build.some(r => /SOFA UNPARSED/.test(r.remark))` and then fail EVERY line of
that build. The remark marks the one LINE the decoder could not read, not the
build. `HC-PO-009018` is correctly decomposed to `1A(LHF)+1NA+1A(RHF)` and was
failed only because the same document also carries a `9028-STOOL`, whose own
Desc2 is `BO315-21/32" X 49"` - a dimension, with no structure to parse and none
needed, because STOOL IS its compartment. `HC-PO-000136` is the same shape.

Classified over production: of the 30 flagged lines, **19 are a bare `-1S`** (the
real defect - a multi-piece sofa imported as one line), **4 are a real named
accessory piece** (STOOL / Console / DB) and **7 carry a real compartment**
(`1A(LHF)`, `2A(LHF)`, `L(LHF)`, `1ABOX(LHF)`). Eleven of thirty were the
check's own doing.

**Fix** - only a line that fell back to the bare `1S` placeholder counts as
undecoded, and only that line is flagged, not its siblings. COMPARTMENT moved
32 -> 15 (PO) and 41 -> 22 (SO) with no data change of any kind: the same rows,
counted correctly.

**Lesson** - a per-line fault flagged at build level inflates by the build's
width, and the inflation looks exactly like a data problem. Before repairing
what a check reports, confirm the check is counting the thing it names - the
first version of this session's own backfill made the identical mistake in the
opposite direction, reporting 338 held colours because it recorded a hold before
asking whether the line had a blank axis at all.

**Ref** - fix/sofa-unparsed-false-positive, 2026-08-11.

## A sofa line's colour was never written, because nothing swept sofa and the parser could not read an unlabelled code [high]

**Symptom** - the owner, 2026-08-11: *"可是我明明之前已经整理了很多次，为什么还是没有
记录成功呢？"* The fabric library had been tidied repeatedly and sofa lines still
read with no colour: `COLOUR` complete 175/219 on purchase-order sofa and
218/274 on proceeded sales-order sofa, against bedframe's 405/406.

**Root cause (two independent causes, both measured on production, not guessed)**

1. **No sweep has ever written a sofa variant.** `refresh-po-variants.mjs:61` and
   `refresh-so-variants.mjs:69` are hard-filtered to `item_group = 'bedframe'`.
   Their own dry-run output says so - *"imported PO bedframe lines: 406"*. Every
   tidy-up of `scm.fabric_colours` was therefore invisible to sofa: the library
   was corrected, and nothing ever went back to read it onto a line.
2. **`parseSofa` read a colour only when it was LABELLED.** `Col: X` was matched;
   an unlabelled code was not. `parseSofa("BO315-21 (PEARL)/28\"/2L")` returns
   `color: null` with `why: ['token "BO315-21"']` - the parser SAW the code and
   discarded it as an unrecognised structure token. So a sweep that had run would
   still have read nothing.

**The evidence that the library was never the blocker:** of the 86 blank colour
axes, **85 hold no value at all** and exactly 1 says TBC. Not one is a code the
library failed to resolve.

**Fix** - `parseSofa` gains an opt-in `opts.knownColour` predicate. When no
labelled colour is found and the caller supplies the predicate, an unlabelled
segment is read - but only when `scm.fabric_colours` CONFIRMS it. A code the
library confirms is a copy of what AutoCount wrote; a code it cannot confirm is a
guess. Without the predicate the function behaves exactly as before, so no
existing caller changes. `backfill-sofa-variants-from-desc2.mjs` is the sweep
sofa never had: fill-only (an operator's correction outranks a re-parse),
exact-match by default, `variants || patch` through `db.json()`.

**What this did NOT fix.** Only **14** lines can be filled on exact matches.
**80** more are blocked because their colour resolves only through the fuzzy
matcher, and a match is not a copy, so they are held for the owner rather than
written. The blocking set is benign - 17 distinct mappings, every one a
formatting difference on the same fabric:

```
"BO315-21 (PEARL)"          ->  BO315  / BO315-21          (the bracket is the colour name)
"B0315-1 pearl"             ->  BO315  / BO315-1-PEARL     (zero for the letter O)
"GD2502#04-OAK"             ->  GD2502 / GD2502-04
"MODENZA 01-HOUSTON CREAM"  ->  MODENZA / MODENZA-01
```

A FIRST version of this script reported 338 held colours and a frightening
`Harring 02# Beige -> HIRRING GD8371` beside `HARRING GD8371 02# BEIGE ->
GD8371` - one physical fabric resolving to two library rows. That reading was
an artefact of the script, which pushed to the hold list before asking whether
the line had a blank axis at all: those rows were already filled and nothing
would have touched them. The duplicate-series problem is real and still open
with the owner, but it does NOT block this backfill.

**A second defect the hold list did expose:** the labelled-colour rule captures
to end of line, so it carries instructions as colour values -
`"B0315-5 FOSIL request to normal leg and not fully cover"`, `"BO315-2 (24inch)"`.
Not fixed here.

**Lesson** - a check that says a field is empty does not say WHY. "The library is
missing the code" and "nothing ever wrote the code" produce the identical
symptom, and only one of them is fixed by tidying the library. Ask which before
repeating the repair.

**Ref** - fix/sofa-variant-backfill, 2026-08-11.

## A partial conversion told AutoCount to transfer the WHOLE parent, moving stock in a live book that never moved here [high]

**Symptom** - a delivery order shipping 2 of a sales order's 5 lines would
produce an AutoCount DO carrying all 5. Same for a GRN receiving part of a PO, an
invoice covering part of a DO, and a purchase invoice covering part of a GRN.
Never observed live, because the write-back has never drained in production - but
partial shipment is what the business does daily, so the first drain would have
done it on the first document.

**Root cause (traced, not guessed)** - `enqueueConvert` deliberately sent no
`DtlKeys`, with a comment arguing that AutoCount's own book is the authority on
which lines are still outstanding. It is, and that is beside the point.
`AcSyncService.DtlKeys()` reads the payload first and **falls back to
`SELECT d.DtlKey ... WHERE (d.Qty - ISNULL(d.TransferedQty,0)) > 0` over the
whole parent** when the array is absent, then hands that set to
`AddPartialTransferDetail`. "Let AutoCount answer" and "transfer everything" are
the same instruction. The information to do better was already on hand: every
downstream line carries its source line (`delivery_order_items.so_item_id`,
`grn_items.purchase_order_item_id`, `sales_invoice_items.do_item_id`,
`purchase_invoice_items.grn_item_id`), and 0273 + 0280 put `linked_ac_dtlkey` on
all six line tables.

**Fix** - `readConvertSourceKeys` resolves the subset and sends it. Three
outcomes, not two: send the keys when every source line has one; **REFUSE** with
a visible `skipped` row when the transfer is a strict subset and a key is missing
(sending nothing there is precisely the defect); fall back to no `DtlKeys` only
when the document covers every line of the parent, where "all outstanding" is the
same set. A cancelled parent SO line does not count as one left behind. Six tests
pin the three branches. **Not fixed and now written down** (module doc 7b): a
partial QUANTITY on a line, which `AddPartialTransferDetail` cannot express at
all - it takes line keys, not quantities.

**Ref** - feat/writeback-all-six, 2026-08-11.

## Removing a line in the ERP left it live, outstanding and transferable in the AutoCount book [high]

**Symptom** - the owner widened the go-live gate to "SO DO SI PO GR PI, on create,
edit AND deleting an SKU". Delete was the one verb with no implementation at all.
A second, live-today variant: production has held two `cancelled = true`
sales-order lines since 2026-08-10 (PR #1937), and the next edit of either
document would have pushed them to AutoCount as ordinary lines at full quantity.

**Root cause (traced, not guessed)** - `/edit` applies only the lines it is GIVEN
(`AcSyncService.cs`, its `Lines` loop is a `foreach` over the payload). An edit is
composed from the document AS IT IS NOW, so a hard-deleted row is simply absent -
and absence is not an instruction. AutoCount kept the line, kept it outstanding
under `Qty - TransferedQty > 0`, and kept it transferable into a later DO or GRN.
The service half had been complete since it was written (`Retire: true` ->
`Qty = 0`, `Transferable = false`, an `[ERP-CANCELLED]` Desc2 marker), and
nothing in the ERP ever sent it. The cancelled-line half had the mirror cause:
`SO_ITEM_COLS` did not select `cancelled`, so `soLine` could not see it and
`composeEdit` had no way to tell a written-off line from a live one.

**Fix** - `retiredLineOf(sb, table, itemId)` reads the row's `linked_ac_dtlkey`
**before** the DELETE destroys it, and all six line-DELETE handlers hand it to
their edit as `retire`. `composeEdit` emits `Retire: true` for those and for any
retained line with `cancelled = true`, carrying only what identifies the line
(`DtlKey`, `ItemCode`, `Desc2` when present) because the service's Retire branch
`continue`s before it reads `Qty`. A cancelled line with no key is REFUSED, not
dropped - a retirement we cannot name is a silent divergence. Retirements are
appended last and deduplicated against the retained lines, so a re-added line
that inherited the key is edited rather than zeroed. `composeCreateSo` /
`composeCreatePo` drop cancelled lines entirely: on a create AutoCount holds
nothing to retire. **Still not done, and deliberately** - the ERP-side soft
cancel. Five of the six line tables have no `cancelled` column and all six routes
still hard-delete; converting them needs their readers taught first, and a
half-converted soft cancel is worse than the hard delete
(`docs/autocount-line-retirement-plan.md`).

**Ref** - feat/writeback-all-six, 2026-08-11.

## Photos still rendered "err" after the bucket-name fix — the SAME symptom, a SECOND missing config [high]

**Symptom** — the entry below ("Every SO line photo rendered as `err`") was fixed
on 2026-08-10 by adding `SO_ITEM_PHOTOS_BUCKET_NAME`, and photos still showed
`err` in production. The 983 imported AutoCount photos remained invisible.

**Root cause (traced live, not guessed)** — `soItemPhotoBindings()` validates
FOUR values one at a time and throws on the first missing one. Fixing the bucket
name simply advanced the failure to the next line. Hit from the owner's
authenticated browser session:

```
GET /api/scm/mfg-sales-orders/HC-SO-002609/items/<id>/photos/<key>/signed
  -> 500 {"error":"signing_failed","reason":"R2_ACCESS_KEY_ID not configured"}
GET /api/scm/mfg-sales-orders/HC-SO-002609/items/<id>/photos/<key>
  -> 200 image/jpeg 7036 bytes          <- the SAME photo, via the PROXY route
```

`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` are wrangler SECRETS
and were never provisioned. The photos were never missing and the R2 *binding*
could read them the whole time — only the SigV4 URL-minting path was broken.

**Fix** — the read path no longer depends on a credential it does not need.
SO / PO / consignment `/signed` fall back to the proxy path (`200
{ mode:'proxy', proxyPath, … }`) instead of 500ing. The PO surface had ONLY a
`/signed` route, so a proxy was added for it, carrying the PO route's own authz
INCLUDING `scopeToCompany` — the SO proxy omits company scoping because its
`/signed` twin does too, but omitting it on the PO side would have made the
fallback strictly more permissive than the route it backs up. Signing is still
tried first, so the fallback never becomes the default read path.

**The trap this fix had to avoid** — the obvious "fix" is to return the proxy URL
as `signedUrl`. It does not work, and it fails INVISIBLY. A signed R2 URL carries
its signature in the query string, so it works as a bare `<img src>`; the proxy
sits behind the global auth gate, which reads the bearer token from the
`Authorization` HEADER only (`middleware/auth.ts`). There is no cookie session in
this app — `Set-Cookie` appears nowhere in `backend/src`. A browser sends no
header on an `<img src>`, so that "fix" trades a visible 500 for a silent 401 and
the tile stays blank while the code looks correct. The response therefore carries
a `mode` discriminator and leaves `signedUrl` undefined in the proxy branch, so
the value cannot be misused; the client fetches it as a Blob and uses
`URL.createObjectURL`. A comment in `public-images.ts` asserting the opposite
("the same-origin SPA passes that with its session cookie") was false and is
corrected in this PR.

**The class, for next time** — a config validator that throws on the FIRST
missing variable turns one outage into N sequential outages, each looking like a
new bug. When a check reports a missing setting, enumerate the rest before
declaring it fixed. And a read path should degrade to a slower route that works
rather than fail, when one exists at zero configuration.

**Ref** — 2026-08-10, PR fix/photo-proxy-fallback.

## Migrated data is not identical to AutoCount: three field-level import defects a per-line check found and every aggregate check missed [high]

**Symptom** - the owner, 2026-08-11: *"怎么可以这样的 我们的数据居然是 migrate 的
那就应该全部一模一样 migrate"*, on being shown that `HC-PO-009633` reads "ordered
1, received 2" on both of its `HOK-1005 (Q)` lines. AutoCount does not permit an
over-receipt; its own `PODTL.TransferedQty` says 1 and 1.

**Why nothing caught it** - every verification the cutover had was AGGREGATE:
document counts (2,710 = 2,710), document numbers (262 exact, 0 different),
balances (2,696 of 2,708), the SO->PO->GR chain (427 agree, 0 disagree), stock
status. All of them passed, because an aggregate can only see the sum and the
sum was right. The defect lived one level down, in a per-line FIELD.

**Root cause (traced, not guessed)** - `backend/scripts/check-migration-fidelity.mjs`
against production + the live AED_HOUZS book (run **31458747829**, read-only)
compared 15,295 migrated lines field by field and traced three defects to the
line of code that writes the field:

1. **`purchase_order_items.received_qty` came from a document-level aggregate.**
   `export-received-pos-live.py` built its `GrQty` column as
   `SUM(GRDTL.Qty)` over `(DocNo, ItemCode)`, and
   `import-ac-so-linked-pos.mjs` wrote `recv = l.GrQty` straight into the line.
   Every same-code line on one purchase order was handed the whole document's
   receipt. **65 PO lines, 73 excess units, 29 purchase orders** - and **65
   migrated GRN lines** inherit it, because `create-migrated-documents.mjs`
   builds a GRN line from `received_qty`.

2. **`import-ac-outstanding-po.mjs` reads a column that does not exist.** It
   writes `deliv: l.DelivDate` in three places while the export column is
   `DeliveryDate`, so the value is `undefined` and the line lands with no
   delivery date. `import-ac-so-linked-pos.mjs` spells it correctly, which is
   why only part of the estate is affected. **101 PO lines ERP-null against a
   real AutoCount date, and 46 purchase orders then show no expected delivery**,
   because the header date is derived as the earliest line date.

3. **An AutoCount quantity of 0 becomes 1 in the ERP.** Both importers write
   `Math.round(num(l.Qty)) || 1`; JavaScript's `||` treats `0` as absent, so a
   deliberately zero-quantity AutoCount line is silently ordered once. **5
   lines**, and the money follows it onto 2 PO line totals AutoCount puts at 0.

**Fix** - none yet, deliberately. This entry records the DETECTION; the check is
read-only and the repair is a separate, owner-approved change. What shipped is
the thing that will not let it happen silently again: a field-by-field,
per-line comparison with a printed field map (72 fields, tagged COMPARED /
DERIVED / DECLARED / NOT-CHECKED), findings grouped BY FIELD so one systematic
import bug is one finding, and a stated join coverage so rows it cannot pair are
counted rather than dropped.

**Lesson** - an aggregate check cannot find a per-line defect, and every check
this cutover had was an aggregate. When the acceptance criterion is "identical",
the comparison has to be at the grain the data is stored at. The first run of
the check itself under-reported for the same reason: an exact-code match claimed
one sofa compartment and orphaned its siblings, hiding 14 of the 65 lines, until
the join was made to claim a sofa build as a group.

**Ref** - PR #1981, 2026-08-11; runs 31457523779 / 31458441463 / 31458747829.

## 2026-08-11

### [HIGH] Two PO line paths took an operator-supplied qty against an SO line with NO remaining-qty cap — the SO→PO ceiling was enforced on every BATCH path and on neither LINE path
- **Symptom.** Nothing visible to staff and nothing wrong in the data yet — this was found by proving the guard, not by an incident. The owner asked (2026-08-10) to confirm that a document already converted to a DO or GR cannot be converted again. Repeat conversion is DELIBERATE here (the business ships one order in several batches), so the real guard is the QUANTITY CEILING, not an "already converted" flag. Auditing every convert path against that ceiling found two with none: an operator could append a PO line — or edit an existing one upward — bound to an SO line that was ALREADY fully converted, and order the goods from the supplier a second time.
- **Root cause (traced to the code, not guessed).** `POST /mfg-purchase-orders/:id/items` (mfg-purchase-orders.ts:2674) and `PATCH /mfg-purchase-orders/:id/items/:itemId` (:2795) both call `soLinkTargetRefusal` (:2595), which validates that a bind POINTS at a legitimate SO line — it exists, it belongs to the active company, it is not cancelled, and its `item_code` matches the PO line. It says nothing about HOW MUCH. Every batch path does cap it: `/from-sos` via `!fromMrp && p.qty > remaining` (:1597), the generic `POST /` via `findOverConvertOffender` (:1142, added by #1220), and `/:id/convert-from-so` by deriving qty server-side as the unpicked remainder (the F1 audit fix of 2026-06-10, which closed exactly this double-ordering on that one path). The two line-level paths take an operator-supplied qty and were simply never included. The PATCH path guarded only the DOWNWARD direction (`line_qty_below_allocated`, mig 0235); its own comment — "if it raised qty, picked rises" — states the unguarded upward case in passing. Nothing backstops it at the DB: `po_qty_picked` is a plain counter recomputed by `recomputeSoPicked`, with no trigger and no constraint.
- **What limited the blast radius.** `poHasDownstream` (:237) blocks both handlers once a non-cancelled GRN exists, so the hole was reachable only BEFORE receipt — which is precisely when over-ordering the supplier does the damage.
- **Fix.** `soLineHeadroom` (new, in `scm/lib/po-over-convert.ts`) is the pure ceiling: `qty - po_qty_picked`, plus this line's OWN stored qty credited back while it stays bound to the SAME SO line (without that credit a no-op re-save of an already-bound line would 409 against itself), clamped at 0. `soLineOverConvertRefusal` wraps it with the SO-line read and is now called by both handlers, refusing with the same `qty_exceeds_remaining` 409 the sibling paths return. Overridable with `confirmOverConvert` — the SAME escape hatch the generic create already documents — so a deliberate over-order stays one explicit flag away rather than becoming impossible.
- **What the audit RULED OUT.** Every other convert path was read line by line and is correctly capped, including its line-level back doors. SO→DO caps on `qty - delivered + returned` (`soDeliverableRemaining`, delivery-orders-mfg.ts:1885) with a pre-check at :3336 AND a post-insert race re-check that rolls the DO back at :3575, plus write-path guards at :2951/:3085/:4030/:4165/:4660. PO→GRN caps on `qty - received_qty` at grns.ts:1506/1653/1860/1926/2035/2656/2886. DO→SI and DO→DR share ONE pool (`delivered - invoiced - returned`, do-line-remaining.ts:218), so invoicing and returning compete and a unit can never be both. GRN→PI and GRN→PR cap at purchase-invoices.ts:904/1007/1414/1684/1844/1907/2023 and purchase-returns.ts:557/1101/1163/1260. `/from-grns` accepts no client qty at all — it clamps server-side to `min(qty_rejected, qty_accepted - returned_qty)`. Amendments do not bypass the ceiling, they MOVE it, and the arithmetic fails safe: a line amended below what already shipped yields a NEGATIVE remaining, and every enforcement site compares with `>`, so a negative ceiling refuses everything rather than wrapping into fresh headroom.
- **The premise that did not hold.** The brief asked whether migrated documents carrying `migrated_no_stock = true` count toward the ceiling. **That column does not exist in this repo** — no `migrated_no_stock`, and no equivalent boolean on `scm.delivery_orders` or `scm.grns`; a grep across every `.ts`, `.tsx`, `.sql`, `.mjs` and `.md` returns nothing. So there is no flag by which a migrated document could be excluded: a migrated DO or GRN counts on exactly the same terms as a native one, by STATUS and by LINK. The real exposure is the LINK, not a flag — `soDeliverableRemaining` skips any DO line whose `so_item_id` is NULL (delivery-orders-mfg.ts:1815), and the `received_qty` recount sums only GRN lines carrying a `purchase_order_item_id` (grns.ts:800). An unlinked line moves stock that the ceiling never sees. That is not hypothetical: it is why DO-2607-005 on SO-2606-019 double-shipped while the over-delivery guard stayed blind. Both exposures are now pinned by named tests, so a future change has to face them deliberately instead of inheriting them silently.
- **Test.** `backend/src/scm/lib/convert-ceilings.test.ts` — 42 cases covering the ceiling on all six paths, each with a partial (allowed) and an over-quantity (refused) case, plus cancel/draft release, the invoice-XOR-return exclusion, the amendment fail-safe, and the two unlinked-line exposures. **Mutation-verified, both numbers:** with the fix **42 pass**; with both production files reverted to `main`, **13 fail / 26 pass**; with the lib helper kept but ONLY the two call sites removed, exactly the **2** wiring cases fail (**2 fail / 37 pass**) — so the suite fails for the right reason, not merely because a new export is missing. The wiring cases assert the call sites against the router SOURCE (a `?raw` import, typed by `backend/src/raw-import.d.ts`) because scm routes cannot be exercised end to end in this harness: they ride Supabase Postgres and the harness rebuilds only the D1 side.
- **NOT proven by test.** No case drives the two handlers over HTTP, for the harness reason above — the guard function is tested directly and its invocation is asserted structurally. Nothing was run against production data.
- **Ref:** #1920. `chore/convert-guard-proof` 2026-08-11.
## A zero-priced purchase order opens a zero-cost stock layer [high, money]

**Symptom** — imported purchase orders carry `unit_price_centi = 0` on 565 of
the 579 SO-linked lines. The books are clean TODAY only because those POs
deliberately have no ERP GRN: costless-stock PENDING(GRN) = 0, PERMANENT = 0,
"OUT movements with no cost: 0". The exposure is the NEXT receipt — 234 open
units across 180 lines / 121 POs / 67 AutoCount item codes are waiting to be
received, and every one of them would book at RM0.

**Root cause (traced, not guessed)** — Houzs suppliers genuinely do not price a
purchase order; the price appears on the GOODS RECEIVED document. Live AutoCount
confirms it is the norm, not corruption: HOOKKA 2,264/2,264 PO lines unpriced,
OHANA 100%, DORSETTLOFT 100%, while GRDTL is 17,377/19,013 priced (91.4%). The
cutover copied that faithfully. What is missing is any fallback afterwards —
the zero rides the whole chain untouched:

`purchase_order_items.unit_price_centi = 0` -> `grns.ts` `/from-pos` and
`/from-po-items` copy it verbatim -> `postGrnAndRollup` computes
`unit_cost_sen = landedUnitCostMyr ?? toMyrSen(unit_price_centi, rate)` ->
the FIFO trigger's **IN** branch is `COALESCE(NEW.unit_cost_sen, 0)` (the
weighted-average fallback exists only in the **ADJUSTMENT** branch, migration
0195) -> the OUT consumes that lot at RM0 COGS -> DO line cost 0 ->
`sales_invoice_items.line_cost_centi` 0 -> the margin report reads 100%.
`grep` for `cost_required` / `price_required` in `grns.ts` returned nothing:
there was no zero-price guard anywhere on the receipt path.

**Fix** — a gate at the receipt, because it is the last moment the cost is
still changeable: once the unit ships the COGS is settled and must never be
rewritten. `scm/lib/zero-cost-receipt-guard.ts` refuses a post whose line would
open a zero-cost lot, wired into `postGrnAndRollup` BEFORE the CAS status flip
so a refusal writes nothing, plus a rollback on the three create-as-POSTED
paths so a refused receipt leaves no POSTED-but-unbooked document behind.

The discriminator is the SKU's own purchase history, not a flag: there is no
`is_free_gift` on the purchase side (`default_free_gifts` is entirely
sales-side), so a SKU never received at a non-zero cost is treated as genuinely
free — GWP, demo, display — and allowed silently, while a SKU that HAS carried
money before is refused. Same rule `backfill-zero-cost-lots.mjs` already uses
and the owner already confirmed. `grn_items.zero_cost_ack` (migration 0277) is
the per-line escape hatch, because a refusal with no override trains people to
type a fake price, which is worse than a recorded zero. It shipped inert in the
first round — the column was written by the migration and read by the gate, but
no route accepted it and both create paths build their insert from an EXPLICIT
whitelist, so a tick would have been silently dropped. It is now accepted on
create, add-line and line PATCH, all through `zeroCostAckColumns`, which also
records WHO ticked it and when; the tick renders on the receipt screen only
while the line carries no price.

**The class, for next time** — *a COALESCE to 0 on a money column is a silent
default, not a safe one.* The same trigger already knew better one branch away:
ADJUSTMENT falls back to the weighted average, IN falls back to zero, and
nothing flagged the asymmetry for as long as it has existed. When a fallback
value is indistinguishable from a legitimate value — free really is zero here —
no downstream report can ever tell them apart, so the check has to happen at
the point of entry or not at all.

**And do not price a repair from `MAX(UnitPrice)` or last-cost.** Backtested
over all 11,239 priced AutoCount purchase lines for the 67 affected item codes,
predicting each line from the others: `MAX` by item code is 112.5% mean error
and overstates 97.6% of the time; last-cost by item code is 32.2% and overstates
57.2%; item + Desc2 signature is 0.4% and exact on 97.3%. Desc2 — the
compartment/colour signature — IS the price key. `stamp-po-line-costs.mjs`
therefore prices only what it can price accurately and reports the rest, since a
plausible wrong cost is worse than a visible zero the gate will catch.

**Ref** — PR fix/zero-cost-po-exposure, 2026-08-10.

### [HIGH] The write-back sent ERP item codes the account book has never heard of, and one sofa as N lines

**Symptom** - nothing visible, because the write-back has never drained in
production. On the first document that did drain, AutoCount would have received
a Sales Order whose lines carried `9028-1S`, `AKEMI APEX MATT (SP)` and every
other ERP `material_code` verbatim as `ItemCode` - codes the licensed
`AED_HOUZS` book does not contain - and a sofa would have arrived as three or
four lines (`{model}-1A(LHF)`, `{model}-CNR`, ...) where the book holds ONE.

**Root cause (traced, not guessed)** - two separate defects that both end in the
same place, `toDetails` in `backend/src/services/autocount-writeback.ts`:

- **D10.** `composeCreateSo` was called with two arguments
  (`autocount-outbox.ts`, SO create), so its third parameter defaulted to
  `identityResolver` and `toDetails` emitted `ItemCode: l.item_code` - the raw
  ERP code. `makeItemCodeResolver`, the function written to solve exactly this,
  had no caller outside `autocount-writeback.test.ts`. Measured against the
  cutover map: of the enumerable ERP catalogue only a small minority are real
  AutoCount ItemCodes; the rest do not exist in the book.
- **D9.** `toDetails` was a strict 1:1 `map` over the ERP rows. The ERP models a
  sofa build as one line per COMPARTMENT and AutoCount holds one line per sofa
  with the build in `Desc2`, so every sofa document was the wrong shape.
  Compounding it, `PO_ITEM_COLS` did not select `description2`, so the PO side
  threw away the original AutoCount build text that the cutover importer had
  stored verbatim on every compartment row.

**Fix** - `composeDetails` now runs COLLAPSE then RESOLVE, and refuses the whole
document rather than sending part of it.

- `autocount-sofa-collapse.ts` (pure) folds a compartment run into one line:
  ECHO the stored `Desc2` when it still decodes to everything the ERP row holds
  (551 of 551 decodable builds in the real corpus), COMPOSE only when the
  operator actually changed the build, and GATE always - re-decode with the same
  `parse-sofa.mjs` the importers use and refuse unless pieces, size, colour and
  specials all survive.
- **A third defect, found while verifying the second.** The first cut of the echo
  matched on the COMPARTMENT LIST alone. But a fabric colour, a seat height and a
  special order all change without the piece list changing, so an operator who
  re-coloured a sofa in the ERP would have had the sofa's OLD colour echoed into
  AutoCount - the ERP showing the new value, the account book showing the old
  one, nothing refused, and no marker anywhere that the edit was dropped. That is
  a wrong line, not a missing one, and it is the failure the write-back exists to
  prevent. The echo now also requires the stored text to decode to the size,
  colour and specials the row holds; anything else falls through to compose,
  which spells the current build or refuses it visibly. Measured by re-colouring
  every coloured build in the corpus: **341 recomposed / 41 refused / 0 stale**
  with the check, **382 of 382 stale** without it.
- `autocount-item-code.ts` resolves against the compiled cutover map, using the
  creditor to separate the 117 ERP codes the cutover collapsed onto several
  AutoCount items. 109 separate; **8 do not, and are refused** rather than
  guessed. No fallback to `material_code`.
- `PO_ITEM_COLS` now selects `description2`.
- Refusals land as `skipped` outbox rows, and the row now names the refusal
  class (`KeylessLineError` / `SofaCollapseError` / `ItemCodeError`), because the
  three have three different remedies and the `console.error` that carried the
  name does not survive a Worker recycle.

**The trap this leaves behind** - a test whose fixture uses an invented SKU no
longer tests what its name says. `an edit whose line has no DtlKey is REFUSED`
kept passing with `SKU-1`/`SKU-2` fixtures, but it was passing on an
`ItemCodeError`, not the keyless guard, and its `toContain('SKU-2')` matched the
wrong message. Outbox fixtures now use real cutover codes and that test asserts
the refusal class explicitly.

**Ref** - PR (feat/ac-writeback-sofa-collapse), 2026-08-11. Closes contract
divergences D9 and D10.

## Migration 0294 promised migrated invoices spend no customer credit, and nothing enforced it [medium]

**Symptom** - a migrated Sales Invoice mirrors an invoice AutoCount already
raised and already settled in its own book. Migration 0280's column COMMENT
promised "apply NO customer credit", because paying one out of the customer's ERP
credit balance spends a real balance a second time - the customer silently loses
money still owed to them, and the applied credit is indistinguishable from a
genuine one afterwards. No code enforced that promise.

**Root cause (traced, not guessed)** - the guard was written for the two money
paths that were obvious (`postSiRevenue`, `postPiAccounting`) and the credit path
was described in the migration comment but never coded. It looked safe because
all three reachable callers of `applyCustomerCreditToSi` happen to miss migrated
invoices today - and every one of those is an ACCIDENT of the current shape, not
a rule:

```
sales-invoices.ts:1164  POST /            create refuses a migrated source
sales-invoices.ts:1462  POST /from-dos    create refuses a migrated source
sales-invoices.ts:2295  PATCH status      requires prevStatus DRAFT; converter writes SENT
```

This is the same shape as migration 0276, which shipped a COMMENT saying "never
post movements for it" that nothing in the running system honoured. A promise
living only in a comment is the thing this ledger exists to stop.

**Fix** - the guard now lives INSIDE `applyCustomerCreditToSi`
(`backend/src/scm/lib/customer-credits.ts`), which re-reads the header, so every
caller is covered by construction rather than every call site being remembered. A
failed read REFUSES (`migrated_check_failed`) rather than proceeding blind:
fail-closed leaves the credit standing and the invoice merely unpaid, which an
operator can see and re-drive, while fail-open spends a balance that cannot be
un-spent. Migration 0280's comment now names the enforcement point, and states
what is deliberately NOT stopped - a payment recorded against a migrated invoice
behaves normally, and cancelling it still turns the paid amount into credit,
because that money moved in THIS book.

Counterfactual, both numbers: with the fix `customer-credits.test.ts` is
**35 pass / 0 fail**; strip the guard block and it is **33 pass / 2 fail**
(`migrated SI -> applies nothing`, `a failed migrated read REFUSES`). The third
test in the group - an ordinary SI still applies credit - passes BOTH ways on
purpose: it is the control proving the guard is not a blanket off switch.

**Ref** - PR #1975 `feat/migrated-chain-invoices`, 2026-08-11.

## The migrated-invoice refusal guarded three convert paths and there are eight [high]

**Symptom** - a goods receipt or delivery order carried over from AutoCount could
still be turned into an invoice by hand, even after `refuseMigratedSources` was
added. Nothing about it would be visible afterwards: the invoice would carry an
ERP number instead of AutoCount's, post a journal entry for money AutoCount had
already booked, and enqueue a write-back that creates a SECOND invoice in the
live AED_HOUZS book. It would also consume the source line's invoiceable
quantity, so the mistake could not be corrected without cancelling the invoice.

**Root cause (traced, not guessed)** - the refusal was written on the three paths
that take a WHOLE document (`POST /from-grn`, `POST /from-grn-items`,
`POST /from-dos`). Five more paths reach the same lines holding only a line id or
a delivery id, and each one bypassed the rule entirely:

```
purchase-invoices.ts  POST /                        lines carry grnItemId
purchase-invoices.ts  POST /:id/items               line carries grnItemId
sales-invoices.ts     POST /                        lines carry doItemId, body carries deliveryOrderId
sales-invoices.ts     POST /:id/items               line carries doItemId
sales-invoices.ts     POST /:id/items/from-do/:doId takes a whole delivery id
```

A fence with an open gate beside it is not a fence.

**Fix** - both routers resolve the source document from the line id first, then
apply the SAME `refuseMigratedSources` rule, so a caller cannot pick a softer
door. A FAILED lookup refuses rather than proceeds (`ok: false` -> 500): a guard
that fails open is not a guard. `backend/tests/migratedConvertGuard.test.mjs`
pins all eight paths, asserts the refusal comes BEFORE the AutoCount enqueue (a
refusal after it is no refusal at all), and asserts the GL suppression lives
inside `postPiAccounting` / `postSiRevenue` rather than at their call sites, so
every caller is covered by construction. It runs in `test:scale-contract`, which
is `pretest`.

Counterfactuals, both numbers: with the fix **4 pass / 0 fail**; strip the SI
guards **1 pass / 3 fail**; strip the PI guards **2 pass / 2 fail**; strip the
`postSiRevenue` suppression **3 pass / 1 fail**.

**Ref** - PR for `feat/migrated-chain-invoices`, 2026-08-11.

## A merged migrated invoice took its supplier / debtor from whichever source document sorted first [high]

**Symptom** - one AutoCount invoice routinely spans several of our documents, and
the mirrored ERP invoice merges them. The merged header carries exactly ONE
supplier / debtor, and the writer took it from `plan.sourceDocNos[0]` - i.e. from
document-number sort order. If the sources disagreed, the invoice would be
billed to the wrong party with a total that reconciles perfectly, which is the
worst shape a wrong value can have.

**Root cause (traced, not guessed)** - this is not an edge case. Measured
read-only against live AED_HOUZS on 2026-08-11:

```
grToPi: invoices covering >1 source document = 309 of 4789
doToIv: invoices covering >1 source document = 568 of 9245
```

`planMigratedInvoices` grouped purely by AutoCount invoice number and never
compared the parties behind the group.

**Fix** - rule 5 in `backend/src/scm/lib/migrated-chain.ts`: each source carries a
`partyKey` (supplier on a receipt, debtor on a delivery) and a group whose
sources disagree is refused as `party_disagrees_across_sources`, checked BEFORE
the total gate and not buyable with the `allowTotalMismatch` override. A source
with no recorded party does not manufacture a disagreement. On today's
production data the rule fires on 0 documents - it is a guard against a shape the
data can take, not a repair of one it already has.

Counterfactual: **32 pass / 0 fail** with the rule, **29 pass / 3 fail** without.

**Ref** - PR for `feat/migrated-chain-invoices`, 2026-08-11.
## The cutover stock import dropped every NEGATIVE AutoCount balance row, leaving the ERP permanently higher [low]

**Symptom** - the stock truth check reported `VERDICT BALANCE: DIVERGES` on 35
cells / +104 units against live AutoCount, which read as phantom stock. Most of
it turned out to be AutoCount trading on after the cutover, but 6 cells / 13
units did not reconcile to any AutoCount movement.

**Root cause (traced, not guessed)** - `import-ac-stock-balance.mjs:129` sorts
each cell into `plan` or `negs` by the sign of the delta, and `:137` decides what
is actually written:

```js
(delta > 0 ? plan : negs).push({ ... });
const todo = NEG ? [...plan, ...negs] : plan;
```

The cutover ran WITHOUT `NEG`, so every negative delta was logged and discarded.
Where an AutoCount item carries a negative on-hand at a location, the ERP kept
the positive contributor's full quantity and never subtracted the negative one.
It is invisible in the check's existing AC-NEGATIVE bucket because that bucket
only fires when the MAPPED TOTAL is negative - here a negative row is folded
together with a positive one under a many-to-one item mapping, so the total
stays positive and the negative is silently absorbed.

Verified per cell against live AutoCount over read-only ODBC. In every one the
unaccounted amount equals exactly the magnitude of the dropped negative row:

```
SQUARE PILLOW  @ KL  ERP 46 vs AC 38  (+8)  RDS-SQUARE PILLOW @ KL carries +8 AND -8
HILTON (A)-(Q) @ KL  ERP  4 vs AC  3  (+1)  NB-KHJ50(Q)  @ KL = -1
FENRIR-(Q)     @ PG  ERP  2 vs AC  1  (+1)  HOK-1005 (Q) @ PG = -1
VICTORIA-(K)   @ KL  ERP  1 vs AC  0  (+1)  NB-KHJ21(K)  @ KL = -1
REGAL (A)-(Q)  @ PG  ERP  3 vs AC  2  (+1)  NB-NH36 (Q)  @ PG = -1
ELEGANT (A)-(Q)@ KL  ERP  3 vs AC  2  (+1)  NB-KHJ33(Q)  @ KL = -1
```

8 + 1 + 1 + 1 + 1 + 1 = 13, which is the whole unexplained bucket. Nothing else
in the stock balance is unaccounted for.

**Fix** - NOT repaired here; this lane measures only. The check now separates
divergence AutoCount caused from divergence we caused, so the 13 units are
visible as their own bucket instead of buried under +104. Whoever repairs it
should decide with the owner whether a negative AutoCount on-hand should even be
represented - the ERP ledger cannot hold one, which is why it was skipped in the
first place.

**Ref** - prod run 31452269844 (read-only), 2026-08-11.

## The array-shaped custom_specials are NOT the same damage, and NULLing them would have deleted correct data [med]

**Symptom** - #1944 NULLed the 478 `custom_specials` values the old sofa
backfill had double-encoded into jsonb STRING scalars, and left the ARRAY-shaped
remainder alone because `jsonb_typeof` cannot tell a correct
`Array<{description, surchargeSen}>` from a bare `string[]`. The obvious next
step was to finish the job and NULL the remainder too. That step would have been
a data loss.

**Root cause (traced, not guessed)** - the census
(`backend/scripts/census-custom-specials-arrays.mjs`, prod run **31428435434**,
read-only) classified every array-shaped row from its ELEMENTS:

```
SO  custom_specials shape census: array=511      511 bare string[], 0 object, 0 empty, 0 other
PO  custom_specials shape census: array=93        93 bare string[], 0 object, 0 empty, 0 other
migrated 604/604      already carrying variants.specials 604/604
694 strings, 16 distinct:  679 are a LIVE scm.special_addons code, 15 are raw slip text
rows where variants.specials COUNT differs from custom_specials length: 0
```

The histogram: `HB Fully Cover` 282, `Front Drawer` 150, `HB Straight` 138,
`Divan Curve` 45, `Divan Full Cover` 39, `No Side Panel` 9, `Left Drawer` 7,
`1 Piece Divan` 4, `Divan Top Fully Cover` 3, `Right Drawer` 2 - all real picker
codes - plus `BOTHWANT` 4, `FABRICHARRING` 3, `DAYBED` 2, `LEFTSIDE` 2, `LSIDE`
2, `request to normal leg and not fully cover` 2.

So these rows are NOT the sofa backfill's output. They are the BEDFRAME specials
pass (`fix-so-specials.mjs`), which wrote **correct picker codes** in the legacy
`string[]` shape and never double-encoded anything.

**The premise that does not carry.** #1944's repair stood on three legs, and the
load-bearing one was *"valid jsonb holding WRONG DATA is worse than empty,
because it looks repaired"*. Here the data is RIGHT: 679 of 694 strings are live
codes, and every row's `variants.specials` holds exactly as many entries as its
`custom_specials`, so the derived cache agrees with its source on all 604 rows.
The renderer handles both shapes deliberately - `SalesOrderDetailListing`'s
`formatSpecials`, mirrored by `check-specials-and-ocr.mjs:55-57`'s `elText`,
reads a plain string and a `{description|label}` object alike. NULLing these
would have removed a correct, currently-rendering line item from 604 historical
documents until somebody edited each one. That is a regression wearing the
costume of a repair.

The other two legs still hold and are why nothing is "upgraded" to the object
shape either: `custom_specials` is derived, and writing a real `surchargeSen`
would mean pricing outside the pricing engine on historical documents - the
repricing the owner ruled out on 2026-08-11.

**Fix** - no data was changed. The tool changed instead, so the next person
cannot make the mistake the numbers now rule out. `string[]` is split into
`codes[]` (every string a live code - legacy shape, correct content, **never** a
repair candidate) and `text[]` (at least one raw phrase). `APPLY=1` alone is now
inert: the only writable class is `text[]`, and it additionally requires
`APPLY_TEXT=1`, because all 15 of those rows carry the SAME raw text in
`variants.specials` - the field the picker actually reads - so nulling the
derived cache alone hides it from the report and leaves it in the operator's
view. That is an owner decision, and the switch is where the owner's answer gets
recorded. The report now prints `variants.specials` beside `custom_specials` so
the agreement is visible rather than inferred.

**Open, for the owner** - the 15 lines whose `variants.specials` carries raw
slip text instead of a code: SO HC-SO-004716, HC-SO-005940 (x2), HC-SO-007132
(x2), HC-SO-009600 (x2), HC-SO-012571 (x2); PO HC-PO-000162, HC-PO-000596 (x3),
HC-PO-009677 (x2). Two of them, `request to normal leg and not fully cover`, are
a phrase the map deliberately VETOES, so they were never meant to be a pick at
all.

**The class, for next time** - a repair that worked once is a hypothesis the
second time. #1944's reasoning was right about the rows it saw and wrong about
the rows it had not looked at, and the two populations are indistinguishable by
the column type that named them. Classify by CONTENT before extending a fix by
SHAPE - and when a script offers to delete, make the class it will delete the
narrow one, not the broad one.

**Ref** - 2026-08-11, census tool PR #1953, finding + refusal PR #1960
(fix/census-codes-are-not-damage). Prod evidence: read-only run 31428435434.

## Both duplicate detectors reported their own repair back as a fresh defect [low]

**Symptom** - immediately after the owner's two 2026-08-11 decisions were
applied and verified, the read-only detectors that had found the problems
reported them as still outstanding:

- `diag-so-po-variant-divergence.mjs` Section D (run **31454888561**) printed
  "1 documents, 4 surplus lines" on `HC-DO-007525` - a document whose five
  duplicate lines had just been retired;
- `merge-duplicate-fabric-series.mjs` (run **31454890568**) still counted **32**
  duplicate pairs and offered to merge 29 of them, minutes after merging exactly
  those 29.

**Root cause (traced, not guessed)** - both detectors census a table that the
"nothing is deleted, only cancelled" rule deliberately leaves populated, and
neither had been taught what a retired row looks like.

1. Option B retires a delivery line by setting `qty = 0` and keeping the row.
   Section D groups by `(delivery_order_id, item_code, qty, so_item_id)`, so the
   five retired `HC-DO-007525` rows - formerly five separate `qty = 1` rows -
   **now group with each other at quantity 0** and satisfy `HAVING COUNT(*) > 1`.
   The repair manufactured a new duplicate group out of its own output.
   (`zero-duplicate-do-lines.mjs` already carried `qty <> 0` for exactly this
   reason; the older diagnostic did not.)
2. A merged fabric series is superseded, not deleted, and its colours stay
   attached to it - so they still collide by colour code with the winner that
   absorbed them, and a census reading the whole `fabric_library` re-proposes
   every pair it just merged, forever.

**Fix** - `qty <> 0` at all four grouping sites in Section D, and the fabric
census now reads only ACTIVE series, printing the superseded count separately so
a completed merge reads as **done** rather than as outstanding.

**Lesson** - a soft-retire rule has a second half nobody writes down: every
detector that counts the retired thing has to learn the tombstone. "Nothing is
deleted" means the rows are still there to be miscounted, and a detector that
cries wolf after a repair is worse than one that never fired - it teaches the
next person that the repair did not work.

**Ref** - 2026-08-11, PR #1980 (fix/detectors-stop-crying-wolf). Prod evidence:
runs 31454888561 and 31454890568, both taken as post-state verification of
#1971 and #1972.

## A digit guard that joined its digit runs together let the one binding it existed to refuse straight through [high]

**Symptom** - `bind-null-colour-lines.mjs` was written with an explicit digit
guard whose entire purpose was to refuse `PC151-101` -> `PC151-11`, the binding
#1964 named as the reason the 7 NULL-colour lines were not auto-filled. Its
first production DRY-RUN (**31452652036**) printed that binding under
`=== WOULD BIND ===`, with the guard reporting `digits 151101 = 15111` as
though the two agreed.

**Root cause (traced, not guessed)** - the guard collapsed every digit run into
one string before comparing, then allowed a single padding zero on the tail:

```
"PC151-101" -> 151101      "PC151-11" -> 15111
pad("15111") = "151101"    -> declared the same number
```

The padding rule is real and necessary - the library stores
`ARMANI J9226-01 SAND` while documents write `J9226-1`. But it is only sound
while the SEPARATOR still tells the series number from the colour number. Once
the runs are joined, a one-zero pad on the tail is indistinguishable from a
digit moving across the boundary. This is the identical hazard
`merge-duplicate-fabric-series.mjs` documents from the other side, and its
comment says so in as many words: after folding, "nothing downstream can then
tell which digits are which".

**Fix** - `backend/scripts/lib/colour-digit-guard.mjs`, extracted so it is one
implementation with one set of tests rather than a helper inlined in whatever
script needs it next. It compares digit RUNS with the separator intact:
`["151","101"]` against `["151","11"]`. Every run but the last must be equal;
the last may differ by one leading zero. A document that writes no number at all
is exempt, because there is no digit to move - `Cream` -> `KS-02` and the
misspelt `sliver` -> `KS-15` are hits on the colour's NAME, and the matcher
already drops any fold key two library rows share, so a name-only hit is unique
by construction.

`backend/tests/colourDigitGuard.test.ts` pins the regression plus every silent
swap the matcher's own docstring names (`B0315-27` -> `BO315-2`, `HR805-20` ->
`HR805-40`, `GD8371-03` -> `GD8371-02`, `STAR-10` -> `STAR 01`).

**Lesson** - a guard is not verified by existing. This one was written
deliberately, for one named case, and still passed that exact case; the only
reason it did not reach production is that the run was a DRY-RUN and its output
was read line by line rather than trusted for its summary. Write the guard, then
make the tool print the specific case it exists to refuse, and go look.

**Ref** - 2026-08-11, PR #1976 (fix/colour-bind-digit-runs). Prod evidence: the
DRY-RUN that caught it, run 31452652036.

## One physical fabric series, two library rows, and a merge that would have deleted the better half [med]

**Symptom** - the fabric picker offered the same series twice (`HR805` and
`FABRIC HR805`, `ARMANI J9226` and `J9226`), and any report grouping by
`fabric_id` split one series' history down the middle. 32 duplicate pairs across
a 140-series library.

**Root cause (traced, not guessed)** - `refresh-sofa-colours.mjs` bound
`HR805-90` to `FABRIC HR805` and `HR805-30` to `HR805` in the same run: the
library already held both spellings, and nothing forced a writer to pick one.
Detection is by shared colour CODE, never by series name - naming alone misses
`AVANI` / `AVANI 01` and proves nothing the colours do not already prove.

**Fix** - the owner decided on 2026-08-11: "合并，按引用数多的那边" - merge, and
the side production references more survives.
`backend/scripts/merge-duplicate-fabric-series.mjs` gained a `MODE=apply` path
it deliberately did not have before.

**The trap the implementation had to avoid, and this is the entry.** A merge
that removes the losing `fabric_library` row is a DELETE, and the owner's rule
is that nothing is deleted, only cancelled. So the loser is **superseded**:
`active = false`, its label stamped with what absorbed it, its colour rows left
attached so a historical document still resolves.

That alone is not enough. Superseding also hides every colour hanging off the
loser from the picker, and **reference count does not know which side is better
curated**. `GD8371` wins over `HIRRING GD8371` on 14 live lines to 9 - but
`GD8371` holds ONE colour, labelled literally `FABRIC`, while `HIRRING GD8371`
holds TEN properly named ones, and only one colour code is shared. A naive
"follow the reference count" merge would have removed nine named colours from
the picker and repointed the live lines sitting on them to a series that cannot
express them.

So every pair is classified from the data before anything is written: `LOSSLESS`
(every losing colour has a counterpart on the winner) applies; `REFUSED-LOSSY`
(the loser holds colours the winner does not) is **held and reported**, and only
merges under an explicit `MOVE_COLOURS=1` that re-parents those colours onto the
winner first. The repoint reaches every arm that can name a series - four at the
time of this entry (SO, PO, GRN, DO) - because a merge that writes two of them
leaves the other two pointing at a superseded row, which is the same unswept-arm
shape #1964 found in the GRN snapshot. *(Corrected 2026-08-13: the arm list is
`ARMS` in `backend/scripts/lib/fabric-write.mjs` and is fifteen now. The "four"
above is what this PR shipped, kept as the record; do not read it as the current
count - read `ARMS`.)*

**What is NOT in the 32, and is not being guessed at** - `CH141` vs `CHANTIC`
and `NX` vs `NX016` share ZERO colour codes, so a colour-code detector is
structurally blind to them. Folding them in on a naming hunch is exactly the
"let a query match a key it shares no number with" move the digit guard exists
to prevent. They are printed as STILL OPEN on every run and left to the owner.

**Lesson** - "the side with more references wins" is a rule about *documents*,
and it says nothing about which row a human curated better. When a tie-break
optimises one axis, check what it silently trades away on another before you let
it write.

**Ref** - 2026-08-11, PR #1972 (fix/fabric-series-merge). Prod evidence:
read-only run 31450029537, PLAN 31452278722, APPLY 31452408610 (29 of 32 pairs
merged, 28 lines repointed, 140 -> 111 active series, 3 pairs HELD as lossy).
Full numbers in `docs/duplicate-fabric-series-merge.md`.

## 11 sales orders read as over-delivered against delivery lines that never moved stock [med]

**Symptom** - staff looking at `HC-SO-001920` saw one `ELEPAHNE-(SK)` ordered
and four delivered. Ten other sales-order lines read the same way. Nothing was
missing from the warehouse.

**Root cause (traced, not guessed)** - not a stock fault at all, an arithmetic
one. `create-migrated-documents.mjs` inserted 18 surplus delivery lines across 8
migrated documents (the writer defect logged below, fixed in #1964). Every one
is an EXACT duplicate of its twin on `(so_item_id, item_code, qty)`, every one
sits on a `migrated_no_stock` document, and prod run **31450027318** measured
**0 inventory movements** against any of them. But `delivered` is the DO line's
own `qty` (`do-line-remaining.ts:199`) and every delivered sum is `SUM(qty)`
over non-cancelled lines, so a duplicate inflates "delivered" with nothing
behind it.

**Fix** - `backend/scripts/zero-duplicate-do-lines.mjs` +
`.github/workflows/zero-duplicate-do-lines.yml`, the owner's Option B
(`docs/migrated-do-duplicate-lines.md`, decided 2026-08-11): set `qty = 0` and
append an audit note naming the original quantity and the twin. **The row is
retained** - the owner's rule is that nothing is deleted, and
`scm.delivery_order_items` has no line-level cancel column, so a zero quantity
is how a line is retired until the deferred line-retirement work lands. No
migration, no new column, no reader taught a new flag.

The guards are the entry: it refuses a document that is not
`migrated_no_stock`, a document with any inventory movement, a surplus line
carrying money, and a surplus line an invoice or a return already points at
(remaining-to-invoice is `delivered − invoiced − returned`, so zeroing one of
those drives it negative). `qty <> 0` in the grouping query makes a re-run inert
and stops the five zeroed `HC-DO-007525` rows from re-grouping with each other
at quantity 0.

**What zeroing does NOT fix, deliberately** - the duplicate half of the
over-delivery, not all of it. Where the surviving quantity still exceeds the
ordered quantity, the cause is the *mis-link* half of the same writer defect (a
second AutoCount row of one code pointed at the FIRST sales-order line), plus
`HC-DO-006224`, which genuinely delivered a second unit two months after
`DO-005452` against a 1-unit order. That last one is a commercial question for
the owner about a real shipment, **not an ERP defect**, and the script leaves
one row per group standing precisely so it survives.

**Lesson** - a rowcount and a stock ledger answer different questions. Nothing
was wrong with inventory here, and an audit that only checked movements would
have called this clean while staff read it as a stock problem daily.

**Ref** - 2026-08-11, PR #1971 (fix/do-duplicates-and-fabric-merge). Prod
evidence: read-only diagnostic run 31450027318 (Section D), DRY-RUN 31451629651, APPLY
31451705673 - 18 rows zeroed, over-delivered 11 -> 7, every document total
identical. Full numbers in `docs/migrated-do-duplicate-lines.md`.

## A special add-on was costed and never charged, and the exempt lines were the migrated ones [high]

**Symptom** - the owner: *"让收费追上成本."* A priced special add-on on a sofa
line moved `unit_cost_sen` and never moved `unit_price_sen`. It could only ever
reduce margin. The same was true of any line whose product carried
`sell_price_sen = 0`, in any category.

**Root cause (traced, not guessed)** - the selling surcharge reached the
customer through exactly one expression in `mfg-pricing-recompute.ts`,
`effectiveBaseSen + breakdown.unitPriceSen`, behind one gate:

```
const hasAuthoritativeSelling = category !== 'SOFA' && effectiveBaseSen > 0;
```

Both halves of that gate were an exemption. `category !== 'SOFA'` sent every
sofa to a branch that rebuilt the price as `sofaSellingSen + fabricAddonCenti +
extraSen` and never re-added the surcharges - while the COST branch six lines
above it DID re-add its own, as `costSurchargesSen = costBreakdown.unitPriceSen
- costBreakdown.basePriceSen` on top of the module costs. One side of the same
function re-added the surcharge and the other dropped it. `effectiveBaseSen > 0`
then exempted every 0-priced product regardless of category.

**The trap in fixing it.** The exempt populations and the MIGRATED corpus are
very nearly the same set: 10,856 of 13,909 migrated lines are priced 0 and 549
of those are SOFA. A naive `|| surcharges > 0` therefore lands precisely on the
documents the owner's standing "A" ruling protects, and it lands there through
the CREATE path, which passes plain `true` rather than the `'including-zero'`
that #1954 gave the amendment path - and plain `true` reads a stored 0 as "not
provided" and fills a catalogue price anyway.

**Fix** - name the surcharge once as `breakdown.unitPriceSen -
breakdown.basePriceSen` (a subtraction, not a bare `unitPriceSen`, so a
future non-zero selling base cannot silently double-charge), add it to the sofa
branch so both sides of the function agree, and admit a 0-priced line to the
authoritative path when it carries a surcharge. The new arm is made **inert
under `trustOperatorSelling === 'including-zero'`** rather than relying on the
trust overwrite at the end of the function, so the migrated marker blocks it
structurally.

**Lesson** - when one function computes the same quantity twice, once for cost
and once for price, the two expressions must be written so that they cannot
drift - here, literally the same subtraction. And before widening a pricing
gate, count the rows the widened arm newly admits: the exemption you are
removing may be the only thing that was protecting history.

**Also settled** - `specialAddonsSurchargeSen` has no caller in either tree.
It is a WIRING GAP, not dead code: it is what a price-SUBMITTING client (the
drift-gated POS) must call now that the surcharge is charged, and it is inert
only while every add-on is priced 0. Deleting it would remove the fix for a
400 that the first priced add-on will cause.

**Ref** - 2026-08-11, owner decision in person, PR #1973. Pinned in
`backend/src/scm/lib/mfg-pricing-recompute.surcharge.test.ts`. Prod evidence:
read-only run **31452346210** measured the blast radius as **zero live
documents** - 11 of 36 catalogue codes ARE priced, but not one document line
carries any of them in `variants.specials` (SO migrated 0, SO live 0, PO
migrated 0, PO live 0). The same run states the old asymmetry in money: REAL
SELLING exposure 0 sen against REAL COST exposure 755,000 sen on all 27
candidate lines - the margin moved and the price never did.

## The last variant writer merging jsonb in JavaScript, with no shape guard and no read-back [med]

**Symptom** - none observed. `apply-variant-patch.mjs` is the reviewed
hand-patch escape hatch: a human or AI reads a Desc2 the regex parser cannot,
and the patch arrives gzip+base64 through a workflow input. Every other script
in this family had been brought up to the COE standard after the colour sweep
destroyed `variants` three times in an afternoon; this one had not, and it was
found by audit rather than by damage.

**Root cause (traced, not guessed)** - it merged the column in JavaScript:

```js
const [row] = await sql`SELECT variants FROM scm.mfg_sales_order_items WHERE id = ${p.id}`;
const v = { ...(row.variants || {}), ...(p.variants || {}) };
await sql`UPDATE scm.mfg_sales_order_items SET variants = ${sql.json(v)}, ... WHERE id = ${p.id}`;
```

That is correct on KEY PRESERVATION, which is why it never surfaced as the
"refresh scripts REPLACE the whole variants jsonb" bug - the spread carries every
key forward. It fails on the two things `docs/jsonb-double-encoding-coe.md` is
actually about:

1. **No shape guard.** Spreading a `variants` that is an ARRAY - the shape the
   double-encoding defect leaves behind, and which #1938's repair owns - yields
   `{"0": {...}, "1": "a stringified patch"}`. That is a *valid object*. The
   write would have converted a row `jsonb_typeof` can detect as damaged into
   one nothing can detect, silently, while reporting success.
2. **No RETURNING and no read-back.** `nItems++` counted attempts, not rows. The
   colour sweep reported `APPLIED - stamped 146 sofa lines` three times while
   appending a string to an array, because a command tag answers "did a row
   change", never "does the row hold what I meant".

It also held a read-modify-write window between the SELECT and the UPDATE in
which a concurrent writer's key could be read, forgotten and overwritten.

**Fix** - the write moved into the database.
`lib/variant-merge.mjs` gained `mergeReviewedVariantPatch`, a sibling of the
sweep primitive with the same protections and a deliberately different contract:
arbitrary keys are allowed (the patch IS the reviewed artifact - constraining it
to `OWNED_VARIANT_KEYS` would stop the escape hatch setting `seatHeight` or the
picker's `special`, the very fields it exists for), and geometry uses `COALESCE`
so a patch that says nothing about `gap` leaves gap alone. Guarded on
`jsonb_typeof(COALESCE(variants,'{}'::jsonb)) = 'object'`, bound with
`db.json(patch)`, counted from `RETURNING`, and every patched key re-read on a
FRESH CONNECTION before the script reports success - it exits non-zero if any
row does not hold the value that was written. `variants` is never read into
JavaScript any more.

Pinned by `tests/variantRefreshOwnedKeys.test.ts` (the script routes through the
library; no JS-side spread; no `SELECT variants`; a read-back exists) and by
`tests-pg/variantMergePreservesKeys.pg.test.ts` against a real postgres:16 (an
unowned key lands, untouched keys survive, an omitted geometry axis is not
nulled, and an array- or string-shaped column is REFUSED rather than coerced).
The stringified-bind assertion could not reuse the sweeps' blanket
`not.toContain('JSON.stringify')` - this script uses it legitimately in log
lines - so the test scans postgres.js TAGGED TEMPLATE bodies only, which is the
invariant that actually matters.

**Lesson** - "correct on key preservation" is not the same as "safe to write".
The three COE protections are independent, and a script can pass the one the
last incident was about while failing the two it was not.

**Ref** - 2026-08-11, PR #1970 (chore/po-variant-text-check).

## A fabric code was read as a bed height, because a measurement rule had no left boundary [high]

**Symptom** - `HC-GR-005122-PO-009576` recorded `divanHeight 151"` and
`totalHeight 160"`. No bed is 151 inches tall. The same row carries
`colourId PC151-01`.

**Root cause (traced, not guessed)** - the parse rules of the shape *number,
then keyword* in `lib/parse-bedframe.mjs` began with a bare `(\d+)`. `\d+` will
start in the MIDDLE of a token, so the digits of a fabric code qualified as a
measurement:

```
"PC151 divan"     -> divan 151"     (the code's series number)
"PC151-01 divan"  -> divan 1"       (the code's colour suffix)
"PC151 LEG 4"     -> leg 151"       (instead of the 4" actually written)
```

The `-01` form is the dangerous one: it yields a perfectly plausible 1", so a
range check can never see it. Reachable by every consumer of the parser - both
importers and both refresh scripts - not by one arm.

**The attribution that did NOT hold.** The handover recorded this row as that
parser bug. It is not: the parent PO line's text is
`"Hydraulic2pcs12”inner/PC151-01/gap9"`, and BOTH the pre-fix and post-fix
parsers read it as divan 14" (inner + 2, per the owner's #1883 rule). The 151
cannot be produced from that text by either. Its origin is **unproven** - most
likely an earlier parser generation, this module having drifted twice before
(a808bf36, 60125216). The correction stands on different evidence: the value is
physically impossible and the parent PO line agrees with its own AutoCount text.
Two true findings, one false link between them.

**Fix** - a number now qualifies as a measurement two ways: it starts cleanly
after a delimiter, OR it carries an explicit inch marker. The second alternative
is load-bearing, not defensive - `HC-SO-012781` carries `Hydraulic2pcs12”inner`,
a real 12" inner depth glued to the word before it, and a plain left-boundary
guard silently dropped it. A fabric code satisfies neither. Eight rule sites.

Scale, measured after the fix: **1** GRN line out of 442 holds an out-of-range
axis. The SO arm reports 149 and the PO arm 42 lines whose axis equals a digit
run of their own colour, and those are **coincidence, not corruption** -
`legHeight 1"` beside `PC151-01` is a real 1" leg. The proof they are sound is
Section B: every SO mismatch against its own text is accounted for by the
collision (71) or by an unresolved colour (7), and none is a height.

**Ref** - 2026-08-11, PR #1964 (fix/variant-collision-remainder). Prod evidence:
diagnostic run 31431814091. Tests in `tests/bedframeVariantLineIdentity.test.ts`.

## The GRN variant snapshot is written once and swept by nothing [med]

**Symptom** - a purchase-order line was repaired and the goods receipt taken
from it still showed the old value, with no check anywhere reporting the
disagreement.

**Root cause (traced, not guessed)** - `grn_items.variants` is copied from the
parent PO line at receipt and never written again. `refresh-so-variants.mjs`
writes `mfg_sales_order_items`, `refresh-po-variants.mjs` writes
`purchase_order_items`, and **neither touches `grn_items`** - an unswept third
arm that no parity check compared, so repairing a parent silently left its
receipt stale.

**Fix** - `diag-so-po-variant-divergence.mjs` Section E measures the arm:
442 lines carry variants, 331 agree with their parent, 110 differ plausibly, 1
holds an impossible figure. `repair-grn-variant-snapshot.mjs` restores only that
last class, gated on the figure being unable to be a measurement AND the parent
agreeing with its own AutoCount text. **A plausible difference is history and is
left alone** - a receipt is a snapshot, and rewriting one to match its order
today would destroy the record it exists to keep.

**Ref** - 2026-08-11, PR #1964. Prod evidence: diagnostic run 31431814091.

## The 7 variant mismatches that were never the collision: a colour left unresolved [low]

**Symptom** - after the collision was fully repaired, 7 migrated bedframe SO
lines still disagreed with their own AutoCount text. They had been counted since
the first diagnostic and never named, so nobody could say what they were.

**Root cause (traced, not guessed)** - one class, not seven problems. In every
one of the 7 the ONLY disagreeing axis is `colourId`, the stored value is
**NULL**, and the fabric matcher resolves the line's own text today:

```
HC-SO-009031 "Cream/Divan10/Gap13"                      -> KS-02
HC-SO-009031 "sliver/Divan10/Gap13"                     -> KS-15   (misspelt silver)
HC-SO-009614 "HC151-17/8inch+NoLeg/Gap14inch"           -> PC151-17 (HC typed for PC)
HC-SO-011289 "divan:10inch+noleg/PC151-101"             -> PC151-11
HC-SO-003154 "...Col:STAR-09"                           -> STAR-09
HC-SO-003154 "...Col:STAR-10"                           -> STAR-10 NAVY
HC-SO-010791 "...col:MB-04"                             -> MB-04
```

Every gap/divan/leg/size axis agrees. These are lines whose colour could not be
resolved when they were written and can be now, because the shared matcher and
the fabric library have both grown since (#1893, #1902). **Nothing is corrupt:
NULL means "not bound", which is honest.**

**Fix** - none applied, deliberately, and this is the finding rather than a
deferral. Two of the seven are why: `STAR-10` resolves to `STAR-10 NAVY`, one
half of the duplicate library pairs Section C censuses, so auto-filling would
bind a document to whichever spelling happened to win; and `PC151-101` resolving
to `PC151-11` MOVES A DIGIT, which is exactly what the shared matcher was
written to refuse (#1893). A 7-row backfill is not worth either risk without the
owner ruling on the duplicate pairs first.

**Ref** - 2026-08-11, PR #1964. Prod evidence: diagnostic run 31431814091,
Section B.

## The migrated-document writer inserted the same delivery line twice [high]

**Symptom** - `HC-SO-001920` ordered one `ELEPAHNE-(SK)` and showed four
delivery lines. Stock was never deducted once.

**Root cause (traced, not guessed)** - two independent mechanisms in
`create-migrated-documents.mjs`, both in the AutoCount-row-to-SO-line mapping:
`targets` took `cands[0]` for every row, so a second AutoCount row of one item
code produced a second delivery line pointing at the FIRST sales-order line; and
the sofa branch re-pushed every compartment of a build each time another row
named the same model. The document-level `done` guard hid neither, because the
duplication happens while ONE document is being built.

**Fix** - candidates are consumed in order (which also corrects the mis-link
underneath the duplicate: two rows of one code are two deliveries against two
different lines), a build is covered once per document, and an identical
`(so_item_id, item_code, qty)` on one document is refused outright so a future
mapping path cannot reintroduce the shape. A row with no unclaimed SO line left
is skipped and counted LOUDLY rather than reusing one - the same choice
`backfill-ac-line-keys.mjs` makes, for the same reason: a wrong link is worse
than none.

**The 18 rows already written are NOT removed.** `scm.delivery_order_items` has
no line-level cancel column and adding one is the deferred line-retirement work.
They cost no stock (0 movements) but they do inflate the order's arithmetic:
**11 sales-order lines read as over-delivered**. The exact rows, two options and
a recommendation are in `docs/migrated-do-duplicate-lines.md` for one owner
decision. Not to be confused with AutoCount's `DO-006224`, which genuinely
delivered a second unit - real data, a commercial question, not a defect.

**Ref** - 2026-08-11, PR #1964. Prod evidence: diagnostic run 31431814091,
Section D.

## The write freeze's owner/IT bypass granted nobody anything - it read an identity that does not exist yet at that point in the chain [high]

**Symptom** - the go-live write freeze is documented, and was believed, to
exempt the owner and anyone holding `scm.admin` so IT can still correct data
while staff are paused ("owner / scm.admin always bypass" - the middleware
header, `set-write-freeze.mjs`, and the workflow description all say so). It
never did. With the freeze on, EVERY caller was refused, including `*`. Nobody
reported it because the same accounts do their cutover repairs over
`DATABASE_URL` rather than through `/api/scm`, so the hole nobody could use was
also the hole nobody noticed.

**Root cause (traced, not guessed)** - `scm/lib/write-freeze.ts` read the caller
from `c.get('houzsUser')`. That variable is set in exactly one place,
`scm/middleware/auth.ts` (`supabaseAuth`), which every SCM sub-router mounts
ITSELF via `router.use('*', supabaseAuth)`. The freeze is mounted a level above,
at `scm.use('/*', scmWriteFreeze())` in `scm/index.ts`, so it runs a full routing
step BEFORE any sub-router middleware. `houzsUser` is therefore `undefined`
there, `perms` was always `[]`, and `BYPASS_PERMS.some(...)` was always false.

Proven by dispatching a Hono app assembled in the production shape (global auth
-> `scm.use('/*')` -> `scm.route(prefix, sub)` -> `sub.use('*', ...)`) and
recording what the freeze could see: `houzsUser` undefined, `user` populated.
That harness is now `backend/tests/writeFreezeMiddleware.test.ts`, whose "the
bypass" block fails with 503 against the old code.

The same line carried `hu?.is_owner`, a second dead branch: no identity in this
codebase has an `is_owner` field. The `houzsUser` type (`scm/env.ts`) does not
declare one and `scm/middleware/auth.ts` never sets one. It read as a
deliberate owner escape hatch and was nothing.

**What made it invisible** - the intact Houzs `AuthUser` IS in scope at that
point, in `c.get('user')`; `scmAreaGuard` reads exactly that, and says so in a
comment. The freeze was written against the other variable and no test covered
a bypassing caller, so two adjacent middlewares disagreed about where the caller
lives and nothing forced the question. `parseFreezeValue` had unit tests; the
middleware had none.

**Fix** - `callerBypasses(c)` checks BOTH `user` and `houzsUser` and grants on
either. Not defensive padding: the two identities swap over during the chain -
before `supabaseAuth`, `user` is the real caller; after it, `user` has been
replaced by the pinned permission-less scm.staff row and `houzsUser` is the real
caller. Reading both is correct wherever the middleware is mounted, so a future
reorder cannot silently revoke the bypass again. Both orderings are pinned by
test. `is_owner` is deleted; the god-position accounts (Lim, Nico) need no
special case because `hydrateAuthUser` PUSHES `'*'` into `permissions` for a
Super Admin / Owner position, so they arrive holding the wildcard.

**Ref** - 2026-08-11, feat/write-freeze-area-scope. Found while building the
per-module staged lift (`docs/write-freeze-staged-lift.md`).

## One owner ruling, two copies, and the copy the backfill reads had drifted [low]

**Symptom** - `NO HOLES ON STICHING` (and `NO STICHING`) arrived at
`backfill-specials-into-variants.mjs` as UNMAPPED and reached the ERP as no
picker tick at all, while `NO STICHING IN SITTING AREA` on the next slip mapped
fine. Both are verbatim from `data/ac-outstanding-so.json.gz`.

**Root cause (traced, not guessed)** - the `No notch on Seat Cushion` ruling is
implemented TWICE. `backend/scripts/lib/sofa-special-map.mjs:50-53` tests three
INDEPENDENT predicates - a negation, a stitch/hole/notch word, and a
seat/cushion word in which a stitch word ALSO counts:

```
yes: (s) => /\bno\b/.test(s) && /\bstitch\w*|\bstich\w*|\bholes?\b|\bnotch\b/.test(s)
  && /\bsit\w*|\bseat\w*|\bcushion\b|\bstitch\w*|\bstich\w*/.test(s)
```

`backend/scripts/data/special-order-phrase-map.json` - the copy the backfill and
the price audit read - expressed the same rule as ordered alternatives,
`\bno\b.*(stitch|stich|holes?|notch).*(sit|seat|cushion)` plus its reverse, and
dropped the stitch words from the third group. Two consequences: the phrase had
to contain three DISTINCT tokens in sequence, and a stitching word could no
longer stand in for the seat part. `no holes on stiching` satisfies the negation
and the hole word, then has nothing left for the seat group; `no stiching`
cannot satisfy both word groups from one token. The lib matched both, the JSON
matched neither, and only the JSON is wired to the backfill.

**Fix** - the family's `yes` becomes three independent lookaheads, which is the
lib's semantics written in one regex, with the stitch words restored to the
seat-part group. Measured over every `/`- and newline-delimited fragment of the
three AutoCount exports (2,902 distinct): **2 phrases gained, 0 lost, and the
JSON and the lib now agree on all 2,902** - the disagreement count is the real
assertion, because the drift is the bug and a same-answer count of zero is what
"one ruling" looks like.

**Regression test** - `backend/tests/parseSofaGrammar.test.ts` gains a
`special-order phrase map: the notch family` block: eight real slip phrases that
must map, five that must not (the `plane`/`plain` veto, an AKEMI pillow SKU
whose name contains "7 HOLES", the glued `Nostiching` the parser cannot split),
and a case asserting the JSON and the lib give the same answer for every one of
them. Confirmed to FAIL on the pre-fix map (3 red) and pass after.

**The class, for next time** - when one ruling is implemented twice, the test
that matters is not "does copy A behave" but "do A and B agree". The two copies
here were written days apart by the same reasoning and still diverged on a
detail nobody would think to re-check: whether the same TOKEN may satisfy two
conditions. Ordered `a.*b.*c` is not the same predicate as `a AND b AND c`, and
turning one into the other silently narrows it.

**Ref** - 2026-08-11, PR #1952 (fix/specials-phrase-map-stiching).

## The SO list said a document had NO purchase order while its own Relationship Map named one — the fix for the last version of this bug created this one [high]

**Symptom** - live production, `/scm/sales-orders`, company Houzs Century:
`HC-SO-011733` renders `—` in the PO No. column. The same document's
Relationship Map shows `PURCHASE ORDER HC-PO-008783` linked, and
`GRN HC-GR-004863` after it. Every row on the first page showed `—`.

**Root cause (traced, not guessed)** - not a missing join. The column reads
`source_po_union`, and that union is `soLineShippedSources` ∪
`soLineReadySourcePos` — **both arms require EXECUTION**. The shipped arm needs
a Delivery Order line carrying the `so_item_id`; the READY arm needs the line to
be READY *and* its bucket to hold an open lot that still resolves to a PO.
`HC-SO-011733` is CONFIRMED, all eight lines `stock_status='PENDING'`, zero DO
lines — and four of its lines DO carry `purchase_order_items.so_item_id` →
`HC-PO-008783` (status RECEIVED). That link was the old `converted_po_nos`
content, which the 2026-08-02 fix demoted to a **tooltip on the em-dash**.

Measured on production 2026-08-11 over the 2,723 Houzs Century sales orders:
at most **53** can light either source arm (23 have any linked DO line; 30 have
a READY line whose bucket holds a PO-resolvable open lot — 2,263 of the 2,366
open lots are migrated with neither `batch_no` nor a GRN, so they resolve to
nothing), while **277** carry a real non-cancelled PO on the line link. The
column was therefore blank for **~91%** of the orders that have a purchase
order. This is the SAME defect as the 2026-08-02 entry below, from the opposite
side: that fix replaced one incomplete arm with two other incomplete arms.

**Fix** - the cell renders the UNION of all three, with two chip identities that
are never conflated: SOLID = goods source (`source_po_union`), MUTED = raised PO
(`converted_po_nos`, filtered against the source set so a PO is never chipped
twice), each carrying its own tooltip. `—` now means "no purchase order of any
kind". Many-POs-to-one-SO is handled explicitly — the list cell caps at 3 and
appends a `+N` chip whose title lists every PO (12 Houzs SOs carry 2, one
carries 3), instead of rendering the first and staying silent. Before/after on
production: **53 → 295** sales orders show a PO number, a gain of 242. One pure
derivation (`frontend/src/lib/soPoChips.ts`) feeds desktop (`SoListPoCell` in
`components/SoSourceChips.tsx`) and mobile (`SourcePosRowMobile`'s new `raised`
slot), so the two surfaces cannot disagree about WHICH POs an order has. No
backend change: `converted_po_nos` was already on the list payload.

**The class, for next time** - a tooltip is not an answer. When a fix moves
information OUT of a cell because the cell's new meaning is narrower, check
what the cell now renders for the documents the new meaning cannot reach — here
that was the entire un-shipped migrated corpus, i.e. the go-live corpus. And
"the column is empty for every row on page one" is a population question, not a
row question: measure the arms against production before theorising.

**Ref** - 2026-08-11, `fix/so-list-po-and-specials-display`. Render tests for
both surfaces in `frontend/src/components/SoListPoCell.test.tsx`.

## A line's special orders printed twice — once as the raw slip phrase, once as the picker code the backfill derived from it [medium]

**Symptom** - `HC-SO-011733`'s lead line renders
`CH141-8-ARMY / SEAT 30 / LEG DEFAULT / SPECIAL: BACKCUSHIONCHANGE8030 + Change
8030 Backcushion + Wooden Arm`. One request, printed twice. The other five
lines of the same document are clean.

**Root cause (traced, not guessed)** - the DATA is correct and must stay.
`backfill-specials-into-variants.mjs` (PRs #1926/#1940) is deliberately
MERGE-ONLY and machine-asserts that it never drops a pre-existing entry (the
owner's 不可以删只可以 cancel rule), so a line whose slip already carried the
parser's glued `BACKCUSHIONCHANGE8030` now also carries the picker code
`Change 8030 Backcushion` the backfill mapped it to. `buildVariantSummary`
(`scm/shared/variant-summary.ts`) maps `variants.specials` 1:1 into the SPECIAL
segment with no dedupe and no validity filter, so both print.

**Fix** - display-layer only, no stored data touched. `foldRedundantSpecials`
hides an entry when another entry in the SAME list is a strictly richer twin of
it — same identity, contains it, or is a re-ordering of its parts (`skey`, the
parsers' own dedupe key: letters and digits only, nilon≡nylon, so the display
agrees with the writer about what "the same phrase" means). Deliberately narrow:
**only a SINGLE-TOKEN entry is ever hideable**, so a machine-glued artefact can
be suppressed and an operator's multi-word request never can. Ranking picks the
survivor — longer identity, then more word-parts (so the owner's spaced picker
code beats the glued form), then original order — a strict total order, so the
richest member of a twin group always survives and the segment can never be
emptied. Verified by running the SHIPPED function over production: of **1,051**
lines carrying specials, **216** rendered a redundant twin and now do not; **0**
emptied, **0** live picker codes lost.

**Where the phrase map was NOT put, and why** - folding the remaining **26**
lines needs semantics, not lexicon: `NOSTICHINGINSITTINGAREA` beside
`No notch on Seat Cushion`, `BACKRESTCHANGE8030` beside
`Change 8030 Backcushion` (backrest≡backcushion is an owner ruling). Only
`backend/scripts/data/special-order-phrase-map.json` knows that. It is a Node
script data file; the browser needs it too, because the SO detail page
(`SalesOrderDetailV2.tsx:733`) recomputes the summary client-side and PREFERS
its result over the stored `description2`. Reaching it would mean a copy in the
Worker bundle and a copy in the browser bundle — a fourth and fifth copy of a
ruling that is already implemented twice and **already drifted** (the entry at
the top of this file). Twenty-six lines is not worth that, so the residual is
measured and reported rather than guessed at. If the owner wants it, the honest
shape is: one canonical file + a mirror test, not two hand-kept copies.

**Also fixed on the way** - `backend/src/scm/shared/variant-summary.ts` and
`frontend/src/vendor/shared/variant-summary.ts` are byte-identical hand copies
with **nothing** guarding them, and this fix had to land in both. A byte-equality
test now pins them (`frontend/src/vendor/shared/variant-summary.test.ts`), which
is also the first test this module has ever had for its specials output.

**Ref** - 2026-08-11, `fix/so-list-po-and-specials-display`.

## The ERP composed an AutoCount edit that would append duplicate lines, and its own refusal would have been invisible [critical]

**Symptom** - none observed: the write-back has never been switched on. Had it
been, editing any sales order or purchase order would have appended a second
copy of every untouched line into the live AED_HOUZS book.

**Root cause (traced, not guessed)** - `composeEdit` emitted a line with no
`DtlKey` whenever `linked_ac_dtlkey` was NULL, and AcSyncService's `/edit` read
a keyless line as "genuinely new" and called `AddDetail()`. The reading is only
sound if keyless means new. It did not: the create routes returned the DocNo
alone and never the created DtlKeys, so every ERP-created document had NULL line
identity forever, and the cutover-migrated documents were never backfilled.
Measured on production 2026-08-11 from a read, BEFORE the backfill: **0 of
13,907** SO lines and **0 of 864** PO lines on AutoCount-linked documents
carried a key. The PR's own tests asserted the appending behaviour as correct.

**Fix** - `composeEdit` now throws `KeylessLineError` when ANY line lacks a
usable DtlKey, refusing the whole edit; `enqueueEdit` records it as a `skipped`
outbox row reading `refused, nothing sent: ...` and naming the offending line.
Widening `noteReadFailure` to carry that second error type was load-bearing, not
tidying: it only handled `AcReadError`, so without it the refusal would have
been swallowed by the catch and returned false - a write-back that silently
declines to sync is indistinguishable from one that has quietly broken.

Two follow-on findings, both caught by tests rather than by reasoning:

- composing the edit EAGERLY broke a legitimate path. When a document's create
  is still unsent in the outbox, an edit replaces that create's payload instead
  of queueing an edit - and a document that has never reached AutoCount cannot
  have line keys yet, so the refusal fired on a case that was always fine.
  `composeSoState` / `composePoState` now return the edit as a thunk.
- create and convert responses now carry `lines: [{Seq, DtlKey, ItemCode,
  Desc2}]` and `persistLineKeys` stores them, but it VERIFIES the index-zip by
  count and ItemCode first and writes nothing if either disagrees. A wrong
  DtlKey is worse than none: a missing key is refused loudly by the new guard, a
  wrong one silently edits a different line in a live account book.

**Ref** - 2026-08-11, PR #1936 (feat/ac-erp-line-identity). C# half in #1935.

## A bedframe SO line was stamped with a DIFFERENT line's build, because the Desc2 lookup was keyed on the document instead of the line [high]

**Symptom** - 14 migrated bedframe sales-order lines disagreed with the purchase
order raised from them on colour, mattress gap or divan height, while the
AutoCount `Desc2` was **byte-identical on both documents** (md5 confirmed per
line in production). It was first read as a commercial dispute - the customer's
order and the factory's naming different fabrics - which it never was.

**Root cause (traced, not guessed)** - `refresh-so-variants.mjs` built its
parsed-`Desc2` lookup as

```js
parsed.set(`${r.DocNo}|${erp.toUpperCase()}`, parseBedframe(r.Desc2))
```

`(AutoCount DocNo | ERP item code)` is **not a line identity**. One order
routinely carries several rows of the same SKU in different colours or heights,
so `Map.set` kept only the LAST of them, and the lookup at the write site then
stamped that single parse onto EVERY database line sharing the key. Measured on
the checked-in export with no database access: **183 keys collide carrying a
genuinely different `Desc2`, losing 298 lines**. `SO-006572` / `NK-1046 (Q)` is
the defect in one document - three lines, `PC151-01`/gap 10", `PC151-02`/gap 10"
and `PC151-14`/gap 12" - all three stamped `PC151-14`/gap 12", which is exactly
the double conflict reported against that order's PO.

The PO arm carried the identical defect and mostly escaped it: a RECEIVED PO is
not "outstanding", so `ac-outstanding-po.json.gz` holds only 338 rows and nearly
every PO line fell through to the per-line `description2` fallback, which is
line-accurate by construction. That asymmetry is the whole reason `Desc2` backed
the PO on **27 of 27** conflicting axes, and why the SO looked like the liar.

`DtlKey` - unique across all 13,588 export rows - was in the export the entire
time. The database side (`linked_ac_dtlkey`) only arrived at 17:57Z on
2026-08-11, three and a half hours AFTER the variant write at 14:17Z, so the
script had no line identity to key on when it ran.

Two claims in the handover were refuted by the same evidence. `HC-SO-012781` was
listed as an exception where `Desc2` backed the SO's 12"; it does not.
`Hydraulic2pcs12”inner` states the INNER depth, and the owner's own rule
(#1883, "inner的话就是inner+2") converts an inner-only figure at +2, so that bed's
divan is 14" and the PO was right - the SO's 12" is its sibling line's
`frontdrawerdivan12”`, stamped on by the collision. The reported `divanHeight`
of 151" is not on either document; both PO lines read 14" and 12".

**Blast radius** - the 14 were the visible tip. Of 2,381 migrated bedframe SO
lines, 92 disagree with their own line's AutoCount text and **85 are exactly
what the collided key would have produced**. The rest were invisible only
because no PO happened to contradict them.

**Fix** - both refresh scripts key on `DtlKey` and resolve each line by its own
`linked_ac_dtlkey`, falling back to that line's own `description2`; the
AutoCount-to-ERP code CSV is retired from both, since a line identity needs no
code translation. `cross-fill-so-po-variants.mjs` carried the same collision on
both of its indexes and now pairs on `purchase_order_items.so_item_id`, refusing
any leftover `(SO no | code)` group that is not one-to-one rather than taking
the last. `repair-collided-so-variants.mjs` rewrites the affected rows from
their own line's text, gated on the row currently holding exactly what the
collided key produced, MERGING into `variants` so specials and unknown keys
survive, guarded by `jsonb_typeof(variants) = 'object'`, counting `RETURNING`
rather than the command tag and re-reading every row on a fresh connection.
`bedframeVariantLineIdentity.test.ts` pins the invariant.

**CLOSED 2026-08-11.** The remaining 71 rows were repaired after the evidence
that was missing arrived. The repair joins the line's own `linked_ac_dtlkey`,
but that key was itself set by a POSITIONAL zip over the same
`(DocNo | item code)` pair that collided (`backfill-ac-line-keys.mjs`), so
joining on it inherits the guess rather than escaping it. A third gate settles
it: the row's own `description2`, written per line by the importer from the very
export row it created that line from and never written by either refresh script,
must match the export row the stored key addresses. Production reads **2363
corroborated, 0 contradicted** - the zip recovered every binding it claimed.

All 71 passed the gate, 71/71 were returned by the UPDATE and read back on a
fresh connection. The diagnostic moved **agree 2289 -> 2360, mismatch 78 -> 7,
collision-attributable 71 -> 0**. The 7 that remain are a different fault
entirely, recorded in its own entry (an unresolved colour, not wrong data). 14
lines carry no `DtlKey` at all and were NOT
repaired by position: 13 of them were checked against their own `description2`
and agree, and one (`HC-SO-000015 JAGER-(Q)`) has no text to check.

**Ref** - 2026-08-11, PR #1951 (diagnostic), PR #1958 (writer), PR #1964
(the remaining 71 + gate 3). Prod evidence: apply run 31432521529, verification
run 31432632597.

## The first cancelled sales-order line ever written would have printed on a customer PDF, and could have made a sofa order permanently un-shippable [high]

**Symptom** - none seen yet by staff, and that is the point: the two conditions
were created hours apart by two changes that did not know about each other, on
two live orders (`HC-SO-012624`, `HC-SO-013167`).

**Root cause (traced, not guessed)** - `scm.mfg_sales_order_items.cancelled` has
existed for a long time and ~85 places filter on it, but until 2026-08-10
**nothing had ever written it and production held zero such rows**, so no reader
had ever been exercised with one. `restore-deleted-so-lines.mjs` (PR #1937, run
31424084270) then reinstated two hard-deleted sofa modules as `cancelled = true`
- correctly, under the owner's rule 不可以删只可以 cancel - and became the first
writer. Two readers were wrong for a cancelled row:

- `sofa-batch-guard.findIncompleteSofaSets` defines a sofa set as every line of
  the SO with `stock_status = 'READY'`, with no cancelled filter. A cancelled
  line can never appear on a DO, so it would be missing from every delivery and
  the guard would refuse **every DO for that Sales Order** with 409
  `sofa_partial_set`, naming an item the operator had already removed.
  `HC-SO-012624` is `READY_TO_SHIP` with two READY sofa modules, so it was one
  column away from being un-deliverable. It escaped only because the restore
  script enumerates its INSERT columns and never writes `stock_status`, leaving
  the row on the column default instead of the READY sibling's value - and
  `so-stock-allocation` filters `cancelled = false`, so nothing would ever have
  moved it. Avoided by an omission in a repair script, not by any guard.
- `GET /mfg-sales-orders/:docNo` returns cancelled rows deliberately (they are
  the order's history), and `sales-order-pdf.ts` had no notion of `cancelled`
  and totalled every row handed to it. Only `SalesOrderDetailV2.tsx` filtered.
  The mobile detail, the SO list bulk print and both consignment callsites did
  not, so a phantom sofa module printed on a customer-facing document. RM 0 in
  this instance only because the importer puts a build's whole price on its
  first piece.

**Fix** - both reads in `findIncompleteSofaSets` now filter `cancelled = false`,
so the set definition no longer depends on how a row was written.
`renderSalesOrderInto` - the single function the one-doc and combined generators
both render through - drops cancelled rows, putting the gate in one place
instead of five; `MobileSODetail` also filters at the use site so the phone and
desktop V2 agree. The two production rows were left exactly as they are:
un-cancelling puts a phantom module back into a live order, and deleting them
again is what caused this. `backend/scripts/check-cancelled-so-line-readers.mjs`
+ **Cancelled SO line — reader check (read-only)** replays each guard's own
predicate against the live rows so the next person measures instead of arguing.

**Ref** - 2026-08-11, PR #1956. Evidence and the remaining gaps in
`docs/autocount-line-retirement-plan.md`.

## Approving any amendment on a MIGRATED sales order overwrote its AutoCount price with the catalogue price [high]

**Symptom** - none observed yet, and that is the only reason this is not
critical: the importer never sets `internal_expected_dd`, so a migrated SO is
never processing-locked, never `amendment_eligible`, and cannot reach the
amendment path today. The moment anyone gives such an order a Processing Date
that then elapses, the next approved amendment - **including a QTY-ONLY one** -
rewrites `unit_price_centi` to `mfg_products.sell_price_sen`.

**Root cause (traced, not guessed)** - `recomputeFromSnapshot` takes
`trustOperatorSelling` as its **15th positional parameter**, defaulting to
`false`. `recomputeOneLine` - the amendment path's only pricing entry point -
called it with **14** positional arguments, so the flag could not be passed at
all and every amendment silently got the authoritative behaviour. Three other
call sites (`mfg-sales-orders.ts` 4113 / 7655 / 8181) DO pass it, derived from
`!isPosTabletCaller(c)`, so a web operator's hand-typed price is trusted at
CREATE time and discarded at AMENDMENT time - the same operator, same order,
same price, a different answer depending on which screen they used. A
15-argument positional call is what made the omission invisible; nothing about
it reads as wrong.

Worse for migrated data specifically: an AutoCount sofa is frequently carried as
the whole-set price on ONE lead module line with **0 on its siblings**. Plain
`trustOperatorSelling: true` would not have saved those siblings either - the
existing guard is `manualUnitSelling > 0`, and `trusted(0) -> 10000` is asserted
in `mfg-pricing-recompute.trust.test.ts` - so each 0 sibling would still have
been handed a catalogue price and the set billed several times over.

**Fix** - `TrustSelling = boolean | 'including-zero'`. `recomputeOneLine` gains
an **options object** (`opts.trustOperatorSelling`), not a 5th positional, and
forwards it; `applySoAmendment` reads `linked_ac_docno` off the SO header it was
already loading for `company_id` and passes `'including-zero'` for a migrated
order, `false` otherwise - so NATIVE orders keep today's authoritative
behaviour exactly. `'including-zero'` treats a stored 0 as a real price.

Converting `recomputeFromSnapshot`'s 14 optional positionals to an options object
was considered and **deliberately not done**: it has 14 call sites, 9 of them in
a 10,000-line route file several agents are editing concurrently, and a
mis-shuffled argument there is a money bug with no type error. The options object
was introduced at `recomputeOneLine` instead, which has exactly two call sites.
The regression guard is behavioural rather than structural: three tests drive
`recomputeOneLine` through a stubbed client, and dropping the forwarded argument
fails two of them (verified by reverting the line).

**Ref** - 2026-08-11, PR #1954 (fix/so-amendment-migrated-price).

## Editing a SHIPPED delivery order never reached the stock ledger [high]

**Symptom** - silent, and stock. An operator changes a line qty, deletes a line
or adds one on a DO that has already shipped. The document saves, the screen
agrees, the paperwork is right - and inventory does not move. Since 2026-08-05
the failure at least leaves a `RECOUNT_FAILED` audit row instead of nothing.

**Root cause (traced, not guessed)** - `resyncInventoryForDo` writes DELTA
movements into the same `(source_doc_type='DO', source_doc_id, product_code,
variant_key)` bucket the first ship already wrote. Production carries a PARTIAL
UNIQUE index on exactly that key, `uq_inv_mov_do_source`, and `movement_type` is
NOT in it - so one bucket holds exactly ONE row, ever, and every delta is a
duplicate key. `writeMovements` returns `{ ok: false }` and the ledger never
moves.

That index is **prod-only DDL that existed in no file in this repo**, which is
why the comment above the function claimed for months that "migration 0109
dropped the per-bucket UNIQUE so we can freely write multiple delta rows over
time". Read against the migration tree, that was a reasonable belief. Read
against `pg_indexes`, it was false. Measured on production 2026-08-11 (Actions
run 31426819498): **ZERO** movements carry the function's own notes marker - it
had never landed a single row. PR #1941 corrected the comments; the DEFECT was
still open.

**Damage** - 8 `(DO, item)` pairs across **4** delivery orders have a ledger that
disagrees with their document (2990-DO-2607-016/017/018/019), and all 8 are
ORPHAN MOVEMENTS - stock that moved with no line behind it - i.e. the
already-ledgered duplicate-DO pair and the MAKOTO variant drift, not this defect.
A first pass reported 19 DOs; the extra 15 were Houzs Century documents flagged
`migrated_no_stock` (mig 0276) that move no stock BY DESIGN. **No backfill is
needed for this defect**: because every delta was REJECTED rather than
mis-posted, the ledger was never corrupted by it - it simply never followed the
edit. What is lost is unrecoverable-by-code anyway (nobody knows what the pre-fix
edits intended), and nothing must be deleted to repair it.

**Fix** - migration 0279 adds `scm.inventory_movements.correction_seq smallint`
and replaces `uq_inv_mov_do_source` with `uq_inv_mov_do_source_v2`, keyed on
`(..., COALESCE(correction_seq, 0))`. NULL = the document's PRIMARY posting, so
every existing row folds to 0 and the double-post backstop is unchanged; 1..N =
numbered corrections, which now insert. The `COALESCE` is load-bearing - a bare
nullable column in a UNIQUE key would let two NULL first-ship rows coexist and
silently remove the backstop. The migration cannot fail to build: over existing
data the new index is byte-for-byte as strict as the old one, and production has
0 duplicate DO buckets (the 503 that exist are 501 `AC_CUTOVER` + 2
`STOCK_TRANSFER`, neither indexed). The three sibling prod-only indexes (DR /
CS_DO / CS_DR) are recorded in the same file with `IF NOT EXISTS` - a no-op
against production - so the repo stops lying about its own schema.

**Rejected alternatives, and why** - (a) *add `movement_type` to the index*: it
permits exactly one IN and one OUT per bucket, so the operator's SECOND edit is
still rejected. A half-fix on a silent money path is worse than none;
`doResyncCorrectionSeq.pg.test.ts` pins that case. (b) *post the deltas as
`source_doc_type='ADJUSTMENT'`, the way the CANCEL path sidesteps the same
index*: this looks like consistency and is a trap. The whole DO family already
assumes a resync delta IS a `'DO'` row - `restampDoActualCost` nets over `'DO'`,
`fn_reverse_do_out` aggregates `'DO'`, and its step (c) exists SOLELY to close
"phantom lots minted by this DO's OWN delta-IN movements"; `fn_reconcile_uncosted_out`
and `fn_reconcile_dropship_batch` both require `'DO'` before they will cost a
short OUT; and the FIFO trigger copies `source_doc_type` onto every lot and
consumption row. Worst of all, **both** cancel-path idempotency guards
(`reverseInventoryForDo` and `fn_reverse_do_out`'s `v_existing` check) read "an
ADJUSTMENT row exists for this DO id" as "already reversed" - so a DO that had
merely been EDITED could never be CANCELLED: consumptions never deleted, lots
never restored, stock permanently deducted. That is a worse bug than the one
being fixed and it is invisible from the resync function alone.

**Ref** - 2026-08-11, PR #1957 (fix/do-resync-ledger). Comments corrected earlier
in #1941; see the entry below for that.

## A CANCELLED purchase order could be hard-purged from the database [high]

**Symptom** - not a crash; a capability that should never have existed.
`DELETE /api/scm/mfg-purchase-orders/:id` removed a CANCELLED PO's header and,
by FK cascade, every line. Both surfaces offered it: the desktop detail page
("Permanently delete PO ... This removes the header + all line items and cannot
be undone") and the phone action bar.

**Root cause (traced, not guessed)** - it predates the owner's rule
不可以删只可以 cancel, and nothing later re-checked it against that rule. The
code knew what it was doing and said so: the audit row written immediately after
the purge is documented as "the ONLY remaining evidence that the PO existed",
with po_number / supplier / total snapshotted into `field_changes` because
"nothing can be joined back to afterwards". An audit row that has to carry a
copy of the document is not an audit trail, it is an obituary. It is also a
cancel-divergence generator the moment AutoCount sync goes live: AutoCount keeps
a cancelled PO, a purged one has no row to reconcile against, and no way to tell
whether the ERP ever held that document.

**Fix** - the endpoint is gone, along with `useDeletePurchaseOrder`, the desktop
button and the mobile action. CANCELLED already did everything the delete was
used for: the PO leaves every working list, releases its SO quota and clears its
allocation sub-lines. The only thing delete added was losing the record.
Explicitly NOT removed, and called out in a comment where the endpoint used to
be: the create-time rollback deletes in `POST /` and `POST /from-sos`.
supabase-js has no transaction, so those compensating deletes are the only thing
standing between a failed line insert and a headerless orphan document - they
remove a document that never successfully existed. Removing them would be a
serious regression. The SO equivalent was audited and left alone: it is
DRAFT-only and refuses anything else with "A confirmed order must be cancelled,
not deleted", which is the rule already being honoured.

**Lesson** - when a comment has to explain that an action destroys the only
evidence of its own subject, the comment is the review finding.

**Ref** - fix/po-no-hard-delete, 2026-08-11

## Two more document-level hard deletes, and nobody had swept for the rest [high]

**Symptom** - the same capability the entry above removed from purchase orders
existed in two more modules. `DELETE /api/scm/purchase-consignment-orders/:id`
purged a CANCELLED PC Order, header and lines, behind a desktop "Permanently
delete" button. `DELETE /api/scm/quotes/:id` purged a quote with **no status
guard at all** - any quote in the active company, at any point in its life, by
id, including one already promoted to a sales order.

**Root cause (traced, not guessed)** - two separate causes, and the second is
the one that matters. (1) The PC Order module is a line-for-line clone of
`mfg-purchase-orders.ts`; the frontend hook said so in its own comment, "Cancel
+ delete (mirror PO)". The delete was copied along with everything else, and
copied WITHOUT the audit row the PO version at least wrote, so a purged PC Order
left no trace anywhere. (2) Nobody had ever swept for this class. Three hard
deletes were found on three separate occasions, one endpoint at a time, which is
the signature of ad-hoc discovery rather than an audit - so there was no way to
know whether three was the whole list.

The quote case had a second layer: `scm.quotes` (mig 0101) has no status column,
`expires_at` is written by nothing, and `promoted_to_order_id` is set only by a
conversion that already happened. Delete was not merely the worst retirement
path, it was the ONLY one. Removing it alone would have left the module unable
to close a quote at all.

**Fix** - both endpoints removed, with their callers:
`useDeletePurchaseConsignmentOrder` and the desktop CANCELLED-state button for
the PC Order; nothing for quotes, which has no frontend at all. PC Order already
had `PATCH /:id/cancel`, so removing the delete cost it nothing. Quotes did not,
so mig 0279 added `cancelled_at` / `cancelled_by` (the sibling documents' shape)
and `PATCH /quotes/:id/cancel` was built to use them - "open" now means not
promoted AND not cancelled, in the list filter, the edit path and the partial
index. Create-time rollback deletes left in place in both modules with comments
saying why. Two stale comments that still cited "Delete PO" as a live example
corrected (`MobileModuleDetail.tsx`, `PurchaseOrderDetail.tsx`), plus two
refusal messages in the PC Order module telling users to "delete" a PC Receive
that has no delete either.

The sweep that should have happened first now exists:
**`docs/hard-delete-inventory.md`** classifies all 70 `DELETE` handlers on the
SCM route surface plus every supabase `.delete()` call as VIOLATION / COMPLIANT
/ ROLLBACK-KEEP, records why each draft-discard and rollback is legitimate, and
names the one violation left open (`DELETE /trips/:id?hard=true` - no guard, but
zero callers and a different module's guide, so flagged not smuggled). Module
guides written for both modules, neither of which had one.

**Lesson** - a bug found three times in one day is not three bugs, it is one
missing audit. The fix for the third instance is the inventory, not the third
patch. And check what a delete is doing for the module before removing it: on
quotes it was carrying the retirement path, and deleting the delete without
replacing it would have shipped a dead end.

**Ref** - fix/remove-remaining-hard-deletes, 2026-08-11

## The DO code disagrees with itself about a UNIQUE index, and production settled it against the resync path [high]

**Symptom** - two comments in `delivery-orders-mfg.ts` assert opposite facts
about the same index. `deductInventoryForDo` says "the existence check + UNIQUE
index mean this never double-deducts"; `resyncInventoryForDo` says "Migration
0109 dropped the per-bucket UNIQUE so we can freely write multiple delta rows
over time". Both cannot be true. Migration `0230:130-134` enumerates this
table's indexes as `warehouse_id/product_code`, `source_doc_type/source_doc_id`,
`created_at`, `company_id` and calls out that `batch_no` "had no index at all" -
four non-unique indexes, no mention of a unique one - so reading the migration
tree makes the deduction guard look like a bare TOCTOU check.

**Root cause (traced, not guessed)** - the migration tree is not the schema. The
index's DDL is prod-only, ported from 2990, and exists in no file in this repo.
Read live from `pg_indexes` on 2026-08-11 (Actions run 31417585775, the existing
read-only *Duplicate movements check*):

```
CREATE UNIQUE INDEX uq_inv_mov_do_source ON scm.inventory_movements
  USING btree (source_doc_type, source_doc_id, product_code, variant_key)
  WHERE (source_doc_type = 'DO'::text)
```

Four such indexes are live (`_do_`, `_dr_`, `_cs_do_`, `_cs_dr_`). So the
deduction comment is TRUE and the resync comment is FALSE. Which matters,
because `movement_type` is NOT in that key: one `(DO, product_code,
variant_key)` bucket may hold exactly one movement row of any kind, ever. Every
delta `resyncInventoryForDo` writes for a bucket the first ship already wrote is
a duplicate key, is rejected, and the ledger does not move. The same run
confirms it empirically - zero DO buckets anywhere in production hold more than
one movement row, which is what an enforced index looks like, not what a
"freely write multiple delta rows" design looks like.

What still lands is a delta for a bucket with NO first-ship row: a newly added
line, or an existing line whose recomputed `variant_key` differs from the one it
shipped under. That second case is how the MAKOTO divergence
(`docs/inventory-ledger-divergence-coe.md`) wrote an OUT that consumed no lot -
it got through the index precisely because its key had drifted.

**Fix** - documentation only, deliberately. Every comment that named "migration
0100" / "migration 0109" now carries the live-verified definition and the run id
instead of a migration number that does not exist in this tree;
`resyncInventoryForDo` and the line-delete handler carry an explicit warning
that their delta write is rejected for an already-shipped bucket;
`docs/modules/delivery-order.md` quotes the index verbatim. The ACTUAL defect -
edit-after-ship qty changes never reaching the ledger - is NOT fixed here. It is
an owner-owned, staging-first change to the money-critical FIFO layer, and there
are exactly two shapes (add `movement_type` to the index, or stop the delta rows
reusing the DO source key, which is how the reversal path already solved it with
signed ADJUSTMENT rows). Since 2026-08-05 the rejection is at least logged
rather than silent.

**Lesson** - this repo's own rule, earned twice now: verify schema claims
against the live database, not migration files. The second half of the lesson is
new - when two comments in one file contradict each other about a constraint,
that is not a documentation defect, it is a design that was built on the losing
half.

**Ref** - fix/do-deduct-guard-truth, 2026-08-11 (evidence: Actions run 31417585775)

## The migrated DO writer copied no classification, so the whole SO -> DO leg audited an empty set [high]

**Symptom** - `check-sofa-chain-alignment.mjs` reported LEG 3 (SO -> DO) as "10
pairs, 0 aligned, 10 carry no variants", and every earlier report filtering
delivery-order lines with `WHERE item_group IN ('sofa','bedframe')` returned
nothing at all and read as clean. Company 2's 41 sofa/bedframe DO lines all
carry their own tag; company 1's carry none.

**Root cause (traced, not guessed)** - `create-migrated-documents.mjs:257`
inserts a delivery-order line with SEVEN columns - `delivery_order_id`,
`so_item_id`, `item_code`, `description`, `uom`, `qty`, `company_id` - and never
`item_group`, `variants` or `description2`. The GRN writer in the SAME FILE
(`:142`) copies `item_group` and `variants` from its PO line, which is exactly
why nobody noticed: one arm of one script was right and the other was silent.
`scm.delivery_order_items` has all three columns - the UI's own writer
(`delivery-orders-mfg.ts:3484`) fills them - so this was never a schema gap.
The contrast with company 2, whose DO lines were not made by this writer, is the
proof that the NULLs are the writer's doing and not drift.

**Fix** - the writer now pulls `item_group`, `variants` and `description2` with
the SO line and writes all three, and `backfill-do-line-snapshot.mjs` fills the
rows it already wrote from their parent SO line (`so_item_id`), because a
delivery order is a SNAPSHOT OF THE SALES ORDER AT DISPATCH. Lines whose
`so_item_id` is NULL are reported and LEFT ALONE - inferring the group from
`mfg_products.category` would work and would also be a guess written into a
snapshot column, indistinguishable from a fact afterwards.

**Lesson** - a child document is a snapshot, so a writer that copies the
quantity and not the classification produces rows that are invisible to every
filter written against the parent's vocabulary. The failure mode is not an
error, it is a zero - and a zero reads as "clean". When two writers in one file
copy different column sets, that asymmetry is the bug.

**Ref** - fix/chain-residue-repair, 2026-08-11

## A compartment correction hard-DELETED two sales-order lines, against the owner's cancel-only rule [medium]

**Symptom** - `HC-SO-012624` and `HC-SO-013167` each hold two live sofa lines
and no cancelled third, while production run 31393696809 logged `removed 2`.
The record that a third piece was ever on either order is gone.

**Root cause (traced, not guessed)** - `apply-sofa-compartment-corrections.mjs`
pairs existing rows to the corrected piece list and DELETEs whatever is left
over (`:182`, `:198-199`). It refuses when a PO, GRN or DO line points at the
surplus row, and it aborts the build if the document total would move, so the
deletion was guarded on money and on references - but not on the owner's rule
`不可以删只可以 cancel`, which arrived after the run. Confirmed against the
DATABASE rather than the log, because a log line is not evidence:
`diag-sofa-cutover-residue.mjs` section E prints both documents' current rows
and finds no cancelled row to recover.

**Fix** - `restore-deleted-so-lines.mjs` reinstates each row CANCELLED at 0
price. `scm.mfg_sales_order_items.cancelled` is `boolean NOT NULL DEFAULT
false`, so no schema change was needed - but `scm.purchase_order_items`,
`scm.grn_items` and `scm.delivery_order_items` have NO `cancelled` column at
all (asked of `information_schema`, section H), so the two arms of that script
are NOT symmetrical and the PO arm cannot simply mirror the SO arm. The restore
snapshots the whole header row as jsonb before and after, inside the same
transaction, compares every key plus the line sums, and ROLLS BACK if anything
moved.

**Lesson** - "no money moved" is not the same as "nothing was lost". A guard
that checks totals and foreign keys still lets a document forget its own
history. And never assume two line tables are symmetrical: ask
`information_schema`, or the second arm dies at 42703 mid-run.

**Ref** - fix/chain-residue-repair, 2026-08-11

## A frozen write reads as an outage on every path that is not the vendored SCM client [medium]

**Symptom** - with the go-live write freeze ON, a refused write answered
"The service is briefly unavailable. Please try again in a moment." That is an
outage sentence for a deliberate business decision, and it instructs the person
to do the one thing the freeze exists to stop. The SCM pages did NOT show it -
they showed the operator's real explanation - and that asymmetry is what pointed
at the client rather than the server.

**Scope, measured rather than assumed.** Every SCM document write goes through
`vendor/scm/lib/authed-fetch.ts`, whose `humanApiError` reads `reason` and
therefore already showed the right sentence. The core `api/client.ts` makes
exactly ONE write to `/api/scm/*` today - `pages/Team.tsx:3243`, the
showroom-parking PATCH - so that is the only surface currently mis-reporting the
freeze. The bug is nonetheless worth fixing rather than noting: `api/client.ts`
is the DEFAULT client for anything not vendored from 2990, so every future SCM
write written outside the vendor layer inherits it, and the operator-message cap
below closes a hole that DOES hit the main SCM path.

**Root cause (traced, not guessed)** - `scm/lib/write-freeze.ts` returned the
explanation in a field called `reason` only. `authed-fetch.ts` `humanApiError`
reads `reason`; `api/client.ts` `humanHttpMessage` read only `error` / `message`
/ `detail`, and `write_frozen` is not in its `ERROR_CODE_MESSAGES`, so the
sentence was dropped and the generic 503 line spoke instead.

The second half is worse than the copy, and it is confined to the same client:
`isColdPool503` decides whether a MUTATION may be retried by regex-testing that
humanised message for "briefly unavailable | warming up | try again in a
moment". The generic 503 line contains two of them, so a frozen write on that
path was silently re-sent four more times over about ten seconds before the
operator was told anything - five refusals per press. (`authed-fetch` tests the
raw BODY instead of the humanised message, which is why it never retried a
freeze.)

The hole that DOES reach the SCM floor: both clients discard a server sentence
of 200 characters or more and fall back to their generic 5xx line. The freeze
message is operator-typed in `app_config.description`, so a long one would have
put "The system hit a problem. Please try again" in front of every SCM save.

**Fix** - the backend sends the same sentence in `message` AND `reason`, so
neither client can miss it, and `freezeMessage()` caps an operator-typed
description at the 200 characters both clients will render, falling back to a
default that says saving is paused, that nothing is broken, and that retrying
will not help. `humanHttpMessage` now also reads `reason`. The mutation retry
stops firing on a freeze as a CONSEQUENCE of the copy no longer containing the
cold-pool phrases, not as a second special case. `write_frozen` was deliberately
NOT added to `ERROR_CODE_MESSAGES` in either client: both maps are consulted
BEFORE the server sentence, so an entry there would override the operator's own
`app_config.description`, which is the entire purpose of that column.

**Lesson** - a refusal's wording is part of its contract. When retry logic keys
off humanised copy, a missing message field is not cosmetic: it changes what the
client DOES. And two error humanisers that read different fields will diverge
silently - the one you are not looking at is the one that is wrong.

**Ref** - fix/freeze-message-not-outage, 2026-08-11

## `String(pgDate).slice(0,10)` produced "Wed Jun 24", and it aborted the sofa stock opening on its first INSERT [medium]

**Symptom** - the first-ever APPLY run of `import-ac-sofa-stock.mjs` against
production (run 31420345698, 2026-08-11) died immediately with
`PostgresError: invalid input syntax for type timestamp with time zone:
"Wed Jun 24T00:00:00Z"`. None of the 109 planned sofa lots were written.

**Root cause (traced, not guessed)** - `:169` built the build's receipt date as
`String(l.po_date).slice(0, 10)`. `po_date` comes back from the `postgres`
driver as a **JS `Date`**, and `Date.prototype.toString()` is the locale form
`"Wed Jun 24 2026 08:00:00 GMT+0800 (…)"` - not ISO. Slicing ten characters
yields `"Wed Jun 24"`. The writer then pasted that straight into the SQL text as
`` `'${p.receivedAt}T00:00:00Z'` ``, so Postgres received the literal
`'Wed Jun 24T00:00:00Z'`.

The other date source was fine and is worth recording so nobody "fixes" it too:
`ac-stock-layers.json.gz` stores `Date` as a clean `"YYYY-MM-DD"` **string**, so
the same slice was correct there. One expression, two callers, only one of them
holding a `Date` - which is exactly why it survived every dry-run: the dry-run
never reaches the INSERT, and the projection does not touch the date.

**Fix** - one `isoDay()` helper that branches on `instanceof Date` (ISO via
`toISOString()`) versus a string with a leading `YYYY-MM-DD`, returning null
rather than a malformed value, applied to BOTH date sources. The INSERT now
**binds every value** instead of interpolating any of them into the SQL text,
so a bad value can no longer become syntactically-valid-looking SQL. Progress
logging tightened from every 50 rows to every 25 so a partial write is visible.

**Verified** - a re-run of the DRY-RUN read `already opened by an earlier run: 0`,
confirming from an independent query that the aborted APPLY wrote **nothing** and
left no partial state to compensate for.

**The class, for next time** - `String(x).slice(0,10)` is only an ISO date when
`x` is already an ISO string. Against a driver that hydrates `date`/`timestamp`
columns into `Date` objects it silently produces a weekday-prefixed fragment.
Use `toISOString()`, and **bind dates as parameters** - had the value been bound
rather than interpolated, the driver would have serialised the `Date` correctly
and the bug would never have existed.

**Ref** - 2026-08-11, PR #1942 (fix/stock-criterion-close).

## The stock reconciler excluded sofa by AutoCount's ItemGroup, so 85 units of pillows and stools read as a phantom ERP surplus [medium]

**Symptom** - the per-warehouse reconcile (`check-stock-vs-autocount.mjs`, prod
run 31419069241) reported the ERP holding 149 units MORE than live AutoCount
over the comparable cells, and named a 25-cell / 98-unit class
`CUTOVER ADJUSTMENT ONLY - seeded once and untouched since`. Twelve of those
cells claimed AutoCount held NOTHING at all against real ERP stock, the largest
being `SQUARE PILLOW @ BALAKONG WAREHOUSE: AutoCount - vs ERP 46`.

**Root cause (traced, not guessed)** - the exclusion at `:152` was
`if (g === "SOFA")`, where `g` is the AutoCount item master's `ItemGroup`.
AutoCount files 41 codes under `ItemGroup = SOFA`; only 22 of them are whole
sofa sets. The other 19 - `DSL-SQUARE PILLOW`, `AMN-LONG PILLOW`,
`HOK-SQUARE PILLOW`, `RDS-SGABELLO`, `DSL-STOOL 1`, `LV-3068 BOLSTER`, the
`THL-xxxx` single-seaters and the rest, 85 units - are pillows, bolsters and
stools that `data/autocount-erp-mapping-1561.csv` correctly categorises as
`ACCESSORY`.

`import-ac-stock-balance.mjs` excludes on that CSV category
(`isSofaFurniture`, built at `:64` from column 4), NOT on the ItemGroup. So the
importer BROUGHT THOSE 85 UNITS IN, the ERP holds them, and the checker then
refused to look at the AutoCount side of the same cells - reporting real,
correctly-imported stock as a surplus the other system did not have.

Measured against the live export: of the 85 units, **77 are present on both
sides** and 11 of the 12 cells reconcile exactly once the excluded codes are
summed. The genuine residual is **+8 units**, all on
`SQUARE PILLOW @ BALAKONG WAREHOUSE` (ERP 46 vs AutoCount 38). So the corrected
net delta over comparable cells is **+72 units, not +149** - 52% of the reported
gap was the checker's own filter.

**Fix** - exclude on the binding CSV's category column, byte-identical to
`import-ac-stock-balance.mjs:64`, and report separately how many units are
compared despite carrying `ItemGroup = SOFA`. The `g === "SOFA"` test is gone.

**The class, for next time** - this is `D7` in `docs/stock-reconciliation.md`
one layer up. D7 was "excluded accessories by matching /SOFA/ against the item
CODE"; this is "excluded accessories by matching SOFA against the item GROUP".
The invariant both violate: **a reconciler's exclusion must be the same
predicate as the importer's.** If the importer brought a row in, the ERP holds
it and it must be compared - otherwise the check manufactures the very
discrepancy it exists to find. Categorise by the field the importer used, never
by a field that merely sounds like it means the same thing.

**Ref** - 2026-08-11, PR #1942 (fix/stock-criterion-close). Found by an
independent read while closing go-live criterion 3.

## /edit appended a duplicate of every line into the live account book, and a line could not be retired without deleting it [critical]

**Symptom** - none yet, and that is the point: the ERP -> AutoCount write-back
has never been switched on. Had it been, the first EDIT of any sales order or
purchase order would have written a SECOND COPY of every line the operator did
not touch into the live AED_HOUZS book. On a purchase order those duplicates
are permanent - see the root cause.

**Root cause (traced, not guessed)** - two halves of one missing concept, line
identity.

(1) `AcSyncService.Edit` addresses a line by AutoCount's `DtlKey`
(`doc.EditDetail(dtlKey)`, the only line handle the 2.2 SDK exposes) and fell
through to `doc.AddDetail()` when a line had none. The fallback reads as "this
must be a new line", but no line had a key: the create routes returned
`so.DocNo` alone and never the created DtlKeys, so every ERP-created document
had NULL line identity forever, and the migrated documents were never
backfilled. Measured on production 2026-08-11 from a read: **0 of 13,907** SO
lines and **0 of 864** PO lines on AutoCount-linked documents carried a
`linked_ac_dtlkey`. Every line was keyless, so every line would have been
appended.

(2) Retiring a line had no representation at all. The string `Cancelled`
appears ZERO times in `sdk-api-reference.txt` - no detail class has a
line-level cancel - and only `SalesOrder` exposes `DeleteDetail`.
`PurchaseOrder`, `PurchaseInvoice`, `GoodsReceivedNote`, `Invoice` and
`DeliveryOrder` have no line-removal method whatsoever. So for half the go-live
slice AutoCount offers neither delete nor cancel at line level, which is why
the duplicate a PO edit appended could never have been removed.

**Fix** - `/edit` now REFUSES a keyless line instead of appending one, in a
pre-flight pass over every line before any detail is touched, so a refusal
leaves the document exactly as AutoCount already had it. A genuinely new line
must say so with `IsNewLine: true`. Refusing is safe: the document does not
sync and the outbox row is visibly failed. Appending is not recoverable.
Alongside it, every create/convert route now answers with the created DtlKeys
(`lines: [{Seq, DtlKey, ItemCode, Desc2}]`) so line identity exists from the
moment a document is created, and a line can be retired in place with
`Retire: true` - `Qty = 0` plus `Transferable = false` plus an
`[ERP-CANCELLED]` Desc2 marker. `Qty = 0` is the load-bearing part and is
deliberately NOT wrapped in the exception-swallowing `Set()` helper: AutoCount's
own outstanding predicate is `Qty - ISNULL(TransferedQty,0) > 0`, so a silently
skipped zero would leave the line outstanding in AutoCount while the ERP
believed it cancelled.

The backfill that fills the migrated documents' keys was also changed to SKIP
any group whose ERP and AutoCount line counts disagree rather than zipping the
first N. A wrong DtlKey is strictly worse than no DtlKey - no key is refused
loudly by the new guard, a wrong key silently edits a different line in a live
book.

**Ref** - 2026-08-11, PR #1935 (feat/ac-line-identity). C# half needs a manual
build on the AutoCount host: `docs/autocount-service-deploy.md`.

## The AutoCount write-back read four columns the PO table has never had, and one the SO items table did not have yet [critical]

**Symptom** — with the write-back toggle on, a purchase order created in the ERP
would reach AutoCount as NOTHING at all, and a sales order would reach it as a
header with an EMPTY line list. Both silently: no error, no failed outbox row,
nothing to notice it by. Found by the payload contract test in PR #1898 before
the toggle was ever turned on, so no live document was affected.

**Root cause (traced, not guessed)** — two selects naming columns that are not
there, and one shared swallow.

1. `enqueuePoCreate` and `composePoState` asked `scm.purchase_orders` for
   `creditor_code, creditor_name, agent, ref`. That table is SUPPLIER-keyed —
   `supplier_id` into `scm.suppliers`, which carries `code` and `name` — and it
   has no `agent` or `ref` at all. Verified against the schema dump, not
   assumed: its 18 columns are `id, po_number, supplier_id, status, po_date,
   expected_at, purchase_location_id, currency, subtotal_centi, tax_centi,
   total_centi, notes, submitted_at, received_at, cancelled_at, created_at,
   created_by, updated_at`, plus `company_id`, `revision`, the supplier delivery
   dates, the PO-email columns and the `linked_ac_*` refs from later migrations.
2. The SO and PO line selects asked for `linked_ac_dtlkey`, which migration
   0273 adds and which was still sitting in an unmerged PR (#1819).

**PostgREST does not ignore an unknown column — it fails the whole query with
42703 and returns a NULL body.** The code took only `data` and dropped `error`,
so `header` became null (the PO functions returned false inside their own
try/catch: a silent no-op) and `items ?? []` became an empty array (the SO
composed a document with no Details). #1855's own body described the second one
as "every line is new, correct-but-degraded"; it was every line MISSING.

**Fix** — three parts, all in `scm/lib/autocount-outbox.ts`:

- the PO reads name the real columns (`id, po_number, po_date, supplier_id,
  notes, linked_ac_docno`) and join `scm.suppliers` for the creditor code and
  name. `Agent` and `Ref` are null on a create because the ERP has no such
  field; the PO EDIT omits `Ref` entirely rather than sending null, because
  `/edit` applies only the keys it is given (`h.ContainsKey`, AcSyncService.cs:369)
  and a null would blank whatever the account book has there.
- every select's column list is named ONCE at the top of the file, so a phantom
  column has one place to enter instead of four.
- **a read that FAILS is no longer a read that found nothing.** `readOrThrow`
  turns a PostgREST error into a throw; the enqueue logs it and writes a
  `skipped` outbox row carrying the database's own message, and composes
  nothing. Same rule `recordConvertSkipped` already followed: a divergence that
  is written down can be found.

PR #1819 (migration 0273, `linked_ac_dtlkey` on both item tables) was merged
first — it is the real dependency, and the same column is what lets an edit
address an existing AutoCount line instead of appending a duplicate.

**Where the phantom columns came from** — there are TWO tables named
`purchase_orders` in this database, in different schemas and with different
shapes. `scm.purchase_orders` is the ERP's own, supplier-keyed. The one in the
default schema (`db/schema.pg.ts:440`) is the **AutoCount mirror** — `doc_no`,
`creditor_code`, `creditor_name`, `remaining_qty` — filled from AutoCount's own
outstanding-PO export. The composer was written against the mirror's shape and
run against the ERP's, and the SCM Supabase client is pinned to
`db: { schema: 'scm' }`, so `sb.from('purchase_orders')` was never going to
reach the table those four columns live on.

**The class, for next time** — a Supabase/PostgREST select is not a projection
that degrades: one wrong column takes the whole row set with it. Two habits fall
out of that. Never write `const { data } = await sb...` on a path whose empty
result is meaningful — take `error` and decide. And check a column against the
schema before selecting it: `autocount-outbox.test.ts` now runs its fake
PostgREST with a list of columns the table does NOT have, and answers 42703 for
them, which is what makes these two bugs fail a test instead of a live account
book.

**Ref** — 2026-08-10, PR #1855 (feat/ac-writeback-wiring-v2), found by #1898.

## The AutoCount write-back would have written orders with NO LINES, and no PO at all [critical]

**Symptom** — None yet, and that is the point: the ERP -> AutoCount write-back
(#1855) ships behind two off switches, so nothing it does can be seen until
someone turns it on. A contract audit against the AutoCount half found thirteen
places where the two programs disagree about the same JSON document, four of
them fatal, and none of them would have announced itself — `AcSyncService.cs`
reads a field with `Str(p, "X")`, which returns `""` for a field that is not
there rather than an error.

**Root cause** — Traced per finding, not guessed; all thirteen are listed with
both sides in `docs/modules/autocount-writeback.md` section 11 and pinned
mechanically by `backend/src/services/autocount-writeback.contract.test.ts`. The
four that block:

- **The line select asks for `linked_ac_dtlkey`**, a column PR #1819 has not
  landed. PostgREST does not ignore an unknown column — it fails the whole query
  with 42703 — so `items` is null, `items ?? []` is empty, and **every Sales
  Order would have gone into the account book with no lines at all.** #1855
  describes this state as "every line is new ... correct-but-degraded".
- **`enqueuePoCreate` and `composePoState` select `creditor_code`,
  `creditor_name`, `agent` and `ref` from `scm.purchase_orders`**, which has none
  of them (it is supplier-keyed). Same 42703, and both functions `return false`
  inside their own `try/catch`: PO create and PO edit are a silent no-op.
- **`makeItemCodeResolver` is never called** by anything but its own unit test,
  so every `ItemCode` on the wire is the raw ERP code, which AutoCount does not
  have.
- **A sofa goes over as one AutoCount line per compartment.** The ERP stores a
  sold sofa as N rows sharing `variants.buildKey`; `toDetails` is a 1:1 map; the
  resolver points all N at the SAME AutoCount sofa code. One sofa sold would
  book qty N and take N off AutoCount's stock.

The unit tests in #1855 pass because their fake PostgREST does not know the
schema — it returns whatever the fixture holds, whatever columns you ask for.

**Fix** — **Two of the thirteen are fixed, in #1855, and struck off the
register: D11 and D13** — the two above that are plain bugs rather than
decisions (the entry above this one carries them). **The other eleven stand.**
Each needs a decision that is not a test author's to make, and the mechanism is
off. What this PR ships is the means to see them: a contract test that reads
`AcSyncService.cs` at build time and extracts the keys it actually parses, a
fake PostgREST that enforces `scm`'s real column lists, and a divergence
register that fails if a fourteenth appears AND fails if one of these is fixed
without being struck off. Plus `backend/scripts/ac-trial-dry-run.mjs`, which
posts the same contract at a TEST book behind four gates and never runs by
default.

**The class, for next time** — a fake database that accepts any column name will
green-light a query against a table that does not exist. If a test double stands
in for a schema, give it the schema.

**Ref** — 2026-08-10, PR test/ac-writeback-trial. Findings against #1855
(unmerged); register in `docs/modules/autocount-writeback.md` section 11.

## The write-back wiring test failed on Windows and passed in CI [low]

**Symptom** — `tests/autocountWritebackWiring.test.ts` reported "anchor not
found after mfgSalesOrders.post('/:docNo/items/:itemId/tbc-update'" on a local
Windows checkout, while the same commit was green in CI.

**Root cause** — Traced to the bytes, not guessed. `?raw` hands back the WORKING
TREE contents, and with `core.autocrlf=true` those are CRLF while git stores LF.
Three of the anchors end in `});
`, which exists in the blob and not in the
checked-out file. Every other anchor in the suite is a single line, which is why
only these three failed.

**Fix** — Normalise the raw imports to LF before matching, in that suite and in
the new contract suite beside it. A source-anchored test must not mean different
things on different platforms — and this one runs on the owner's Windows box.

**Ref** — 2026-08-10, PR test/ac-writeback-trial.

## Two migrations both numbered 0276 [medium]

**Symptom** — `main` carried `0276_scm_migrated_documents.sql` and the open
#1855 carried `0276_scm_autocount_outbox.sql` [renumbered]. Merged as they stood, `pg-migrate`
would have two files claiming one number.

**Root cause** — Exactly the case `CLAUDE.md` warns about: #1855 picked its
number when it branched, not at merge time, and `0276` was taken while it sat
open. `pg-migrate` tracks by full filename, so gaps and out-of-order merges are
safe and duplicates are not.

**Fix** — Renamed the unapplied one to `0277_scm_autocount_outbox.sql` and
updated the four references to it in `docs/modules/autocount-writeback.md`. Safe
because it has never run anywhere: #1855 is not merged, so no deployment has an
`APPLIED 0276_scm_autocount_outbox.sql` [renumbered] line to be confused by the rename.

**Ref** — 2026-08-10, PR test/ac-writeback-trial.
## "APPLIED - stamped 146 sofa lines", three times, and it was corrupting them [high]

**Symptom** — `refresh-sofa-colours.mjs` was dispatched against prod with
`apply=1` three times on 2026-08-10 (runs 31405014029, 31408769884,
31409522533) and reported `APPLIED - stamped 127 / 146 / 146 sofa lines` with
`raced` 0, meaning every single UPDATE came back with a non-zero rowcount. The
dry-run 29 seconds after the last one (31409538247) reported the identical
`already set 440 / TO FILL 146`. In fact **every** run of the script that day —
15:22, 15:42, 16:24, 16:25, 16:26, 16:33, 16:35 — reported `already set 440`.
419 claimed stamps moved the number zero times.

**Root cause (traced, not guessed)** — the write was not lost. It landed, and
it destroyed the column. Probe run 31416469998 read the raw jsonb of five lines
an apply claimed to have stamped:

```
[{"colourId": null, "fabricId": null, "specials": [], "legHeight": "Default",
  "seatHeight": "28", "colourLabel": "J9047-1-Brunette", ...},
 "{\"fabricId\":\"GIRONA J9047\",\"colourId\":\"GIRONA J9047-01 BEUNETTE\",...}",
 "{\"fabricId\":\"GIRONA J9047\",...}",
 "{\"fabricId\":\"GIRONA J9047\",...}"]
```

`variants` is an **array**: the original object, then one JSON **string** per
apply run. The chain, every link verifiable:

1. `refresh-sofa-colours.mjs` bound `JSON.stringify(u.patch)` — already a
   string — to a `$1::jsonb` parameter.
2. postgres.js is configured `prepare: false`, and `connection.js:238` sets
   `describeFirst = q.onlyDescribe || (parameters.length && !q.prepared)`. With
   parameters and no prepared statement that is unconditionally true, so the
   driver sends Parse+Describe and **waits for the server to tell it the
   parameter types** before it binds (`connection.js:632-633`).
3. The server resolves `$1` to jsonb, OID 3802.
4. `types.js:17-19` registers `serialize: x => JSON.stringify(x)` for the json
   type, and `types.js:205-206` installs that serializer under every OID in its
   `from` list — 114 **and 3802**. So the driver JSON-encoded the value a
   second time and sent `"{\"fabricId\":...}"`.
5. `$1::jsonb` therefore evaluated to a jsonb **string scalar**, not an object.
6. In PostgreSQL `jsonb || jsonb` only merges when **both** sides are objects.
   Object `||` non-object concatenates into an array. `variants` became
   `[original, "patch"]`.
7. `variants->>'fabricId'` on an array is NULL, so
   `COALESCE(variants->>'fabricId','') = ''` stayed true and the guard admitted
   the row again on the next run — which is why there is one appended string
   per apply, and why `raced` was 0 every time.
8. The row genuinely was updated each time, so the command tag genuinely said
   `UPDATE 1`. `res.count` was reporting the truth about the wrong question.

Why the day's other applies were fine, which is what made this look like a
driver-wide fault: `apply-sofa-compartment-corrections.mjs` binds `tx.json(p.v)`
— an object, encoded once — and `import-ac-outstanding-so.mjs` calls
`tx.unsafe(text)` with **no** parameter array, which takes the simple protocol
where no serializer runs at all. Neither can hit this. The defect is not
`sql.begin`, not `unsafe`, not Hyperdrive, not the pooler: it is
`JSON.stringify` into a jsonb parameter.

**This class was already in the tree, twice.** `check-specials-and-ocr.mjs:67`
and `check-sofa-bedframe-completeness.mjs:57` both carry comments describing
exactly this trap after `backfill-sofa-special-orders.mjs` did it to
`custom_specials` earlier the same day (#1913). Those comments taught readers to
*tolerate* the bad shape; nobody fixed the writers, so a third script walked
into it hours later.

**Fix** — PR #1938.
- `tx.json(u.patch)` instead of `JSON.stringify(u.patch)`. An explicit
  `Parameter` carries its own type, so `ParameterDescription` does not overwrite
  it (`connection.js:632` only fills types that are falsy) and the object is
  encoded exactly once.
- The same one-line change in the three other scripts that still bound a
  stringified value to a jsonb parameter — `backfill-sofa-special-orders.mjs`,
  `backfill-specials-into-variants.mjs`, `cross-fill-so-po-variants.mjs` —
  because leaving a proven trap loaded in three places is how it found a fourth.
- The statement now ends in `RETURNING variants->>'fabricId'` and the script
  counts **what came back**, not the command tag.
- A shape repair driven by `jsonb_typeof(variants) = 'array'`, not by the fill
  list: `variants = variants -> 0` restores the original object. It is scoped by
  shape so that a damaged row whose colour no longer resolves is still repaired,
  and it refuses any array whose element 0 is not an object.
- The script re-opens a **new connection** after `sql.end()` and prints the
  bound count before and after. It emits `::error::` if the count did not move.

**Lesson** — a non-zero rowcount answers "did a row change", never "does the row
now hold what I meant". Any sweep that reports success from a command tag is
reporting its own intention. Verify with `RETURNING`, and confirm with a read on
a fresh connection; the script that just wrote is the worst available witness.
And: never hand a pre-serialized string to a json/jsonb parameter in
postgres.js — pass the value and let `sql.json()` type it.

**Ref** — 2026-08-10, PR #1938 (fix/colour-write-persistence). Evidence: probe
run 31416469998; damage confirmed by the database itself refusing
`jsonb_object_keys` on those rows.

## The apply that hit the corrupted rows from the other side, and rolled back [medium]

**Symptom** - the prod apply of the zero-priced specials subset, run
31417530815, printed its whole report and then
`ROLLED BACK - path element at position 1 is not an integer: "specials"`.
Exit 1, nothing written.

**Root cause (traced, not guessed)** - the same damage as the entry above, met
from the writing side instead of the reading side. `refresh-sofa-colours.mjs`
had turned some `variants` values into jsonb ARRAYS (#1938). This backfill
writes with `jsonb_set(COALESCE(variants, '{}'::jsonb), '{specials}', ...)`,
and a jsonb path element addresses an OBJECT key - against an array Postgres
demands an integer index and raises exactly that error. `COALESCE` is no
defence: it replaces SQL NULL, not a JSON value of the wrong shape. The script
had the shape guard on its READ side already and none on its WRITE side.

One malformed row failed the statement, and because this apply deliberately
runs as a SINGLE transaction, the other 413 lines rolled back with it.

**Fix** - the shape check now runs before a line is queued, and a line whose
`variants` is not an object is SKIPPED and listed in the report. It is NOT
coerced to `{}`: that would delete whatever the array holds, and the owner's
rule of 2026-08-11 is 不可以删只可以 cancel - #1938's `variants = variants -> 0`
repair is the right owner of those rows, not this backfill. A second guard sits
in the UPDATE's WHERE (`variants IS NULL OR jsonb_typeof(variants) = 'object'`)
for a row that changes shape between the read and the write; it is left alone,
shows as a shortfall in the affected-row count, and rolls the transaction back
rather than half-applying.

**What this run got RIGHT, and is worth copying** - the failure was loud and
total. Because the apply sums the affected rows' money columns inside one
transaction and throws on any difference, an unrelated error rolled everything
back. The batched `sql.begin`-per-200 shape the older backfills use would have
committed the first batch and then died, leaving the data half-written.

**The class, for next time** - `COALESCE(col, '{}'::jsonb)` reads like "make
sure this is an object". It is not; it only handles SQL NULL. A jsonb column
with several writers over several years holds shapes nobody declared, so test
`jsonb_typeof` before addressing a path inside it. And corruption spreads by
blocking the NEXT writer, not only by being read wrong - this backfill found
#1938's damage without looking for it.

**Ref** - 2026-08-11, PR #1940 (fix/specials-variants-not-object), after run
31417530815. Origin of the bad shape: #1938.

## The variant refresh scripts REPLACE the whole variants jsonb, so any key they do not know about is dropped [medium]

**Symptom** - not yet observed in production; found while landing the
zero-priced half of the specials backfill, which merges picker codes into
`variants.specials` and is therefore directly exposed to it.

**Root cause (traced, not guessed)** - `backend/scripts/refresh-so-variants.mjs`
builds `const variants = {...}` from scratch at `:89-96` - eleven keys, no
spread of the row's existing `it.variants` - and then writes the whole column:
`UPDATE scm.mfg_sales_order_items SET variants = ${sql.json(u.variants)}`
(`:114-116`). `backend/scripts/refresh-po-variants.mjs` is the same shape
(`:83`, `:104-105`). A bedframe row's twelfth key does not survive the next
refresh run, whoever wrote it and for whatever reason.

The script itself shows the merge was understood and simply not applied on the
main path: the non-bedframe `sizeOnly` branch three lines earlier DOES spread,
`variants: { ...(it.variants || {}), size: bf.size }` (`:77`).

A concrete casualty, provable from the code rather than hypothetical:
`variants.special`, the HOOKKA-compatible singular the picker reads beside the
plural - `specialsList(variants.specials ?? variants.special)`,
`SpecialOrders.tsx:91`. `backfill-specials-into-variants.mjs` deliberately reads
and preserves it; neither refresh script carries it, so a refresh run silently
deletes a pick the picker was showing. Sofa lines are NOT exposed - they take
the spreading `sizeOnly` branch - so this is a bedframe-line defect.

**Fix** - both sweeps now compute a PATCH and merge it; neither ever writes the
whole column. `backend/scripts/lib/variant-merge.mjs` is the single owner of
both halves:

- `OWNED_VARIANT_KEYS` declares the ten keys a Desc2 re-parse is entitled to
  move (fabric/colour block, gap/divan/leg/total, size). `assertOnlyOwnedKeys`
  throws if a builder emits anything else, so widening what the sweep owns is a
  deliberate edit and never an accident.
- the write is `variants = COALESCE(variants,'{}'::jsonb) || <patch>` in the
  DATABASE, so a key nobody has heard of survives BY CONSTRUCTION - there is no
  list of foreign keys to keep in step, and no read-modify-write window either.
  Every statement carries `jsonb_typeof(...) = 'object'` in its WHERE (object
  `||` non-object CONCATENATES - see the double-encoding COE), counts with
  `RETURNING`, reports the rows that guard skipped, and re-reads the merged ids
  on a FRESH connection.

Two keys left the sweeps' ownership at the same time, both for the same reason -
they have a better-guarded owner:

- `variants.specials` belongs to `backfill-specials-into-variants.mjs`. A picked
  add-on's selling surcharge folds into the authoritative unit price
  (`mfg-pricing.ts:396-415`), so re-stamping a PRICED code reprices a historical
  migrated document, which the owner ruled out on 2026-08-11. That backfill
  refuses priced codes and proves the money columns did not move inside its own
  transaction; the sweeps resolved codes against every BEDFRAME add-on whatever
  its price, and derived a NARROWER set than
  `data/special-order-phrase-map.json`, so a run would have both repriced and
  shrunk lines #1926 had just filled.
- `custom_specials` is a DERIVED output of the pricing recompute. #1944 nulled
  478 of them on exactly that reasoning hours earlier; a sweep refilling it
  would have undone that.

**Regression test** - `backend/tests/variantRefreshOwnedKeys.test.ts` pins the
declared key set (and that `specials`/`special`/`custom_specials` are NOT in
it), asserts every patch builder stays inside it, and reads both script sources
to fail if any `variants =` is ever an assignment rather than the merge form,
if a merge loses its object guard or its `RETURNING`, or if either sweep starts
writing `custom_specials` again. `backend/tests-pg/variantMergePreservesKeys.pg.test.ts`
executes the merge against a real postgres:16 (`backend-postgres` ->
`npm run test:pg`) and reads the row back: the unknown keys are still there, the
column is still an OBJECT (which is also the double-encoding proof), an
array-shaped row is skipped rather than concatenated, and a stray key in a patch
is refused before it reaches SQL.

**The class, for next time** - `SET jsonb_col = <fresh object>` is a delete of
every key the fresh object does not mention. When a jsonb column has more than
one writer - and `variants` has the importers, both refresh sweeps, the POS
configurator, the SO/PO line editors and now a backfill - the only safe write
is a merge on the keys you own: `jsonb_set` on one key, or `col || patch`.
Rebuilding the object is only correct when you are the sole writer, and here
nobody is. And "the keys I own" is a thing to WRITE DOWN and assert, not a thing
to remember: the list that must stay in step with reality is the short one you
own, never the open-ended one you do not.

**Ref** - recorded 2026-08-11 in PR #1926 (fix/specials-zero-priced-subset);
fixed 2026-08-11 in PR #1949 (fix/variant-refresh-preserve-keys). Neither sweep
had been dispatched between the two, so nothing was lost in production.

## A priced SOFA special add-on is costed but never charged [med]

**Symptom** - `scm.special_addons` rows carry `selling_price_sen` and
`cost_price_sen`, and the SOFA-category rows are priced like the BEDFRAME ones
(`Seat Behind Extend 5"` 50000/50000, `5540 Backrest` 5000/5000). Picking such
an add-on on a sofa line raises the line's COST by the add-on's cost price but
never raises what the customer is charged. Margin moves the wrong way, silently,
and a director who prices a sofa add-on gets no revenue from it.

**Root cause (traced, not guessed)** - the selling and cost paths disagree about
whether SOFA takes the specials surcharge.

- SELLING: `mfg-pricing.ts:400` computes `specialsSurchargeSen` for SOFA from
  `maintenanceConfig.sofaSpecials`, and `:408-415` folds it into
  `breakdown.unitPriceSen`. But `mfg-pricing-recompute.ts` consumes that value in
  exactly one place - `:435`, `authoritativeSellingSen = effectiveBaseSen +
  breakdown.unitPriceSen` - and `:436` gates it on
  `category !== 'SOFA' && effectiveBaseSen > 0`. The SOFA branch prices from
  `computeSofaSellingSen + fabricAddonCenti + extraSen` (`:563`) and never adds
  the specials surcharge; the un-priceable sofa falls through to the operator's
  own price (`:571`). In the whole recompute file `specialsSurchargeSen`
  otherwise appears only in a comment (`:369`) and as the persisted REPORTING
  field `special_order_sen` (`:603`).
- COST: `:463` sets `unitCostSen = costBreakdown.unitPriceSen`, which includes
  the specials cost for every category, and the sofa module-cost branch then
  re-adds the same surcharges (`:490-491`) - its own comment says "line-level
  cost surcharges (sofa leg / specials) stay on top".

The client cannot compensate either: `specialAddonsSurchargeSen`
(`mfg-pricing.ts:275`), whose docstring says "the POS configurator adds this to
the line's live total so it matches the server recompute", has **no callers** in
`backend/src` or `frontend/src`.

**Fix** - none yet; recorded here because it changes an owner pricing decision
rather than being a safe unilateral edit. Either the sofa selling path should add
`breakdown.specialsSurchargeSen` the way the cost path does, or the SOFA add-on
rows should not carry a selling price. Whichever way it is settled, selling and
cost must agree - today they cannot both be right.

**Lesson** - a surcharge that is computed is not a surcharge that is charged.
`specialsSurchargeSen` was present in the breakdown, persisted to a column named
`special_order_sen`, and visible in reports, which made it look live; the money
question is only ever answered by tracing which branch writes
`unitToPersistSen`.

**Ref** - fix/special-addon-prices-from-autocount, 2026-08-11

## A migrated DO line carries no item_group, so every DO-side audit filtered itself down to nothing [medium]

**Symptom** - the sofa document chain had never been checked past the purchase
order, and every attempt to check it came back empty rather than clean. A
delivery-order query written the obvious way, `WHERE item_group IN
('sofa','bedframe')`, returns **zero rows** over the entire 2026-08 cutover
corpus. Zero reads as "nothing to worry about", so the DO leg of the chain had
no coverage at all while appearing to have some.

**Root cause (traced, not guessed)** - `create-migrated-documents.mjs:257`
writes a DO line with exactly seven columns: `delivery_order_id`,
`so_item_id`, `item_code`, `description`, `uom`, `qty`, `company_id`.
`item_group`, `variants` and `description2` are never written, so they are NULL
on every migrated DO line. The GRN writer in the same file (`:142`) *does* copy
`item_group` and `variants` from the PO line, which is why the same mistake on
the GRN leg never showed up and why the DO shape was assumed to match. Measured
on prod company 1: item_group NULL on 10 of 10 sofa/bedframe DO lines,
variants NULL on 10 of 10, description2 NULL on 10 of 10. Company 2's 41 DO
lines all carry their own item_group - they were not made by this writer, and
that contrast is what proves the NULLs are the writer's doing rather than the
data's.

**Fix** - `check-sofa-chain-alignment.mjs` classifies a DO line by its own tag,
then by the `item_group` of the SO line its `so_item_id` names, then by
`scm.mfg_products.category` for its `item_code` - the last being the only route
that works for a line whose `so_item_id` is NULL, which is exactly the
population that most needs classifying. The DO leg then reports 10 lines
instead of 0. No data was changed: the NULLs are the migrated writer's shape,
and backfilling them is a separate decision recorded in
`docs/sofa-document-chain-map.md`.

**Lesson** - a filter that returns zero rows is a claim about the data AND a
claim about the column being populated, and only one of those is usually
checked. When a child document is written by a migration script rather than by
the app, read the INSERT's column list before trusting any column in it. The
same audit now prints a per-column NULL census as its first section so the next
reader cannot repeat this.

**Ref** - #1923, chore/sofa-chain-alignment-audit, 2026-08-10

## Duplicate-series detection paired five unrelated fabrics through "BR0WN" [low]

**Symptom** - the first prod run of merge-duplicate-fabric-series reported 41
duplicate fabric series pairs, among them 311 <-> A201, 311 <-> KS, 311 <->
M2402 and 311 <-> XQ#18. Those are five unrelated fabrics.

**Root cause (traced, not guessed)** - all five collided on one key, `BR0WN`.
`foldColour` maps letter-O to "0" (that is what puts BO315 and B0315 on one
key), so a colour whose label is only a NAME - "BROWN", "DARK BROWN", "WOOD
BROWN" - folds to a string containing a "0". The detector gated its keys on a
digit test run against the FOLD, which that fake zero satisfies, so a plain
colour name was admitted as a colour CODE and every series holding a BROWN
matched every other one.

**Fix** - run the digit test in MARK space (`markColour`, where letter-O is "@"
and only a written zero stays a digit), which is the space the matcher's own
digit guard already compares in. 41 pairs became 31, and all 10 that vanished
were false. The same pass added a written-tail pad before folding, because
"J9226-2" folds to "J92262" and nothing downstream can then tell the series
digits from the colour digit - which is why ARMANI J9226 / J9226, one of the
two duplicate pairs this work started from, had gone undetected. Final: 32 real
pairs, no false ones.

**Lesson** - foldColour is lossy by design and its output is not safe to ask
structural questions of. Anything deciding "is this a code or a name" must ask
markColour, not the fold.

**Ref** - fix/dup-fabric-series-detection, 2026-08-10

## A probe copied the SO join onto the PO table and crashed on a column that is not there [low]

**Symptom** — `probe-sofa-colour-misses.mjs`, dispatched read-only against prod
the moment it merged, printed the fabric-library line and then died:
`PostgresError: column h.doc_no does not exist` (SQLSTATE 42703), run
31406187136. It reported nothing at all.

**Root cause (traced, not guessed)** — the two document headers number their
documents differently and the join hides it. `scm.mfg_sales_orders` carries
`doc_no` and its items join ON that column, so `h.doc_no` is right there in the
SO query being copied. `scm.purchase_orders` numbers its documents `po_number`
and its items join on the surrogate `h.id = i.purchase_order_id` — so the PO
query it was copied from never had to name the column, and the copy carried the
SO's name across into a table that has no such column.

**Fix** — `SELECT h.po_number AS doc_no` on the PO arm, aliased so the report
keeps one shape for both. PR #1910.

**The class, for next time** — copying a query between the SO and PO arms is
safe for the item columns and unsafe for the header ones. `item_code` vs
`material_code` differs loudly enough that it gets noticed; `doc_no` vs
`po_number` is hidden behind a join that never spells it out. Two arms of the
same sweep are two queries, not one query twice.

**Ref** — 2026-08-10, PR #1910 (fix/probe-po-number).

## The special-order backfill wrote a field the picker never reads, and recompute erases [high]

**Symptom** — the sofa special orders were "backfilled" and the Special Orders
accordion on every migrated SO/PO line still showed `(0 selected)`.

**Root cause (traced, not guessed)** — the backfill wrote `custom_specials`.
The picker binds to `variants.specials`: `SpecialOrders.tsx:91` reads
`specialsList(variants.specials ?? variants.special)` and `toggleCode` patches
`specials` back (callers `SoLineCard.tsx:944`, `PoLineCard.tsx:493` and `:541`).
`custom_specials` is the opposite direction — a DERIVED OUTPUT of the pricing
recompute: `mfg-pricing-recompute.ts:283` normalises `variants.specials` and
`:604` emits `custom_specials` from it. Nothing anywhere reads it back into the
picker; in `frontend/src` it appears only as report columns. It is also
VOLATILE: `mfg-sales-orders.ts:8234` sets
`updates.custom_specials = recomputedPatch.custom_specials ?? null` on every
line recompute, so the first UI edit of a migrated line would have erased the
backfill even where it had landed.

Three defects, not one. The field was wrong (derived output, not the picker's
input); the CONTENT was wrong (`backfill-sofa-special-orders.mjs` wrote the
verbatim slip phrases parseSofa returns — "BOTTOM USE UMBRELLA FABRIC" — beside
the codes, and a phrase is not a pickable code); and the SHAPE was wrong —
`mfg-pricing-recompute.ts:117` declares
`custom_specials: Array<{ description: string; surchargeSen: number }> | null`,
objects, while the script wrote a bare `string[]`. Production as of 2026-08-10
carried any `custom_specials` at all on only 9 of 1005 migrated sofa SO lines
and 6 of 217 PO lines, and not one of those was a picker code.

**Fix** — `backend/scripts/backfill-specials-into-variants.mjs` +
`.github/workflows/backfill-specials-into-variants.yml`, re-deriving each line's
specials from its own `description2` and merging picker CODES into
`variants.specials` via `jsonb_set` on that one key. The phrase -> code map is a
data file (`backend/scripts/data/special-order-phrase-map.json`) carrying the
owner ruling behind each family; codes resolve against a LIVE
`scm.special_addons` read and a phrase with no owner code is REPORTED, never
invented. Covers SO + PO, sofa + bedframe. `custom_specials` is left alone —
recompute regenerates it from variants.

**The class, for next time** — before backfilling a user-visible choice, find
the line in the COMPONENT that reads it. A derived column and the field it is
derived FROM look identical in the database and behave in opposite directions:
writing the derived one is invisible, and is deleted by the next recompute.

**The money check that has to come with it** — a picked code's
`selling_price_sen` is folded into the authoritative unit price
(`mfg-pricing.ts:396/400/405` -> `unitPriceSen` at `:408-415`, charged at
`mfg-pricing-recompute.ts:435`). Stamping a PRICED code onto a migrated line
silently reprices that historical document on its next edit, so the backfill
script refuses to APPLY when any code it would stamp carries a non-zero price.

**Ref** — 2026-08-10, PR fix/specials-into-variants.

## Five sofa colour strings named a fabric the library already held [medium]

**Symptom** - after the shared matcher landed and 18 missing colours were
created, `refresh-sofa-colours.mjs` still could not resolve 31 migrated sofa
lines across 13 colour strings. The create script had been run to APPLY the
same day, so the assumption was that the remaining 13 were fabrics nobody had
entered yet.

**Root cause (traced, not guessed)** - a prod `DUMP=1` dump of
`scm.fabric_colours` (probe-fabric-colours, run 31405758677) shows the library
DOES hold the fabric for 6 of the 13 strings / 19 of the 31 lines. Nothing was
missing; the document writes the identity a different way than the library
stores it, in four shapes no lexical rung can bridge:

- the colour NUMBER is absent - "Modenza-Houston Cream" vs MODENZA-01, whose
  label already reads "MODENZA-01 HOUSTON CREAM"
- the SERIES letters are absent - "141-1" vs CH141-1, "9226-13" vs
  ARMANI J9226-13 WARM GREY
- the BRAND is written instead of the series code - "Harring 02# Beige" vs
  HIRRING GD8371-02# BEIGE
- the number TRAILS the colour name instead of leading it - "Phoenix-oyster1"
  vs PHOENIX-1 OYSTER. This one is the sharpest evidence: PHOENIX-1 OYSTER was
  created by create-missing-sofa-fabrics at 14:57 and the string was STILL
  unresolved in the 15:23 dry-run, so creating it had never been the fix.

Widening a rung to cover these would have to let a query match a library key it
shares no number with, which is the exact door the digit guard closes after it
bound B0315-27 -> BO315-2 and HR805-20 -> HR805-40.

**Fix** - `COLOUR_ALIAS` in `backend/scripts/lib/fabric-colour-match.mjs`: five
named facts, each carrying its document string and live line count, resolved
against the live library at index-build time so an entry whose row is absent
goes inert rather than binding to nothing. It runs LAST, only after every
lexical pass returned null, so it cannot displace an existing answer - verified
by replaying all 61 bindings from dry-run 31403271270 against the real prod
library: 61 unchanged, 0 changed. Unresolved fell 31 -> 12 lines, 13 -> 7
strings.

The remaining 7 strings are NOT library gaps and must stay blank: "03#Straw" /
"03-Straw#" are ambiguous between HIRRING GD8371-03# STRAW and HIVE
GD2034-03# STRAW; "J9833-2" is J9883-2 with two digits transposed; "Beetex
harring gd 8371" and "ZanoLeather" name a series with no colour chosen;
"Bottom Use Nylon Fabric" is a construction instruction; "ninja - 02,03,07,09"
is a choice the salesperson never narrowed.

**Ref** - fix/unresolved-sofa-fabrics, 2026-08-10

## Every SO line photo rendered the literal text "err" while the photos were fine [high]

**Symptom** — on SO line cards, every saved photo tile showed the literal text
`err` instead of the image. Reported after 983 imported AutoCount photos landed
in R2 and none of them would display.

**Root cause (traced, not guessed)** — two independent things, and only the
second is ours to fix here.

1. `GET .../photos/<key>/signed` answers
   `500 {"error":"signing_failed","reason":"R2_ACCESS_KEY_ID not configured"}`.
   Signing needs the R2 **S3-API** credentials (`R2_ACCESS_KEY_ID` /
   `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT`), which are wrangler SECRETS that
   were never provisioned in production.
2. `PhotoThumb` treated that 500 as *the photo is broken* and rendered `err`.
   It never fell back — even though `GET .../photos/<key>` (the authed proxy,
   which streams via the Worker's **R2 binding** and needs no credentials at
   all) returned the same photo `200 image/jpeg` the whole time. Verified live
   against production on 2026-08-10: the signed route 500s and the proxy route
   serves the identical key.

So a signing failure was being reported to the operator as a missing photo. The
objects were in R2, readable, one working route away.

**Fix** — `PhotoThumb` now falls back to the authed proxy when `/signed` fails
or hands back a URL an `<img>` cannot load directly. The proxy URL **cannot**
be an `<img src>`: it is behind bearer auth and an `<img>` tag sends no
`Authorization` header — this app has no cookie session at all (0 `Set-Cookie`
in `backend/src`, 0 `credentials:` in `frontend/src`; the auth middleware reads
only the `Authorization` header). So the bytes are fetched with the token and
handed to `<img>` as a `blob:` object URL, the same mechanism `slip.ts` already
uses for payment slips — and for the same underlying reason, which that file
documents: *"Houzs prod never provisioned the R2 S3-API creds those need (every
/slips/init 500'd)"*. The blob is **revoked on unmount**; a photo grid mounts
and unmounts repeatedly, so leaking one image blob per tile per open is real.

`err` is deliberately KEPT for the genuinely-broken case — proxy 404 (missing
key) or 401/403 (refused). A missing photo must still be visible AS missing;
silently rendering nothing would be a different bug.

**Trap for the next person** — `backend/src/scm/routes/public-images.ts:5-7`
claims the SPA passes the auth gate with "its session cookie", so its `<img
src=...>` loads fine. That is **false**; there is no cookie session.
`backend/src/index.ts:282-284` states the opposite and is correct. Anyone who
trusts the `public-images.ts` comment will ship an `<img src>` fallback that
401s. Corrected in this PR.

**Not covered** — PO and consignment line photos still will not render, for a
different reason: no PO frontend component renders line photos at all
(`photoUrls` reaches the client and is discarded), and `ConsignmentOrderDetail`
never maps `photo_urls` into the `SoLineCard` draft. That is missing UI, not
this fallback.

**Ref** — PR fix/photo-tile-fallback, 2026-08-10. Test:
`frontend/src/vendor/scm/components/SoLinePhotoFallback.test.tsx`.

## The fixed colour matcher could not reach a single migrated SOFA line [high]

**Symptom** — the shared matcher landed and 18 genuinely-missing colours were
created on the same day, and the number of migrated sofa lines carrying a bound
fabric did not move. Both fixes were real; neither was visible in the data.

**Root cause (traced, not guessed)** — nothing sweeps sofa.
`refresh-so-variants.mjs` re-parses and re-stamps the migrated lines, but its
`WHERE` is `item_group = 'bedframe' OR item_code ILIKE '%(SP)%'`, and
`refresh-po-variants.mjs` is `item_group = 'bedframe'` alone. There has never
been a sofa equivalent, so a matcher improvement could only ever reach rows
created AFTER it — and company 1's sofa rows were all created during the
cutover, before it. The entry below fixed which matcher the writers call; this
one is about there being no writer at all for these rows.

**Fix** — `backend/scripts/refresh-sofa-colours.mjs` +
`.github/workflows/refresh-sofa-colours.yml`. It reads the colour out of the
line's OWN `description2` through the shared sofa decoder (`parse-sofa.mjs`,
`o.color` — not a private regex, that extraction has been copied enough times
already), resolves it through the shared matcher, and writes the same five keys
the SO importer writes (`fabricId`, `colourId`, `fabricCode`, `colourLabel`,
`fabricLabel`) on both `scm.mfg_sales_order_items` and
`scm.purchase_order_items`. Three rules it holds to:

1. **Fill only, never overwrite.** A line holding any of fabricId / colourId /
   fabricCode is skipped, and the UPDATE repeats that test in SQL so a pick made
   between the scan and the write still wins.
2. **Merge, do not rewrite.** `variants = variants || $1::jsonb`, so seatHeight,
   specials and buildKey survive. A sofa line's variants block is not ours alone.
3. **TBC / KIV is an answer.** It means not chosen yet; those lines are counted
   and left blank rather than being reported as a matcher miss.

**The class, for next time** — a fix to a shared decoder changes what the system
would import today. It changes NOTHING about the rows already stored. Every such
fix needs its sweep named in the same PR, or the improvement is real and
invisible.

**Ref** — 2026-08-10, PR #1903 (feat/restamp-sofa-colours).

## An AGGREGATED GrQty was read as a per-line received quantity, inflating received_qty on migrated PO lines [high]

**Symptom** — 65 migrated `scm.purchase_order_items` rows in production carry
`received_qty > qty`: a line ordered 1 and received 2. That is a permanent
NEGATIVE outstanding, and no report surfaces it — the over-receipt detectors all
work off GRN lines, and these rows have no GRN behind them at all.

**Root cause (traced, not guessed)** — the two AutoCount PO exports do not carry
the same thing, and the code treated them as synonyms.
`ac-outstanding-po.json.gz` carries `PODTL.TransferedQty`, which is per PO LINE
(`data/autocount-refetch-po.sql` selects it straight off the detail row).
`ac-so-linked-pos.json.gz` carries `GrQty`, which is **aggregated on
(DocNo + ItemCode)** — on a document holding two lines of one ItemCode, every one
of those lines reports the DOCUMENT's total. `import-ac-so-linked-pos.mjs:167`
read it per line:

```js
const recv = Math.round(Number(l.GrQty ?? 0));
```

and `lib/po-line-topup-core.mjs:86` inherited the same assumption as
`acNum(r.TransferedQty ?? r.GrQty)`.

The export proves it against itself, with no database access needed: all 38
`(DocNo,ItemCode)` groups holding 2+ lines carry an IDENTICAL `GrQty` on every
line (an aggregate cannot vary inside its own group); 59 lines carry
`GrQty > Qty`, impossible for one line, and **all 59** sit on such a group, ZERO
on a single-line group; PO-008944 holds two `DSL-8050 SOFA` lines of Qty 2 and
Qty 1 and reports `GrQty 3` on both — their sum. Confirmed against live AutoCount
in review (read-only ODBC, the 738 merged DtlKeys joined to PODTL): 60 of 738
disagree with `PODTL.TransferedQty`, **always inflated**, and 0 disagree wherever
`TransferedQty` supplied the value. `GRDTL.FromDocDtlKey` is NULL in this book,
so recovering a per-line figure by joining GR details is impossible;
`PODTL.TransferedQty` is the only correct source.

**Fix** — one shared rule in `lib/po-line-topup-core.mjs` (`resolveReceivedQty`),
called by both the importer and the top-up so they cannot drift: `TransferedQty`
is taken; a `GrQty` of exactly zero is taken (a sum of non-negative receipts at
zero forces every member to zero — arithmetic, not trust); a `GrQty` above zero
yields NO quantity and the line is reported. `received_qty` is
`NOT NULL DEFAULT 0` (migration 0090), so there is no blank column to write —
the top-up WITHHOLDS the whole family and the importer REFUSES the whole
document, both loudly. Whole, not the determinate half: a half-written family is
what every later run reports as "partial" and never completes, so a partial write
here is permanent. `data/autocount-refetch-so-linked-po.sql` is the read-only
re-export that fixes the data properly.

The tempting rule — "the group holds one line, so the aggregate IS that line" —
is deliberately NOT implemented, though it would cover 333 more lines. It rests
on the export holding every line of that ItemCode on that document, and nothing
available here can establish that: the two exports never overlap on a received
line (0 of the 179 shared DtlKeys have `GrQty > 0`), so the repo cannot check it
even once. Group size is reported as diagnosis, never consulted as permission.

**The class, for next time** — a column name is not a contract. `GrQty` and
`TransferedQty` both read as "how many arrived", and the comment that used to sit
above them said "They mean the same thing." Before reading any quantity per line,
check whether it VARIES within the group it would have been aggregated on; a
column that is constant across a group of differing quantities is an aggregate.
The cheapest tell is the impossible value: `received > ordered` on a single line
is arithmetic that cannot happen, and 59 of them were sitting in the file.

**Not repaired here** — the 65 existing production rows are a SEPARATE repair
owned by another lane. This change stops the source of them; it rewrites nothing.

**Ref** — PR #1906, 2026-08-11.

## Document-level idempotency stranded 60 purchase-order lines, and the completeness check reported zero [high]

**Symptom** — `check-cutover-completeness.mjs` reported `PO 407 = 407 MISSING 0`
while 35 AutoCount purchase-order LINES had no ERP row at all — 60 rows once the
sofa lines are decomposed, on 31 purchase orders. 25 of those documents are the
MIXED ones (a sofa line riding alongside a non-sofa line); 6 more are
bedframe-only shortfalls on documents the SO-linked import created. The
documents were all present. The lines were not.

**Root cause (traced, not guessed)** — both PO importers are idempotent at
DOCUMENT level. `import-ac-outstanding-po.mjs:205-208`:

```js
const nums = built.map((o) => o.poNo);
const existing = new Set();          // SELECT po_number ... WHERE po_number = ANY(...)
const todo = built.filter((o) => !existing.has(o.poNo));
```

Two APPLY runs without `SOFA=1` created 123 documents (98 pure non-sofa + 25
mixed). The `SOFA=1` run then saw those 123 documents already present and skipped
them WHOLE: its own log reads `POs to import: 160; already imported: 123; to
insert: 37` / `inserted POs=37 items=76`. The sofa lines riding the 25 mixed
documents were never written, and re-running can never repair it — the next run
says `already imported: 160; to insert: 0`. `import-ac-so-linked-pos.mjs:132`
has the identical shape, which is where the 6 bedframe documents come from.

The check could not see any of it because it compared document-number SETS
(`:51-58`) and nothing else. A document-level guard and a document-level check
share one blind spot, so they agreed with each other and both were wrong.

**Fix** — `backend/scripts/topup-ac-po-lines.mjs` + workflow
`topup-ac-po-lines.yml` diff the AutoCount exports against
`scm.purchase_order_items` line by line and insert only what is missing (DRY-RUN
by default). It never creates a document, never changes a status, never posts an
inventory movement, and it reuses `lib/parse-sofa.mjs` rather than growing a
second decoder. `check-cutover-completeness.mjs` gains section 1b, which counts
lines per document and names the shortfall — built on the SAME
`lib/po-line-topup-core.mjs` the repair writes from, so the check and the repair
cannot drift apart.

**Two things the first prod DRY-RUN corrected, which is why it is DRY-RUN
first** — the strongest handle, `linked_ac_dtlkey`, arrived in migration 0273
(#1819) while this was being written and is not yet applied to production; it is
nullable by design and `backfill-ac-line-keys` matches on (DocNo + ERP code),
which cannot reach a sofa compartment whose code is `${model}-{piece}`. So it is
used where it exists, set on every row this repair writes, and never relied on
alone. Below it, lines are matched on `supplier_sku`. But 225 of the 862 migrated
PO lines carry NO `supplier_sku` at all, written by neither importer —
`apply-sofa-compartment-corrections.mjs:212-217` is one such writer, inserting a
corrected compartment by SELECTing from the source row without carrying the
column. Zero of those 225 duplicate a with-sku row's code on the same PO, so they
are real AutoCount lines, unlabelled: matching on `supplier_sku` alone called 183
of them missing, and applying that would have written 183 duplicates into
production. They are now claimed by `material_code` (sofa: by model prefix), and
the repair is ALL-OR-NOTHING per ItemCode — zero rows present is repaired, some
rows present is reported and left alone, because a half-written sofa build is
just as likely a build somebody corrected by hand.

The same DRY-RUN discipline caught the check's own first draft lying: counting
every AutoCount SO line called 243 lines missing on 65 orders, when production
deliberately holds only the OUTSTANDING lines of an order (SO-000013: 8 AutoCount
lines, 7 fully transferred, exactly the 1 untransfered line in the ERP). Against
the right denominator the SO side is short by 1 line, on SO-011384.

**The class, for next time** — **an idempotency key coarser than the thing it
protects will silently skip work, and a check written at the same altitude will
agree with it.** Two APPLY runs of one importer with different flags is not two
runs of the same import: the second one's unit of work was the LINE, and the
guard only knew about the DOCUMENT. Where a document is written in stages — a
flag, a later round, a re-export — the completeness check has to count what the
stages write, not what they are grouped into.

**Ref** — 2026-08-10, PR `fix/po-line-level-topup`.

## Five hand-copied colour matchers, and the weakest one is what production stored [high]

**Symptom** — 138 migrated sofa/bedframe lines carry no resolved fabric while
their AutoCount Desc2 names one. A live prod scan on 2026-08-10 put it at 223
lines / 92 distinct colour strings that the writers could not bind, against a
library that already holds 133 series / 724 colours.

**Root cause (traced, not guessed)** — `findColour` existed FIVE times, one
hand-written copy per script, and they had drifted apart.
`import-ac-outstanding-so.mjs` had grown a typo-fold index, a transposition
pass and an edit-distance pass; `refresh-so-variants.mjs`,
`refresh-po-variants.mjs`, `import-ac-outstanding-po.mjs` and
`import-ac-so-linked-pos.mjs` were still exact-index-only, and
`repair-leaked-sofa-lines.mjs` matched the raw name. **The refresh scripts are
what WRITE the migrated lines**, so the weakest copy decided what production
holds — every improvement made to the importer's copy since #1806 never reached
the rows. Exactly the class `CLAUDE.md` and the `parse-sofa` entry below already
name: "Extracted verbatim" that was not verbatim.

**And the fuzzy tail was silently swapping fabrics.** Measured against the live
library, the inherited transposition / edit-distance / prefix passes bound
`B0315-27` -> `BO315-2`, `B0315-29` -> `BO315-2`, `HR805-20` -> `HR805-40`,
`Chantic141-5` -> `CHANTIC-141-2`, `GD8371-03` -> `GD8371-02` and `STAR-10` ->
`STAR 01`. Every one is a real fabric replaced by a DIFFERENT real fabric, at
`high` confidence, with nothing on the order to say so — worse than a blank,
because a blank gets fixed by a human and this gets upholstered.

**Fix** — one `backend/scripts/lib/fabric-colour-match.mjs`, imported by all
six. Its ladder is purely lexical (drop a parenthesised name, treat `#` as a
separator, drop the trailing colour NAME, drop spaces, pull SERIES+NUMBER out of
prose, pad a one-digit tail, fold typos) and every rung only ADDS a spelling
with the untouched original tried first. Two rules carry the weight:

1. **Collapse doubled letters BEFORE reading letter-O as zero.** O->0 first
   turns `BOO315` into `B00315`, whose doubled character is a ZERO, so the
   collapse yields `B0315` and every `BOO*` spelling misses.
2. **The fuzzy passes may correct LETTERS and may never move a DIGIT.** Digits
   are compared in a mark space where letter-O is neither letter nor digit, so
   `BO315` and `B0315` still agree while `10` and `01` do not. A library LABEL
   under three characters is no longer matchable either — the SF series labels
   its colours `"01".."19"`, so a bare `"03"` was claiming `SF-AT 03`.

`tests/fabricColourMatch.test.ts` is the golden test: real document strings
against a faithful slice of the real library, with every mis-bind above pinned
as an explicit null.

**The class, for next time** — when a rule is copied into a second script,
copy the FILE, not the lines. Five copies of one parser means the surface a fix
lands on is whichever copy you happened to open, and the one nobody opened is
usually the one that writes.

**Ref** — 2026-08-10, PR #1893 (fix/sofa-colour-matching).

## The sofa decoder DELETED every special order that mentioned the bottom [high]

**Symptom** — 53 AutoCount sofa lines say `bottom use umbrella fabric` /
`bottom upgrade to umbrella fabric` / `wrap bottom to umbrella fabric`. Not one
of those instructions existed anywhere in the ERP — not as a picker code, not as
free text, not as a remark. The factory sheet for those orders simply did not
carry the request. `seed-sofa-special-addons.mjs` had already counted the 53 and
opened a code for them; the code had nothing pointing at it because the phrase
never survived the decode.

**Root cause** — Two holes in `parse-sofa.mjs`, both traced by re-running the
three committed exports, not guessed. (1) The preprocessing line
`d2.replace(/bottom[^\/\n]*|.../, " ")` deletes from the word `bottom` to the
end of its segment, and it runs BEFORE specials are collected — the phrase is
gone before anything can read it. (2) Everything else was collected on the
`rider` path inside the structure loop, and that loop **breaks at the first
segment that yields pieces**. A phrase sharing the structure's segment was
caught; the identical phrase alone in its own segment (`/BACK CUSHION CHANGE
8030`) was never visited.

**Fix** — A special-order sweep that runs on the ORIGINAL text before the
pipeline strips anything and writes ONLY to `o.specials`: split on `/`, newline
and `*`, and any chunk carrying an instruction word is pushed verbatim. The
structure parse is untouched by construction. Deduped on letters-and-digits
(`nilon` = `nylon`) so one instruction written three ways — swept phrase,
rule token, glued rider — is carried once, in its fullest wording.

Measured over all three exports in both recliner states (716 lines x 2):
**0 piece-list changes, 0 confidence downgrades, 0 size/colour/`why` changes,
0 phrases lost**; 96 lines that carried no special now carry one, and 57 lines
regain an umbrella-fabric instruction that had been 0.

**Also shipped** — `backfill-sofa-special-orders.mjs` + workflow, which maps the
recovered phrases onto migrated SO and PO lines as `scm.special_addons` picker
codes, free text verbatim where the owner has not opened a code. Six more golden
cases in `backend/tests/parseSofaGrammar.test.ts`.

**The class, for next time** — a `strip` and a `collect` over the same text are
order-dependent, and the strip was written first for a different reason (keeping
`bottom...` out of the structure tokens). Collecting must never depend on
surviving another rule's cleanup: read what you need off the original, then let
the cleanup run. The same shape hid inside the loop — `break` on success means
every later segment is unread, so anything you also want from those segments has
to be gathered outside the loop.

**Ref** — 2026-08-10, PR feat/sofa-special-order-backfill.

## Every migrated sofa line has an EMPTY Leg Height [medium]

**Symptom** — Open any sofa line that came in from AutoCount and the Leg Height
picker reads "Select...". Seat depth, fabric and compartment are all filled; the
leg alone is blank, on every single migrated line.

**Root cause** — Nothing ever writes `variants.legHeight` for a sofa.
`parse-sofa.mjs` (lines 52-55) deliberately lifts a leg PHRASE out of Desc2 and
pushes it into `specials` — "leg text never sets a size, it rides as a special
so the factory sheet still shows the request" — and neither
`import-ac-outstanding-so.mjs` nor the PO importers put a leg key in the
variants object they build. So the axis is absent, not empty-because-unknown.
The gap went unseen because the sofa Leg Height axis is `required: false` in
`so-variant-rule.ts`, and it is `required: false` for exactly the opposite
reason — the comment there says the axis "always defaults to the Default option
(RM 0.00) at create/edit time, so it is never empty". That premise held for
POS/coordinator-created lines and was never true for imported ones, so the one
gate that would have caught it had been told to look away.

**Fix** — `backfill-sofa-leg-default.mjs` + `backfill-sofa-leg-default.yml`
(dry-run default, `apply=1` writes) fills `variants.legHeight` with the master
config pool's own "Default" entry across `scm.mfg_sales_order_items` and
`scm.purchase_order_items`, for company 1 sofa lines whose parent carries
`linked_ac_docno`. Owner's ruling, `docs/sofa-import-handoff.md` section 2.5:
"脚全部找不到就直接选 default". Two refusals are built in: a line that already
carries `legHeight` or `sofaLegHeight` is never overwritten, and a line whose
own text names a leg ("Leg Change 101Middle Leg(8')", "FULLY COVER NO LEG",
`6” wooden leg`) is left alone and reported by phrase with its document numbers,
because the source said something specific and a default would erase it. An inch
height counts as a leg only INSIDE the leg phrase — a bare `28"` in a sofa Desc2
is the seat depth.

**The class, for next time** — an axis marked not-required "because it is always
pre-filled" is a claim about a write path, and it only covers the write paths
that existed when it was written. An importer is a new write path.

**Ref** — 2026-08-10, PR fix/sofa-leg-default.

## A first-pass NAME match made RDS-5526 into someone else's sofa [high]

**Symptom** — Two 5526 sofa builds could not be corrected: the correction tool
answers `piece SKU not minted`, because the piece it needs is on a model that
does not exist. Nine cutover document lines were sitting on `8038-*` codes, and
the AutoCount item they came from is `RDS-5526 SOFA`. Owner 2026-08-10: **"5526
就是 5526 啊,你应该要 remain ... 8038 原本都不是 5526."**

**Root cause** — One row of `backend/scripts/data/autocount-erp-mapping-1561.csv`:
`RDS-5526 SOFA,8038-1S,EXISTS(1st-pass),SOFA,400-R001`. The status column says
what it is — a fuzzy match on NAME, both models being called DISCOVERY — and
`400-R001` (RED SOFA) vs 8038's `400-D004` (DSL) says they are different
suppliers' products. The row contradicts its own neighbour: `RDS-5526 CONSOLE`
was mapped `NEW/ACCESSORY`, not to `8038-Console`, which exists. Because the
importers read the mapping to derive the model (`erp.replace(/-1S$/,"")`), 5526
never got the `scm.product_models` row every other AutoCount sofa code got —
`align-models-houzs-century.json` seeded 69 of them, each `name = model_code`,
`compartments: ["1S"]` — so there was no 5526 SKU for a line to point at, and
the 2026-08 supplier price list then bound RED SOFA's 5526 prices onto 8038
SKUs on top.

**Fix** — `backend/scripts/open-5526-model.mjs` + workflow: creates model 5526
(name `5526`, the convention its sibling RED SOFA model 5527 and 8133 were
seeded with — reusing `DISCOVERY` is the bug), opens the nine compartments its
own documents need, mints `SOFA 5526 {comp}` SKUs, appends new codes to the
master pool, and re-points the nine AutoCount source lines off 8038, carrying
the change down SO -> PO -> GRN and SO -> DO. The mapping row now reads
`5526-1S,NEW`, and the script refuses to run unless it does. Same pass mints
`8133-STOOL`, the piece `HC-PO-000136`'s correction was refusing on.

**What was deliberately NOT done** — the supplier bindings. `8038-1A(LHF)`,
`8038-1NA`, `8038-2A(RHF)`, `8038-CNR`, `8038-Console`, `8038-STOOL` all carry
`supplier_sku = "RDS-5526 SOFA"`, and `8038-1S` is RED SOFA's main binding for
it. Moving those moves prices, so it is the owner's decision. Two builds also
stay `SOFA UNPARSED` on purpose: `"1 ELT / T + NA +2ER"` is not readable, and
the rule is never guess a piece.

**The class, for next time** — `EXISTS(1st-pass)` in that CSV is a machine's
guess wearing the same clothes as an owner's answer; 319 rows carry it. A
first-pass NAME match between two products from DIFFERENT suppliers deserves
the supplier column read before it is trusted, and a model that ends up with no
row of its own is the symptom that one was wrong.

**Ref** — 2026-08-10, PR feat/open-5526-model.

## Deleting a compartment row offered to RENAME it across all history [high]

**Symptom** — The owner deleted the sideless bench codes `1B` and `2B` from the
sofa compartment pool and, in the same save, added a new `DB` (Daybed). The
maintenance page answered with a red confirm: **"Rename compartment code? 1B ->
DB — This cascades EVERYWHERE: SKU codes + names, sales orders (incl. history),
delivery orders, invoices, GRN/PO lines, Modular ticks, Combos and Quick
Picks."** He had not renamed anything. One click would have rewritten every
historical `1B` into `DB`, and the cascade has no dry run.

**Root cause** — `Products.tsx` inferred renames by comparing the old and new
pool arrays **BY INDEX**. A rename is an in-place edit, so the row count cannot
change — but the detector never checked that. Deleting rows 29 (`1B`) and 30
(`2B`) slid the freshly-added row 31 (`DB`) up into index 28, so `baseline[28] =
"1B"`, `next[28] = "DB"`, `"1B"` was absent from the new list and `"DB"` from
the old — every condition for "this is a rename" satisfied by a delete plus an
add.

**Fix** — Only look for renames when `baseline.length === next.length`. A length
change is an add and/or a delete; the plain save already handles it.

**Also shipped** — `fix-sofa-compartment-pool.mjs` + workflow, so the removal
can be done on its own (append-only new config row, dry-run default) and refuses
to drop a code any SKU or document line still uses. Sideless `1B`/`2B` are
leftovers from before the owner's ruling that a bench always carries a side
("1B 都是要 direction 的啊,扶手在哪里"); the decoder has always EMITTED
`1B(LHF)`/`1B(RHF)` and never a bare `1B`, so nothing depends on them.

**The class, for next time** — a positional diff cannot tell an edit from an
insert. Anything that infers "this row was renamed" needs row identity, or at
minimum a length guard, before it is allowed to touch history.

**Ref** — 2026-08-10, PR fix/sofa-pool-sideless-bench.

## 2026-08-08

### [HIGH] The PO line allocation picker offered every same-CODE Sales Order line, ignoring the variant spec — "if the spec doesn't match, how are there so many available?"

- **Symptom.** Owner, live on 2990-PO-2608, opening the allocation editor for `XAMMAR-2A(LHF)` (spec: `EZ-012 Dark Grey (M2402-19) / SEAT 24 / LEG 6" / SPECIAL: ...`): the "Add allocation" dropdown listed a long roster of Sales Orders whose lines share only the item CODE, regardless of fabric, colour or the SEAT/LEG/SPECIAL spec. A consolidated PO line should only be attributable to an SO line for the SAME PRODUCT.
- **Root cause, traced through both the read and the write.** The candidate query (`mfg-purchase-orders.ts` `/so-line-candidates`) filtered on `.eq('item_code', code)` ONLY. The write-side gate (`soLinkTargetRefusal`) compared `soCode !== poCode` on the item code ONLY. Neither looked at the variant summary at all — so every same-code SO line was both offered and accepted.
- **Fix.** Match on the SPEC signature, not the bare code. New pure `specSignature`/`specMatches` in `scm/lib/po-allocations.ts` wrap `buildVariantSummary(item_group, variants)` — the SAME string the PO-vs-SO drift compare already builds, so PO and SO are compared apples-to-apples. The candidate query now takes optional `poId`+`itemId`, loads that PO line's spec, and keeps only candidates whose signature matches; `soLinkTargetRefusal` takes the PO line's `poSpec` and returns 409 `so_link_spec_mismatch` on a mismatch. The frontend hook + modal pass `poId`+`lineId`, so the dropdown auto-narrows.
- **Dye-lot, deliberately excluded (owner ruling 2026-08-08).** `buildVariantSummary` carries fabric + colour + supplier-fabric-code + SEAT/LEG/DIVAN/GAP/SPECIAL and NO dye-lot field. A dye-lot is assigned at receipt, not at SO time, so requiring it would wrongly drop every not-yet-lotted SO line. Matching on this signature satisfies "fabric + spec, not dye-lot" by construction. (The `(M2402-19)` in the screenshot is the fabric's SUPPLIER code — part of fabric identity — not a dye-lot.)
- **STOCK conversion verified, no bug.** The `so_item_id: null` (STOCK) path skips the SO gate entirely (no customer to match), is qty-capped, inserts one row and audits it — read line by line, clean.
- **Back-compat.** Omitting `poId`/`itemId` on the candidate query, or a null `poSpec` on the gate, falls back to code-only — no caller breaks.
- **Verified.** Backend + frontend typecheck clean; 11 `po-allocations` unit tests (6 new for `specMatches`/`specSignature`, incl. the dye-lot-excluded and different-SEAT cases); production build green; route matrix current (no new route, added query params only). NOT yet clicked on production — the live re-check is opening the same PO line's picker and confirming only same-spec SOs appear.
- **Ref:** `fix/po-alloc-spec-match` 2026-08-08. Frontend + backend; no migration.

## A bare "C" (corner) was filtered as noise, so 49 sofa builds lost their corner [high]