# Houzs ERP — Working agreement

This file is loaded into every Claude session. It tells you what's
non-obvious about this codebase and how the user wants to collaborate.

## ⚠️ Do not guess. Prove it, or say you do not know yet — MANDATORY (owner rule)

The owner's instruction, 2026-08-12: *"我要确定的答案，有时找 bugs 都是猜的，很不好."*

The two rules below already demand `traced, not guessed` — but both of them only
govern what you WRITE AFTER the work. Nothing governed the work itself, so the
guessing was legal right up until the write-up, and a fix reached by guessing can
still be written up in confident "traced" language. This rule closes that.

**A cause you have not observed is a hypothesis, and a fix built on a hypothesis
is a guess.** Before you propose or ship a fix:

1. **State the hypothesis out loud, and name the observation that would REFUTE
   it.** If you cannot name one, you do not have a hypothesis, you have a story.
2. **Go and make that observation.** A live query, a `wrangler tail`, a
   `workflow_dispatch` read-only check, a reproduction, a log line, a probe
   script. Name the tool in what you report.
3. **Only then fix.** If the observation refutes you, say so and start again —
   that is the cheap outcome, not the embarrassing one.

**Label every claim you make to the owner.** Three words are enough and he is
entitled to them on every answer:

- **PROVEN** — I ran something and here is the output.
- **LIKELY** — consistent with the evidence, not yet checked; here is what would
  settle it.
- **UNKNOWN** — I do not know yet. This is always an acceptable answer. It is
  never acceptable to dress it as one of the other two.

**Reading code is not evidence about production.** Source, migration files and
comments describe intent; the running system is the fact. This repo has paid for
that distinction repeatedly, and each one was found by measuring after reasoning
had already produced a confident wrong answer:

- A migration file read as money corruption; the live DB refuted it
  (`system-foundation-coe.md`).
- "The unique index does not exist" — it did, four of them, ported by hand and
  present in no file in this repo.
- "604 `custom_specials` rows are corrupt, null them" — 679 of 694 strings were
  live picker codes. Nulling would have deleted a correct, currently-rendering
  line item from 604 historical documents.
- `/health` answered `{"ok":true,"book":"AED_HOUZS"}` from CONSTANTS while the
  service could not open the database at all.
- "The master exists" was true — about the sales agent, while the constraint
  pointed at the purchase agent.

**Two traps that make a guess feel proven:**

- **The check that answers a different question.** `UPDATE 1` was true while the
  column was being corrupted; `res.count` answered the wrong question three
  times (`jsonb-double-encoding-coe.md`). Ask what the successful result would
  ALSO be true of.
- **The check that is not running.** `audit:map` reported nothing for three
  weeks because the script it runs had been crashing since the day after it was
  written, and the nightly staging E2E passed for two weeks against a build
  nobody had deployed (`staging-bench-rot-coe.md`). Green is not evidence until
  you know the check ran, and against what.

**Never make the evidence say what you want.** If a marker row is missing, that
is the finding — do not insert it to make a gate pass. If a matcher misses, fix
the library, do not loosen the guard the matcher exists to enforce.

### Three rules that make the above executable

A rule is text; text does not run. These three are actions. The first two were
bought the same day this section was written, by breaking it within hours; the
third was bought a week later, by breaking it seven times in one day while
quoting it.

**1. RE-RUN, never recall.** Any date, count, run id or causal claim that is
going into a document must come from a command executed *at the moment of
writing*, not from something gathered earlier in the session. Late in a long
session the earlier output has decayed into an impression, and an impression
produces the same confident sentence a fact does. On 2026-08-12 the run list
proving staging deployed fine until 2026-07-29 had already been fetched hours
before; the COE was then written from memory of it and asserted the opposite.
Re-running one command would have put the refutation on screen.

**2. A contradiction is a finding — STOP, do not bridge it.** When two things
you hold disagree, one is wrong, and establishing which is the work. Do not
write the sentence that makes them fit. The same COE stated "last successful
deploy 2026-07-29" and "the token never worked after 2026-07-01" four paragraphs
apart, and reconciled them by inventing an earlier credential nobody had
evidenced. The urge to produce a complete, coherent answer is the single largest
source of wrong answers here — completeness is not a quality bar, and "these two
facts disagree and I have not resolved it" is a better answer than a seamless
one.

**3. A REMEDY CLAIM needs the run that proved it — ENFORCED.** The moment you
tell anyone that *running* something will fix, recover, collect or restore
something, you have made a claim about an operation, and reading the source is
not evidence for it. Paste what you observed when you ran it — a status, a
count, a duration, an error, a run URL — or write **UNTESTED** in the sentence
itself. Both are honest. Saying nothing is what is not.

On 2026-08-19 `?mode=all` shipped on the AutoCount pull described as *"the clean
way to collect a backlog"*. That sentence came from reading `services/pull.ts:29`
— `getAll()` is called, the checkpoint is not touched, both true — and the
operation was never once executed. Dispatched against production: **39 seconds,
then HTTP 503 `Worker exceeded resource limits`.** ~13,000 orders do not fit in
one Worker request. The remedy that actually works is `?since=YYYY-MM-DD`
windows.

Nothing else would have caught it, and that is the point. The code was correct;
types, lint, tests and review all passed, because none of them was wrong. The
only wrong artifact was the CLAIM, and every gate this repo had read code.
`completeness-claim` gates a claim about a POPULATION; rule 3 above gates a
migration's `Reversal:`/`Verified against:`. A claim about an OPERATION belonged
to neither, so it went into a PR body and was believed.

It is now rule 4 of `scripts/check-working-agreement.mjs`, so it fails a PR
instead of relying on anyone remembering this paragraph. The gate also warns —
never fails — when the sentence is added to a module guide or a `check-*.mjs`
verdict, because a reader of those files cannot ask you whether you ran it. That
half is not hypothetical either: the `mode=all` correction was written into
`docs/modules/system-health.md` and missed the identical sentence in
`backend/scripts/check-autocount-pull-health.mjs`, which went on printing the
retracted advice to anyone who ran the check.

**It reads Chinese too**, because the owner writes in Chinese and the first
version of this rule was English-only — 「跑这个就能补回来」, 「重跑一次 sync 就会好
了」, 「执行 mode=all 就可以把历史补齐」 were all silently missed. Chinese has no
word boundaries, so every pattern is a multi-character phrase: a bare 跑 would
fire on 「一直在跑」, which narrates rather than prescribes.

**What the gate cannot do, said plainly:** it cannot verify the pasted output is
real. A production dispatch is not reproducible in CI the way an enumeration is.
It catches the claim written from reading — the author who never ran it and has
nothing to paste. Forgetting and forging are different acts; this one is aimed
at forgetting, which is the one that keeps happening.

## ⚠️ 用白话文跟老板讲 — MANDATORY (owner rule, 2026-08-18)

His words: *"你跟我说的那些问题和做完的东西，都没有用白话文让人简单明白。因为我
不是 IT 出身的。"*

**He is the decision maker and he is not an engineer.** An answer he cannot read
is not an answer — it is a bill for his time, and he pays it every single reply.
This rule is about the OUTPUT, not the work: the rigour below stays exactly as
it is, and only the way it reaches him changes.

**Lead with what it means for the business. The mechanism comes after, if at
all.**

| do not open with | open with |
| --- | --- |
| "`readConvertSourceKeys` resolved line IDENTITY only, so `AddPartialTransferDetail` moved the whole outstanding quantity" | "出 5 件里的 2 件，AutoCount 那边开了 5 件 —— 库存对不上，而且完全没有声音" |
| "`conversionIsPartial` compared one parent's line count against the total taken" | "两张单合并出货的时候，系统会把没出的货也算成出了" |
| "the `no-autocount-shape` needle stays because the table is append-only" | "以前记下的那些单不会自己好，要人手补 —— 新的单不会再有这个问题" |

Four rules that make that concrete:

1. **The first sentence names the business effect.** A document did not reach
   AutoCount; stock is wrong by N; a customer's invoice is short. Never a
   function name, never a file path, never an identifier.
2. **Identifiers are EVIDENCE and they go last.** File paths, function names,
   PR numbers, column names belong at the end of a section or under a heading
   that says what it is — so he can hand it to someone, not so he can decode it.
3. **A number needs its denominator in his terms.** "10 of 60,939 lines" is
   readable; "0.02% of the corpus" is not. "1 张 / 11,134 张交货单" beats
   "0.0%".
4. **If a technical word is unavoidable, define it once, in his vocabulary, the
   first time.** He should never have to ask what a word means twice.

**This does NOT license vagueness.** Labelling stays (PROVEN / LIKELY /
UNKNOWN), numbers stay, the command that reproduces them stays. Plain language
is a translation of the evidence, never a substitute for having it.

## ⚠️ A root cause is a request for OPTIONS, not for agreement — MANDATORY (owner rule, 2026-08-18)

His words: *"基本上我会跟你说一个 root cause，你应该给我方案怎么去解决，并且查看
我们的代码，然后给我们解决方案"* and *"你需要稍微看一下市面上正常的 ERP 都是怎么做
的，然后给我 proposal，给我 suggest，让我去选择"*.

**When the owner hands you a cause, he has already done the diagnosis. Repeating
it back to him is not work.** What he is asking for is the next step, and it has
a required shape:

1. **Read OUR code first.** The proposal must say what changes in THIS system —
   which module, which table, what it breaks, what it costs. Generic advice is
   worth nothing to him and he can get it anywhere.
2. **Say what a normal ERP does.** He is choosing between our way and the
   industry's, and he cannot make that choice without knowing there is one.
   Name the convention (how AutoCount / SAP / Odoo / NetSuite handle it) and say
   plainly whether ours differs and why.
3. **Give 2 to 3 NAMED options**, each with its consequence: what it costs to
   build, what it breaks, what it means for the documents already in the account
   book, and what it is like to live with afterwards.
4. **RECOMMEND one, and say why.** "It is your call" without a recommendation
   pushes the work back onto him. Recommending is not deciding — he still picks.
5. **Never end a diagnosis without options.** A finished investigation whose last
   line is "this is broken" is half a deliverable.

The judgement rule still holds and is not in tension with this one
(`owner-rule-ask-when-unsure`): a PROVABLE defect gets fixed without asking; a
JUDGEMENT — should this be required, labelled, charged, allowed — gets options
and a recommendation, and he chooses.

## ⚠️ 挖到真正的 ROOT CAUSE，从根本解决，不拿补丁当终局 — MANDATORY (owner rule, 2026-08-18)

His words, three times in one session: *"所有的问题都要找出来真的 root cause 然后
根本解决"*, *"做任何东西都要查找它真正的 root cause，尽量从根本上解决"*, *"一定要
看一下最适合的方案，给我去做选择"*. And the sharp one that named the failure:
*"为什么你不找根本 给我们更好的方案做呢"*.

This SHARPENS the two rules "Do not guess, prove it" and "a root cause is a
request for OPTIONS". Those say: prove the cause, answer with options. This adds
the bar he keeps raising — **a fix that only stops the symptom is not the
deliverable.**

1. **Trace the REAL mechanism, with code evidence.** Read the code until you can
   point at the line where it actually goes wrong — not the symptom, not the
   first plausible story.
2. **A workaround is a STOPGAP, and you must SAY it is one.** A switch, a retry,
   a cache-bust, a flag may ship as immediate relief — but never presented as the
   fix. Name it a stopgap, name the real root fix beside it, and say what the real
   fix takes. Shipping the stopgap and calling it done is the exact failure he
   caught here: flipping a session-fallback switch stopped the random logouts but
   did NOT touch the latency, and calling that "solved" would have hidden the root
   (every request re-reads the whole RBAC envelope from the DB on one serialized
   connection).
3. **Say how mainstream / large ERPs solve this CLASS of problem, plainly.** He is
   choosing between our way and the industry's and cannot choose without knowing
   there is one. The durable answer is usually the industry's; a per-request patch
   usually is not.
4. **Give 2-3 named options ranked stopgap → proper, each with effort/risk/benefit,
   and RECOMMEND one.** He picks. Ending with only the stopgap, or with no
   recommendation, is half a deliverable.

## ⚠️ 任务清楚就一路做完，不要每步停下来问 — MANDATORY (owner rule, 2026-08-18)

His words: *"不要一直问我 我不喜欢明明还有 tasks 却停下来问 好像故意不工作那样 你要
记得这个"* and *"跟着你的 worktree 把所有 tasks complete 掉"*.

Once the direction is CHOSEN (he chose it) and the remaining steps are
unambiguous execution, drive them to completion — commit, PR, next step —
**without pausing for approval between each one.** A pause-to-confirm on clear,
already-decided work reads to him as finding an excuse not to work.

This does NOT conflict with the two options rules above: give options WHEN
CHOOSING a direction; once chosen, execute to the end without re-asking "shall I
do the next one?".

Reserve an interruption for exactly three things:
1. a genuine business / judgement decision that is his to make (the
   ask-when-unsure case);
2. a destructive or irreversible action;
3. a hard blocker only he can clear — setting a secret, flipping a repo setting.

**Design around #3 so it does not halt the rest.** Write code that reads a
not-yet-set secret as a NO-OP when absent, ship it zero-risk, and let him
activate it with one action later — the work keeps moving instead of stopping to
wait for him.

## ⚠️ Log every bug in the ledger — MANDATORY (owner rule, everyone)

Every bug you find and fix **must** get an entry in the bug ledger,
[`docs/bugs/`](./docs/bugs/) — no exceptions. One short entry: **Symptom → Root
cause (traced, not guessed) → Fix → Ref (PR/date)**, with a severity tag. This is
how we stop re-introducing the same class of bug: **read it before touching a
subsystem, and add to it in the same PR that fixes the bug.** This applies to
every contributor and every agent/session.

**One file per entry**, `docs/bugs/NNNN-slug.md`. Scaffold it — do not hand-pick
the number:

```sh
node scripts/new-bug.mjs "The confirm gate accepted a cancelled PO" --severity high
```

**Reading it has not got harder.** `npm --prefix backend run gen:bug-index` builds
`docs/generated/bug-index.md` [generated] — every entry, grouped by subsystem, one row —
and `gen:bug-history` builds the whole ledger newest-first as one document. Both
are gitignored and rebuilt in under a second.

**Why a directory** (changed 2026-08-20, full trace in `docs/bugs/README.md`):
the entry is MANDATORY on every code PR, so with one file every open branch
edited the same first line of it. `.gitattributes` carried
`BUG-HISTORY.md merge=union`, which hid that from OUR git and not from GitHub's —
and `main` now runs a merge QUEUE, which stacks entries using GitHub's git.
Measured on the live queue 2026-08-20: seven entries, six UNMERGEABLE, all seven
touching `BUG-HISTORY.md`. The repo's own mandatory rule was serialising the
queue to one PR at a time. Two entry FILES cannot conflict.

## ⚠️ Read the module guide before you work in a module — MANDATORY (owner rule)

`docs/modules/<module>.md` exists so you do NOT have to read the whole system to
change one part of it. **Read the guide for the module you are touching, before you
touch it.** If your change alters that module's SURFACE — a new endpoint, a new
permission, a new status, a field that starts or stops being required, a new
lock — **update the guide in the same PR.** A guide nobody updates becomes the next
thing that lies to us.

If a module has no guide yet, that is the gap to close, not a licence to explore:
write the guide as you learn the module, following the shape of
`docs/modules/sales-order.md`.

## ⚠️ Coverage ratchets — and one of them BLOCKS your PR

Unlike the three rules above, this one is enforced by a check rather than by
remembering it. Per AREA, line coverage may only go **up** and the count of files
with **no test at all** may only go **down**. Floors live in
`coverage-baseline.json`; the gate is `scripts/coverage-ratchet.mjs`.

**The two halves run in different places, and that split is deliberate.**

- **`frontend/src` hard-blocks, per PR.** Checked inline in `frontend-checks`,
  which the required `frontend` roll-up covers. Add a `.tsx` with no test and
  the merge is blocked. It stays on the PR path because instrumenting the
  frontend suite costs 2 seconds (18s → 20s) and `frontend/src` is 594 files.
- **The five backend areas are measured ON MAIN**, by
  `.github/workflows/coverage.yml`, once per merge — not per PR. Moved there
  2026-08-14 after measuring what it cost on the PR path: the workers suite is
  **217s of test work bare and 746s instrumented**, so coverage was adding
  **529 seconds to the critical path of every pull request**. A floor is a
  statement about what is on `main`; measuring it when something lands on `main`
  is the same statement for a fraction of the money.

  **What that gives up, plainly:** a PR that lowers backend coverage is caught
  at the merge, not before it. The fix becomes a follow-up rather than a block.
  If that trade ever stops being worth 529s per PR, the job is one file and
  moves back.
- `backend/scripts` (the one-shot ops scripts, NOT `scripts/lib`) has its
  no-test floor turned off on purpose — a new ops script with no test is normal
  there. Everything else is held to both floors.

Raising a floor is `npm run coverage:update`. LOWERING one needs
`--update --allow-drop`, says so loudly in the log, and belongs in the diff with
a reason in the PR. The percentage floor carries a tenth of a point of slack —
for the merge base, not for you; the no-test floor carries none.
`docs/TESTING-RATCHET.md` has the measured cost of each suite and, in §6, where
the no-test floor is BLIND (it is, in `scm/routes`).

**A percentage is not the target.** Testing getters to raise it protects nothing.
The floor that matters is the second one, and the files worth attacking are the
ones that decide MONEY or STOCK and have no test of any kind.

## ⚠️ A serious incident gets a COE — MANDATORY (owner rule)

**COE = Correction of Error** (the industry term, AWS's). `docs/bugs/` is the
per-bug ledger; a COE is for the bigger class: an outage, data at risk, a fault that
recurred, or anything that made the system feel unreliable to staff. Write
`docs/<subject>-coe.md`, following the ones already written — `ls docs/*-coe.md`,
and read `docs/system-foundation-coe.md` for the canonical shape:

**Date · Trigger** (what staff actually saw, in their words) · **Root cause, traced
with evidence, never guessed** — name the tool that proved it (`wrangler tail`, a
live DB query) · **Fixes shipped**, one row per PR with its effect · **What the
audit RULED OUT** — the suspicions that turned out false, and how they were refuted
· **Deferred**, with the decision owner · **Lessons.**

The ruled-out section is not padding: it is what stops the next person re-chasing a
theory we already disproved. One real example from `system-foundation-coe.md` —
money corruption was suspected from reading a migration file, then refuted against
the live database. The lesson recorded there ("verify schema claims against the live
DB, not migration files") is worth more than the fix was.

## ⚠️ The bug ledger, the module guide and migrations are CHECKED on every PR

`.github/workflows/working-agreement.yml` runs
`scripts/check-working-agreement.mjs` and holds a PR to the two MANDATORY rules
directly above — the bug-ledger entry and the module-guide update — plus
the migration discipline described under *Migrations* below. It REPORTS: it is
deliberately not in the `main-protection` required checks (those are
`backend-typecheck` and `frontend`), so a red run does not block a merge and the
owner decides. And what it measures is narrower than what these rules say — the
known gaps are pinned, one executable test each, in
`scripts/lib/working-agreement.escapes.test.mjs`; read them before trusting a
green run. There were seven; ESCAPE 3 (rewording somebody else's heading counted
as writing your own entry) was CLOSED on 2026-08-20 by the ledger becoming a
directory — an entry is now a path that did not exist — and its test was rewritten
to assert the closure rather than deleted, so it cannot silently reopen. Before
the gate existed the rules lived only in prose: on 2026-08-13 ten hand-written
PRs shipped that read as fixes and changed code, not one added a bug entry, and
nothing said a word. (The COE rule is not checked: an incident is a judgement call, not
a diff shape.)

| It fails when | It wants |
|---|---|
| the title, the branch name, or a body HEADING reads as a fix, code changed, and `docs/bugs/` gained no NEW entry file | the entry, in this PR (`node scripts/new-bug.mjs "<title>"`) |
| a changed file under `backend/src` / `frontend/src` adds a route, a permission string, a status value, a required-field flip or a lock, and the module guide that quotes that file is untouched | the guide update, in this PR |
| `backend/src/db/migrations-pg/` changed and the body does not carry a `Reversal:` line and a `Verified against:` line | both lines, filled in |

The escapes are LABELS — `no-bug-history-needed`, `no-guide-change` — and they
are not silence: the check prints the violation it waived, so the exception
lands in the log. Rule 3 has no label; two lines in the body is the whole cost.

Where NO guide covers a file whose surface moved, the check WARNS and names the
guide that should exist. It does not fail you for a gap you did not open — but
that gap is the one CLAUDE.md asks you to close.

**This file stays THIN on purpose.** It carries rules and traps, not an
inventory. Facts that change with every merge — route counts, file sizes,
module lists — belong in the map below, because a stale fact HERE is worse
than no fact: this file is auto-loaded, so every session believes it. It
described the database as "D1 SQLite" for over a month after the Postgres
cutover, and pointed at a migration directory that production does not read.

## ⚠️ A number in a comment is a fact with an expiry date — MANDATORY (owner rule)

If you write a measurement into a comment, a doc, or a commit message — a file
count, a duration, a row count, a "we chose N because" sizing argument — you own
keeping it true, or you make it self-checking. A stale number is worse than no
number: the next person does arithmetic on it and inherits your error without
ever knowing they trusted anything.

This rule was bought at full price. `ci.yml` explains its 4-way test shard with
a worked calculation over "112 files" and a "334s" suite. By 2026-08-13 the
suite was **277 files** and one shard alone ran **~380s**. Every later decision
that reasoned from that comment — including the first plan written to fix the CI
slowdown — was wrong in the same direction. See `docs/ci-capacity-coe.md`.

So: prefer a generated artifact with an `audit:` gate over a hand-written
number (`npm run audit:test-schema`, `audit:map`, `audit:routes` are the shape
to copy). If it must be prose, date it inline — "as of 2026-08-13, 277 files" —
so the reader can see how much to trust it.

## ⚠️ Measure before you optimise, and put the stopwatch in the PR — MANDATORY (owner rule)

Never ship a performance change justified by arithmetic alone. Run the probe,
paste the before/after, and name the tool that produced it — same evidential bar
the bug ledger sets for root causes, and the COE section above sets for
incidents.

The cost of skipping it, from the same incident: `tests/setup.ts` replayed 147
migrations per test file, ~283,000 database round-trips per suite run. It is an
overwhelming-looking number and it was the wrong target — timed inside the pool,
those 1020 statements took **391ms**. The real cost was per-file workerd startup,
which no amount of SQL work would have touched.

Performance work also carries the owner's standing rule that it must not
destabilise: change only what you can show is behaviour-preserving. When a
rebuild or fixture is involved, that means proving equivalence against the real
runtime — see `backend/tests/schemaSnapshotParity.test.ts`, which is what caught
a `PRAGMA foreign_keys` difference that was silently putting 90 impossible rows
into every test database.

## `main` IS protected now — since 2026-07-31

The owner created the `main-protection` **ruleset**. Verify it rather than
trusting this paragraph — `GET /branches/main/protection` still returns 404
because that endpoint only reports CLASSIC protection and this is a ruleset:

```
gh api repos/hello-houzs/Houzs-ERP/rules/branches/main
```

It currently returns FOUR rules: `deletion`, `non_fast_forward`,
`required_status_checks` with contexts `backend-typecheck` + `frontend` and
**`strict_required_status_checks_policy: true`**, and `pull_request`.

That strict flag is *Require branches to be up to date before merging*, and it
is the one that will cost you TIME rather than correctness: on a busy day `main`
moves faster than a large PR can finish CI, so the branch has to be re-merged
and re-run, repeatedly. GitHub auto-merge helps — it fires the moment checks are
green AND the branch is current — but it does **not** resolve conflicts, so a
merge that goes DIRTY still needs a person. Measured 2026-08-13 on a 70-commit
PR: five rounds.

The `pull_request` rule is why a direct push to `main` is refused at all, and it
carries `required_approving_review_count: 0` — a PR is required, an approval is
not.

Checked 2026-08-14, it returns FOUR rule types — `deletion`,
`non_fast_forward`, `required_status_checks` and **`pull_request`** — with
contexts `backend-typecheck` + `frontend` and
**`strict_required_status_checks_policy: true`**. That last flag is *Require
branches to be up to date before merging*, and it is the one that matters.

The `pull_request` rule is the newer one and this paragraph listed only three
until it was re-checked. Its parameters are worth knowing before you plan a
merge: `required_approving_review_count: 0`, `require_code_owner_review: false`,
`require_last_push_approval: false`, `allowed_merge_methods: [squash, rebase,
merge]`. So it forces work through a PR — a direct push to `main` is refused —
but it asks for no approvals, which is why one-person merges still land. Do not
read "0 approvals" as "no PR needed".

**There is NO emergency escape hatch.** This paragraph used to end "Repository
admin is on the bypass list as an emergency escape hatch". Two independent
sweeps landed on the same correction on 2026-08-13:
`gh api repos/hello-houzs/Houzs-ERP/rulesets/20119902` returns
`bypass_actors: null` with `enforcement: active` and `current_user_can_bypass:
"never"`. Nobody can force a merge, including the owner. That is fine while
merges are one-at-a-time, and it is the thing to fix FIRST if a merge queue is
ever switched on — a queue that jams with no bypass blocks `main` for everyone
until someone edits the ruleset itself.

**What this now prevents, which used to be yours to catch by hand.** A PR whose
CI ran against a `main` that has since moved can no longer merge; GitHub makes
you update the branch, which re-runs CI against the real merge base. That closes
the STALE-BRANCH mechanism behind the incidents below:

| incident | how it happened |
|---|---|
| 2026-07-22: `main` red ~20 min | #918 and #925 were each green against a `main` lacking the other |
| 2026-07-22: backend could not deploy | #1039 merged a `0171` colliding with #912's; its CI predated #912 |
| 2026-07-31: backend could not deploy for 2h | #1439 merged a `0230` colliding with #1435's, for exactly the same reason |
| **2026-08-13: backend could not deploy for ~30 min** | **#2121 merged a `0284` colliding with #2106's — and the branch was NOT stale. It had merged `main`. The test RAN and FAILED, and the merge happened anyway.** |

> **CORRECTED 2026-08-14.** This paragraph used to end: *"The duplicate-migration
> test would have caught both collisions — it just never ran against a tree
> containing the other branch. Now it has to."* That is now false, and the
> counter-example is the row added above.
>
> On 2026-08-13 `backend/tests/migrationNumbers.test.ts` did run against the
> right tree and did catch the collision —
> `AssertionError: src/db/migrations-pg: 0284 is taken twice — rename your file
> to 0286_*.sql` — and #2121 merged four minutes into that run anyway. **Branch
> protection does not gate on it.** The required contexts are `backend-typecheck`
> + `frontend` (`gh api repos/hello-houzs/Houzs-ERP/rules/branches/main`);
> `migrationNumbers.test.ts` ran in `backend-tests (2)`, which the section below
> forbids making required, for good reasons that remain good. So this class was
> **structurally ungated**, and `gh pr merge --auto` — armed on 12 PRs in 27
> seconds that morning — merges the moment the two required checks go green,
> which is exactly what happened.
>
> **CLOSED 2026-08-17, and it closed by ACCIDENT three days before anyone
> noticed.** `migrationNumbers.test.ts` is no longer in the workers shards. It is
> in the LIGHT project, and `backend-typecheck` — a required context — runs
> `npm run test:light` (`ci.yml`). So a duplicate number blocks the MERGE today.
> Nothing was done about it on purpose: `d78d55bf` (#2131, *"perf(ci): 565s ->
> 106s by not booting a Workers runtime for tests that never use one"*) created
> the light project on 2026-08-14 and swept this suite into it as one of many.
> The remedy below was written the day before and stayed marked "not done" for
> three days while it was in fact done.
>
> Verify, do not believe this paragraph:
> ```
> grep -n "run: npm run test:light" .github/workflows/ci.yml
> cd backend && npx vitest list --config vitest.light.config.mts | grep migrationNumbers
> ```
>
> **What is still yours:** that gating is INCIDENTAL. `classifyTests()` decides
> the split at config time from a regex over the comment-stripped source, so one
> added string containing `cloudflare:test` or `env.DB` moves the suite back to
> the shards and silently un-gates it. That is now pinned by the merge-gating
> test in `backend/tests/classifyTests.test.mjs` — add a suite to its
> `MUST_GATE_MERGE` list whenever an assertion must stop a merge rather than a
> deploy.
>
> The deploy stayed broken from 13:06Z (#2121 merged) until #2124 landed:
> `Deploy` runs 31703284503 and 31704506807 both concluded `failure` with the
> `backend` job **`skipped`**, so nothing merged in that window reached
> production. Recovered by `0c2a4e88` — renumber to `0286`, plus the return-shape
> fix the same batch missed.
>
> **Two remedies, neither of which is "be careful":**
> 1. Move the duplicate-number assertion into `backend-typecheck` — the job that
>    IS a required context — so a collision blocks the merge instead of only the
>    deploy. **DONE — see the CLOSED box above. It was already done when this
>    line still said "Not done", which is the more useful lesson: check the
>    tree before believing a remedy is outstanding.**
> 2. Never arm `gh pr merge --auto` on a PR carrying a migration or an
>    integration batch. Auto-merge structurally cannot wait for a check that is
>    not required.

**Still yours, because no ruleset checks it:**

1. **Take migration numbers at MERGE time** by re-listing the tree. Being forced
   up-to-date makes a collision *fail loudly* instead of merging, but you still
   have to pick a free number — one branch was renumbered four times in a day
   (`0159 → 0165 → 0167 → 0171`).
2. **Renaming an applied migration no longer double-applies it — but it can
   still fail the deploy closed.** Since #914 (2026-07-22) `pg-migrate` tracks
   filename **and checksum**. A rename whose SQL is byte-identical is detected
   as a rename, the tracker row is REPOINTED to the new name, and the SQL is
   explicitly not re-run (`RENAMED <from> -> <to>` in the deploy log,
   `pg-migrate.mjs:167` and the repoint at `:209`). A rename whose CONTENT also
   changed cannot be proven to be the same migration: it is reported as
   `DRIFT ... probable_renumber` and the runner exits 1, blocking the deploy
   until the tracker row is repointed by hand. So renumber freely; edit an
   applied file's body never.
3. **After merging, check the Deploy run — and read the RUN's conclusion beside
   the job's.** `gh api repos/hello-houzs/Houzs-ERP/actions/runs/<id>/jobs`.
   Required status checks gate the MERGE; nothing gates the deploy that follows.
   On 2026-07-31 the backend sat un-deployed for over two hours while `main` was
   green, and it happened again on 2026-08-13 — two `Deploy` runs, both
   **`failure`** with `backend: skipped`.

   | run conclusion | `backend` job | what it means |
   | --- | --- | --- |
   | `failure` | `skipped` | **the deploy FAILED.** Something upstream died and the backend never shipped. This is the incident shape above. |
   | `success` | `skipped` | nothing backend CHANGED. `deploy.yml`'s path filter is `backend/**` + `.github/workflows/deploy.yml`; a docs-or-root-scripts PR legitimately skips it. |
   | `success` | `success` | shipped. |

   > **CORRECTED 2026-08-15.** This rule read "**Treat `skipped` on `backend` as
   > a failed deploy**", full stop, and that is over-broad in the direction that
   > costs you: on 2026-08-15 PR #2207 touched only `BUG-HISTORY.md`,
   > `docs/generated/` and `scripts/check-file-size.mjs` — all outside the
   > filter — and its run was `success` with `backend: skipped`, which the old
   > wording would have had you call a failed production deploy. The signal is
   > the PAIR, not the job alone.
4. **`frontend` is `npm run typecheck` (`tsc -b`), never `npx tsc --noEmit`.**
   *Added 2026-08-14.* `frontend/tsconfig.json` is `{"files": [], "references":
   [...]}` — a solution-style config with no inputs of its own. In `frontend/`,
   `tsc --noEmit --listFiles` emits **0 files** and exits 0; `tsc -p
   tsconfig.app.json --listFiles` emits 1084. CI was never fooled
   (`.github/workflows/ci.yml:70` runs `npm run typecheck`), but three merged PRs
   on `main` — #2106, #2112, #2117 — carry "`tsc --noEmit` clean" as their
   frontend evidence, and #2122 repeated the claim after the no-op was known.
   The same trap was recorded in the bug ledger in July and produced prose
   instead of a check, so it recurred. **A ledger entry with no test attached is
   unfixed.**

   > This paragraph used to cite `BUG-HISTORY.md` line 5562. That citation was checked
   > on 2026-08-20 and line 5562 held an unrelated 2026-08-18 entry — a LINE
   > NUMBER into an append-at-the-top ledger moves every time anyone appends,
   > which was several times a day. It is dropped rather than repointed because
   > the entry it meant could not be identified with confidence, and inventing a
   > target is worse than admitting the reference is lost. **Cite an entry by its
   > FILENAME now** — `docs/bugs/NNNN-slug.md` is stable, and it is what the bug
   > index links to.
5. **A `workflow_dispatch` workflow is not shipped until it has been dispatched
   once and reported success.** *Added 2026-08-14.* #2120's new AutoCount requeue
   workflow failed on its first dispatch (run 31704539182) reaching for
   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, which exist nowhere in this repo
   — it copied `recompute-2990-so-allocation.yml`, a workflow that never ran
   once (deleted 2026-08-20), instead of `recompute-so-allocation.yml`, which
   works. Precedent was taken by name similarity rather than by evidence the
   precedent runs.

**Do NOT add `backend-tests (N)` or `backend` as required contexts.** The shard
name carries an index that changes with the shard count, and `backend` is a
roll-up that is legitimately `skipped` on frontend-only PRs — a skipped required
check leaves the PR pending forever. This rule stands — but note what it costs:
every assertion living only in a shard is advisory at merge time. If an assertion
must BLOCK a merge, it belongs in `backend-typecheck`, not in a shard.

### ⚠️ Update a behind branch by merging `main` LOCALLY. Never press *Update branch*

*Added 2026-08-17.* The strict flag above means a busy day leaves your PR behind
`main` constantly, so you will do this many times. **`git merge origin/main`
locally, then push.** Do NOT use GitHub's *Update branch* button and do NOT run
`gh pr update-branch`.

**The rule stands; the file it was written about is gone.** `.gitattributes` used
to carry `BUG-HISTORY.md merge=union` (PR #2133), because every open branch
prepended an entry to the same first line of that one file. Since 2026-08-20 the
bug ledger is `docs/bugs/`, one file per entry, so that particular conflict no
longer exists for anybody, by any route. **What has NOT changed is the mechanism**
— and this repo still relies on it for the generated docs:

| how the branch is updated | this repo's `.gitattributes` applies |
| --- | --- |
| `git merge origin/main` locally, then push | **YES** |
| *Update branch* button / `gh pr update-branch` | **NO** |

The attribute is applied by whichever git PERFORMS the merge, and *Update branch*
is GitHub's git reading its own configuration, not this repository's. Measured
2026-08-13 on #1905, whose only conflict was `BUG-HISTORY.md`: `git merge
origin/main` locally resolved it clean, `gh pr update-branch 1905` answered
`Cannot update PR branch due to conflicts` — same two commits, opposite answers.

**Still live:** `docs/generated/*.md` and `*.csv` carry `merge=regen`, a driver
you enable per clone (`git config merge.regen.driver "scripts/regen-generated.sh
%A"`). Six of those files are tracked — `codebase-map-facts.md`,
`route-locator.md`, `route-capability-matrix.csv`, `route-capability-summary.md`,
`GLOSSARY.md`, `autocount-coverage.md` — and every backend merge moves the line
numbers in them. GitHub's git has neither the attribute nor the driver, so the
button still reports **CONFLICTING** where a local merge is clean. Merge locally
and push.

**And the deeper lesson, which the ledger split is the receipt for:** a merge
driver only half the merges honour is not a fix, it is a delay. It hid the
BUG-HISTORY conflict from us for months, and the bill arrived the day `main` got
a merge QUEUE — the queue stacks entry 2 on entry 1's result using GitHub's git,
so every queued PR after the first went UNMERGEABLE on that file. Measured
2026-08-20: seven queued, six UNMERGEABLE, all seven touching it. **Prefer a
layout with no shared line over a driver that resolves one.**

**This was not undocumented — and that is the point.** The full trace is in
`docs/ci-capacity-coe.md`, under *"The half of this that does NOT work"* (PR
#2145 is where the correction was first written). It had simply never reached
THIS file, and this is the file that is auto-loaded into every session, so
sessions kept re-deriving it at a cost of hours each. A rule that lives only in
a COE is a rule that is read after the damage, not before it.

### ⚠️ `statusCheckRollup` LIES. Read `mergeStateStatus` and the newest run

*Added 2026-08-17.* `gh pr view --json statusCheckRollup` serves **stale**
entries. On 2026-08-16 it reported `completeness-claim` as `FAILURE` on #2295,
#2300 and #2318 while each of those PRs' newest run of that same workflow had
concluded `success`.

Nothing in this repo can fix GitHub's API, so the remedy is what you read:

```sh
gh pr view <N> --json mergeable,mergeStateStatus          # the honest fields
gh run list --workflow=<name>.yml --branch <branch> --limit 5 \
  --json databaseId,conclusion,headSha,createdAt          # the newest REAL run
```

**Never react to a rollup entry without confirming it against the newest run for
that workflow on that branch.** It has already cost real damage: a legitimate
`enumeration` block was deleted out of another agent's PR to "fix" a failure that
had stopped existing. That is the CLAUDE.md rule *"a contradiction is a finding —
STOP, do not bridge it"* with a name: when the rollup and the run list disagree,
**the run list is right**, and editing code to satisfy the stale one destroys
working evidence.

## ⚠️ Run the audit scripts — they answer questions no doc can

Three dependency-free checks (they run in a fresh worktree with no
`node_modules`). Full story in `docs/one-sided-rules-coe.md`.

**Run them; do not quote a number from this file.** An earlier version of this
paragraph said all three were "at ZERO", and that was wrong — not because the
code changed but because `check-company-scope.mjs` was. It counted a handler as
scoped when a helper NAME appeared anywhere in its body, so
`delivery-orders-mfg PATCH /:id` passed while writing `update(updates).eq('id',
id)` with no predicate, on the strength of an `activeCompanyId(c)` twenty lines
LATER inside an audit field. Two independent readers found that handler while
the script reported zero. It now requires the helper to sit inside a real
`.from(` QUERY, and the honest count went 0 → 20 unscoped writes.

That is the third dead-or-too-loose pattern found in these checkers in one day.
Treat their output as evidence, and this sentence as a pointer to where the
evidence lives.

Each script prints its own corpus size on the first line, so no count is typed
here — an earlier version said "632 SCM handlers" and the checker now reports
1019, which is exactly the drift this file keeps producing.

```
node backend/scripts/check-company-scope.mjs     # SCM handlers: rows touched by id with no company predicate
node frontend/scripts/check-silent-mutations.mjs # useMutation sites: a server refusal that reaches nobody
node backend/scripts/check-shared-mirrors.mjs    # rule modules: frontend copy vs backend original
node backend/scripts/check-docs-drift.mjs        # docs: paths, migration numbers, permission keys, npm scripts
```

**The fourth one exists because THIS FILE lied for a month.** `check-docs-drift`
resolves every mechanically checkable claim the documentation makes — a path, a
`mig NNNN`, a permission key, an `npm run` — against the tree, and `--strict`
gates a PR on the CERTAIN half. It does NOT check behaviour: no script settles
"the confirm gate requires a venue", and that half still needs a reader.

Five markers keep an honest doc green, and each tells the READER the same thing
it tells the checker. **One list, honoured by all three reference checks** —
paths, migration filenames and `npm run` names alike. It used to be two lists
that had drifted apart, and a doc using the right marker for its shape was
reported anyway because the other check had never heard of it.

| marker | meaning |
| --- | --- |
| `` `path` [gone] `` | the doc is RECORDING a deletion — much of `docs/bugs/` is this by construction. Also the marker for a deleted `npm run` script an entry is ABOUT |
| `` `path` [planned] `` | proposed, not written yet |
| `` `path` [external] `` | lives in ANOTHER repo, not here — the 2990 source tree this SCM code was vendored from, or Hookka, which several plan docs shortlist files from |
| `` `path` [generated] `` | REGENERATED on demand and gitignored — `docs/generated/bug-index.md` [generated], `docs/generated/bug-history.md` [generated], `backend/houzs-d1-full.sql` [generated]. Absent in a fresh checkout, present the moment you run the generator. NOT for a TRACKED generated file: those are in the tree and must resolve |
| `` `NNNN_foo.sql` [renumbered] `` | the migration EXISTS and carries a different number — parallel PRs collide on numbers and the loser renumbers. Says "findable, just not at that number", which neither `[gone]` nor `[external]` does |

**The marker goes on the SAME LINE, immediately after the reference**, past any
closing delimiters (`` `"` [gone] `` is fine). A marker that wraps onto the next
line is not seen — reflow the sentence.

**Fenced code blocks ARE scanned.** A fence is where docs put the command a
reader copies, and a stale one there is the most expensive kind. The consequence
to know: a fence quoting a tool's VERBATIM OUTPUT cannot take a marker without
falsifying the quote, so lift the path out of the quote into marked prose.

Do not add a silent exemption list instead. A suppression the reader cannot see
is a suppression nobody re-checks — which is the whole failure mode here.

## ⚠️ `tsc --noEmit -p tsconfig.json` CHECKS NOTHING on the frontend

`frontend/tsconfig.json` is a **solution file** — `{"files": [], "references": [...]}`.
Pointing `tsc` at it compiles **zero files** and exits **0**. A whole session's
worth of "frontend typecheck green" can mean nothing was ever compiled.

```bash
npm --prefix frontend run typecheck    # tsc -b  — the real gate
```

Add `--force` when you want it to ignore `.tsbuildinfo` and recheck everything.
`backend/tsconfig.json` is a normal config with `include`, so `-p` is fine THERE —
which is exactly why the frontend one slips past: the same command is correct one
directory over. If a typecheck finishes suspiciously fast and silent, verify it
with a deliberate type error and confirm it FAILS before trusting a pass.

**Three traps this repo produced repeatedly. Each is now a rule.**

1. **A default is a decision nobody reviews.** `SoLineCard`'s
   `variantsRequired = true` made nine forms demand a field their own server
   never asked for; `scm.pos_carts`' `staff_id PRIMARY KEY` (a column added by
   mig 0100, the KEY left alone) let one company's cart overwrite the other's.
   Where the right answer differs per caller, make the parameter REQUIRED so
   forgetting it fails to compile.

2. **A failure that reaches nobody is worse than a crash.** Thirty-five write
   paths refused correctly and told no one — the owner reported it as "the
   button does nothing". Budget an error path per mutation the way you budget a
   success path (`vendor/scm/lib/mutation-error.ts`).

3. **A checker that cannot match reports a clean run.** Two scripts did this in
   one day: a lost `\s`/`\b` made one scan the wrong function bodies for weeks,
   and repairing it took the count from 34 findings UP to 37 — the extra being a
   cross-company GL posting. Every checker here now self-tests its patterns at
   startup and refuses to report rather than report from a dead one. **A verdict
   computed over nothing must never read as a pass.**

**Read the DDL's own words, not its column list.** Counting `company_id` columns
gave the WRONG answer twice in opposite directions on the fleet tables. The
authority is the migration header plus the READ path — migs 0202/0203/0204/0238
each say `company_id` is stamped "for provenance but NOT used to scope reads",
and `GET /fleet-maintenance/dashboard` reads every row with no predicate. And
`error.code === '42501' → 403` in a handler is NOT a database permission check
doing your scoping: mig 0061 enabled RLS with NO policies and the SCM client is
the SERVICE-ROLE client, which bypasses RLS. The only boundary is the predicate
in the route.

## ⚠️ The C# AutoCount service DOES compile here — check before writing UNCOMPILED

`backend/scripts/autocount-service/AcSyncService.cs` is the one file CI cannot
build: the runner is Linux and the licensed AutoCount assemblies are a desktop
install. That is true, and it is routinely over-read into "there is no C#
toolchain in this environment", which is false and has been for as long as
anyone has checked. This desktop has AutoCount 2.2 installed and `csc.exe` ships
with the .NET Framework, so:

```
powershell -ExecutionPolicy Bypass -File backend/scripts/autocount-service/build-local.ps1
```

answers in seconds, touches no database and needs no credential. On 2026-09-02
it printed `COMPILES CLEAN - 110592 bytes`. Run it before you write UNCOMPILED
in a PR body or a ledger entry — that sentence was written twice in one day by a
session that never ran the check, and it made a whole afternoon of C# changes
look unreviewable.

**Compiling is not deploying.** The swap happens on the office host
(`deploy-on-host.ps1`), because the SQL credentials live there and are compiled
into the exe. Until that runs, the host is executing the OLD binary and reads
none of the new payload keys — so our half of any change ships INERT, which is
safe to merge and changes nothing until somebody rebuilds the host.

## There IS a linter now — since 2026-08-13, and it is a RATCHET

Until this date the repo had none: no `.eslintrc`, no `eslint.config.*`, no
`lint` script in any of the seven `package.json` files — while `backend/src` +
`frontend/src` carried **514** hand-written `eslint-disable` comments that had
never suppressed anything, because nothing ever ran. `tsc --noEmit` and vitest
were the only gates, and neither can see a nullish default on something that is
never nullish.

- `npm run lint` (root, or inside `backend/` / `frontend/`). CI job: **`lint`**,
  matrixed over the two apps. NOT a required status check yet.
- **"ESLint cannot run locally" is a STALE `node_modules`, not a repo bug — the
  fix is one command.** *Added 2026-08-17.* Every session in the week of
  2026-08-15 reported the linter unrunnable and deferred to CI, and one shipped a
  wrong lint fix it could not see was wrong. Traced: `eslint@^9.39.5` is in
  `devDependencies` AND in both lockfiles (`node_modules/eslint`, `dev: true`,
  no `os`/`cpu` gate), there is no `.npmrc`, and `npm config get omit` is empty —
  so nothing skips it. The installed trees simply predate it: the install marker
  npm writes inside each app's `node_modules` is dated 2026-07-31 for the backend
  and 2026-08-02 for the frontend, while the linter landed 2026-08-13
  (`cbdf03618`). Neither tree contains eslint or typescript-eslint at all.
  **`npm ci` in the app directory** fixes it — measured 2026-08-17 at **4
  seconds** for `frontend/`, after which `npm run lint` runs. `lint-ratchet.mjs`
  already prints exactly this instruction when the binary is absent; read it
  rather than concluding the gate is broken.
- **The FRONTEND leg enforces; the BACKEND leg runs `-- --advisory` and only
  reports.** Not laziness — the backend ratchet is 16 file/rule pairs over
  ceiling, all of it debt `main` grew while the linter waited to land, and
  twelve of them are `no-unnecessary-condition` in the money routes where
  deleting the condition would create a real bug: the rule fires because a
  hand-written `as {…}` cast promises non-null over a `sb: any` read, so the
  `??` it calls redundant is the only guard left (worked example in the
  `lint:` job's own comment in `ci.yml`). The upstream fix needs honest types,
  and `schema.pg.ts` covers **none** of the SCM money tables — `drizzle-kit
  pull` first. Drop the `--advisory` flag when that is done and the backend leg
  is green, not before. **Locally it is still strict** — `npm --prefix backend
  run lint` exits 1 and shows you the findings; only CI's backend leg is told to
  report. And a HARD error (ESLint missing, config broken) is never advisory,
  because a gate that did not execute must not report a pass. `--advisory` sits
  on the script rather than `continue-on-error` on the job because the latter
  stops the workflow failing but still publishes the check run as FAILURE —
  measured 2026-08-14 — so the red X survives and the wallpaper stays.
- **It runs `node_modules/eslint/bin/eslint.js` under `process.execPath`, not the
  `.bin/eslint` shim, and that is deliberate.** The shim is a POSIX shell script
  Windows cannot execute (ENOENT, reported as "no ESLint installed" because
  `existsSync` finds it), and `.bin/eslint.cmd` cannot be spawned without a shell
  since CVE-2024-27980 (EINVAL). Do not "simplify" it back to the shim: CI is
  Linux and will not notice, and the linter becomes unrunnable on the OS this
  repo is developed on. `BUG-HISTORY.md` 2026-08-14 has the trace.
- **Every rule is a WARNING.** The gate is `scripts/lint-ratchet.mjs`: a
  **per-file ceiling** in `<app>/eslint-ratchet.json` that may only **FALL**.
  A file with no entry has a ceiling of **zero**, so a new file — or a rule that
  is clean tree-wide — fails on its first violation.
- **Never raise a number in `eslint-ratchet.json` to make a build pass.** Fix the
  finding, or write `// eslint-disable-next-line <rule> -- <reason>` at the site
  so the reason lives next to the code. `npm run lint:update` exists to write the
  ceilings DOWN after you fix things; using it to write them up is forging the
  evidence the gate exists to check (same rule as `check-soak-gate.mjs`).
- **The rule list is `scripts/eslint/houzs-lint-rules.mjs`, and every rule cites
  the ledger entry it exists to catch.** Do not add a rule without one.
  That file also records what was considered and left OFF, and why. It is shared
  by both apps deliberately — a lint layer whose own rule list is hand-copied per
  app is the duplicated-list bug wearing a badge.
- Linting is **type-aware** (`no-unnecessary-condition` needs it), so it lints
  only what the tsconfigs include: `backend/src/**/*.ts` and
  `frontend/src/**/*.{ts,tsx}`. `backend/tests/`, `backend/scripts/`,
  `frontend/perf-lab/` and `frontend/e2e/` are out of scope.

## Read the map before exploring

- **`docs/CODEBASE-MAP.md`** — what each area is FOR, which trees are dead,
  which folders are vendored, where desktop and mobile diverge, and which
  files are too big to open whole. Read this INSTEAD of exploring from
  scratch; it is the hand-written judgement layer.
- **`docs/generated/`** — the mechanical inventory (routes, migrations, largest
  files), COMPUTED from the tree. Which of them can DRIFT is not uniform, and
  guessing wrong in either direction costs you:

  | artifact | gated in CI? |
  | --- | --- |
  | `route-capability-matrix.csv` | YES — `audit:routes`, in `ci.yml` and both deploy workflows |
  | `codebase-map-facts.md` | YES — `audit:map`, in `ci.yml`'s `backend-typecheck` |
  | `bug-index.md` | **NOT TRACKED since 2026-08-18** — it is gitignored. `audit:bug-index` regenerates it in memory and gates on the GENERATOR (parse failure, unresolvable area tag, zero entries), which never needed a copy in git. Run `npm --prefix backend run gen:bug-index` to read it locally. |
  | `bug-history.md` | **NOT TRACKED** — the whole bug ledger rendered newest-first from `docs/bugs/`. Same reasoning as the row above, and the same gate: `audit:bug-history` builds it in memory and refuses a file that is not exactly one entry. `npm --prefix backend run gen:bug-history`. |
  | `route-locator.md` | NO. Re-run `npm --prefix backend run gen:route-locator` before trusting a LINE NUMBER from it. |

  > **CORRECTED 2026-08-15.** This bullet previously said, twice and in two
  > paragraphs that contradicted each other, that CI runs neither
  > `audit:route-locator` nor `audit:map`. `audit:map` HAS been a `ci.yml` step
  > since 2026-08-14 — verify with `grep -c audit:map .github/workflows/ci.yml`
  > rather than believing this line either. The old text also carried a worked
  > drift example (`consignment-returns.ts` "957 lines against an actual 1118")
  > which no longer holds: the map and the file now agree. A stale worked example
  > is worse than none — it reads as freshly measured evidence.
  >
  > The second paragraph was a partial paste that began mid-sentence
  > ("largest files), regenerated from the tree."). If you are correcting a
  > paragraph here, DELETE the one you are replacing.
- **`docs/modules/<module>.md`** — everything needed to work in ONE module
  without reading the others. Read the guide for the module you are touching
  before touching it.
- **`docs/generated/route-locator.md`** — every route's FILE and LINE. Before
  changing an endpoint in a large router (`mfg-sales-orders.ts` and the other
  multi-thousand-line files), grep this for the path and jump to the line. Do
  NOT read a 10,000-line route file whole to find one handler — that is the
  single biggest source of slow, token-heavy sessions here (see
  `docs/AI-DEV-VELOCITY.md`). Pair it with `route-capability-matrix.csv` for the
  full mount path + permission gates. Regenerate with
  `npm --prefix backend run gen:route-locator`.

**Where does a new fact go?** `docs/KNOWLEDGE-SYSTEM.md` answers that, and
explains why these layers exist. One rule decides it: *a fact belongs in the
layer that will be forced to update it when it changes.* A number that shifts
every merge must be GENERATED, never typed — that is exactly how this file
came to claim the database was D1 SQLite for a month after the cutover.

Do not open a 5,000+ line file whole. Three run past 8,000 lines and TWO past
12,000 — `frontend/src/pages/Projects.tsx` is the largest at ~14,900, ahead of
`backend/src/scm/routes/mfg-sales-orders.ts` at ~12,000. Locate with grep, then
read the line range. The map lists the offenders and roughly what lives where
in each.

**Those files may not get any bigger.** `scripts/file-size-ceilings.json`
records what each already is and CI fails if one grows past it; every other
file is capped at 2,000 lines, so a new 3,000-line module fails. Shrinking is
always free and a ceiling may only FALL — `--update` cannot raise one, so if
you are over, the fix is a new module, never a bigger number. Nothing requires
you to SPLIT an existing file. `npm run check:file-size`, rules in
`docs/repo-hygiene.md`.

## What this repo is

Internal ERP for Houzs. Cloudflare Workers + Hono backend, React/Vite SPA
frontend, R2 storage. Single Worker, single SPA.

**The data store is Supabase Postgres, reached through Hyperdrive.** D1 is
test-only now — which matters most for migrations, below.

## Migrations — two trees, only one is real

- **`backend/src/db/migrations-pg/`** is the LIVE tree. `deploy.yml` runs
  `node scripts/pg-migrate.mjs` on every push to main, so a merged file is
  applied to production automatically. A file that fails there blocks every
  later migration until it is fixed.
- **`backend/src/db/migrations/`** is the older D1/test tree. A change put
  there ships, passes CI, merges — and production never changes. Check which
  tree you are in before writing a migration.
- `pg-migrate` tracks applied files by FULL FILENAME, so number gaps and
  out-of-order merges are safe; DUPLICATE numbers are what break it. Pick the
  number at MERGE time by re-listing the tree, not when you branch — parallel
  PRs otherwise pick the same one.

## Release discipline — the two things a revert cannot undo (ENFORCED)

Reverting a commit un-ships a route. It does not un-ship a **migration** (the
file is applied to prod on the next push to main and is immutable from that
moment) and it does not un-ship a **repair script that has already run**. For
those two, the discipline IS the rollback plan, so it is a CI gate and not a
paragraph: `npm --prefix backend run audit:release-discipline`, wired into the
required `backend-typecheck` check.

**A migration carries a `-- REVERSAL:` note.** What undoes it, or `IRREVERSIBLE
— <why>`. If it does `DROP VIEW`, the note has to name the GRANTS the recreate
must put back: a recreated view is a NEW object with an empty ACL, which is how
0189 took prod's Sales Order list down for every user and needed both 0190 and
0191 to repair — nobody had written down what the view's grants were.

**A script in `backend/scripts` that opens a database and WRITES carries all
four of:**

1. a `MODE` / `APPLY` gate whose DEFAULT is plan (any non-`apply` default —
   `'plan'`, `'dry-run'` — counts; an opt-OUT like `DRY=1` does not, because
   unset it writes);
2. a `CONFIRM` phrase on the apply path, refused with an exit (a value you must
   repeat, like `delete-test-so.mjs`'s `CONFIRM_DOC`, is stronger and also counts);
3. a verification that re-reads on a **FRESH connection** and asserts the
   **SHAPE**. A row count is not a shape: on 2026-08-13 a repair written to undo
   the jsonb double-encoding COE reproduced that exact bug on 7 production rows,
   and its row count reported 7 of 7 while only its shape check saw it;
4. a `RE-RUN:` line in the header saying what a SECOND run does.

Copy `repair-array-shaped-variants.mjs` or `unify-processing-date.mjs` — both
pass all four today.

**It is a ratchet.** Today's tree is grandfathered rule-by-rule in
`backend/scripts/release-discipline-grandfathered.json`, and that list may only
SHRINK: fix a rule and the check makes you delete it from the ledger in the same
PR, and the count is printed on every run so the debt stays visible. A NEW
script complies or CI fails.

## ⚠️ Never ask the owner to run a query — build the check instead (owner rule)

The owner is not a database console. If you need a fact that lives only in
production, the answer is a script plus a `workflow_dispatch` workflow that
reads it using `secrets.DATABASE_URL` — **not** a SQL snippet pasted into chat
for him to run. Asking costs an interruption every single time, and it puts the
production DSN in front of a human for what is usually a `SELECT`.

Live example to copy: `backend/scripts/check-soak-gate.mjs` +
`.github/workflows/soak-gate-check.yml`. Actions → **Soak gate check
(read-only)** → Run workflow; the verdict appears as a run annotation.

**`DATABASE_URL` is the credential. There is no other one.** Nearly every
workflow here uses `secrets.DATABASE_URL` (289 of 300 as of 2026-08-14 —
`grep -rl secrets.DATABASE_URL .github/workflows | wc -l`, which is the number
to re-run rather than trust); it is the only database secret this repo holds, at
repo level or in any of its three environments. If your script needs a
PostgREST-shaped client — because it imports a real service function out of
`src/` rather than re-implementing it, which is the right instinct — it needs
the SHAPE, not PostgREST credentials: `backend/scripts/lib/pgrest-shim.mjs`
gives you `sb.from(...)` over the pg connection. Copy
`recompute-so-allocation.mjs`, which does exactly this.

**`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` exist — as WORKER secrets, never
as Actions ones.** Both halves matter, and stating only the first sent two
authors down a dead end. They are real and in use: `src/db/supabase.ts:66`
builds `createClient(url, serviceKey)` and every `sb.from(...)` in the SCM
module is a PostgREST call (`wrangler secret list --name autocount-sync-api`
lists both). They are absent from GitHub: not at repo level, not in Production,
not in Staging. **Adding them to Actions is forbidden** — this repository is
public, non-admin collaborators can read repository secrets, and the
service-role key bypasses RLS on the one database both tenants share, so it is
total access to both. A workflow that needs PostgREST cannot have it; if it
needs the SHAPE, use `pgrest-shim.mjs` over `DATABASE_URL`. If it genuinely
needs the REST EDGE — the ceiling measurement is the real case — ask the Worker,
which already holds the credentials: `GET /api/admin/health/rest-page-ceiling`.
`recompute-2990-so-allocation.yml` was wired to them, never ran, was copied
anyway despite a warning here, and was DELETED on 2026-08-20.
`SOURCE_SUPABASE_URL` / `SOURCE_SERVICE_ROLE_KEY` DO exist as Actions secrets
and are a third thing again: they point at the 2990 SOURCE system, not at Houzs.

Rules for anything in this shape:

- **Read-only means read-only.** One statement, no DDL, no writes, no
  transaction. If a check needs to write, it is not this pattern.
- **Manual trigger only.** Never put a production DB read on a schedule; it
  turns a real query into CI noise nobody reads.
- **Own concurrency group, never the deploy's.** A diagnostic must not queue
  behind — or displace — a release.
- **Exit 0 for every legitimate answer.** A red job reads as "the check broke".
  The answer is the output. Reserve non-zero for an unreachable DB.
- **Evidence is not a setting.** When a marker row is MISSING, say so and stop.
  Never insert it to make a gate pass — that forges the exact evidence the gate
  exists to check. (This is why `check-soak-gate.mjs` treats zero rows as its
  own outcome, not as "false".)

**Never accept a credential through chat, and never read one out.** On
2026-07-22 an attempt to identify which database a local `.dev.vars` pointed at
echoed the whole DSN, password included, into a transcript — the file's value
was quoted, so the `sed` that was supposed to strip it did not match. If you
must inspect a secret-bearing file, match the field you want and print only
that; never print a line and never let a failed match fall through to the raw
value. If one is exposed anyway: say so immediately, record the rotation task
in the repo, and keep reminding until the owner confirms it is rotated.

## Desktop and mobile are one product

`frontend/src/mobile` is a first-class surface, not a viewport tweak. Most
features exist as a desktop file and a mobile file that must change TOGETHER
— the owner's standing rule is ONE shared logic layer, with the two surfaces
differing only in presentation. Fixing a rule on one surface and not the
other is a recurring bug class here (see `BUG-HISTORY.md`). The map lists the
known pairs.

## Obsidian wiki — keep it current

A companion knowledge base lives in the user's Obsidian vault under
`Houzs ERP/`. It's the human-readable counterpart to the codebase
(architecture, decisions, module guides, glossary). It is the human-facing
counterpart to `docs/CODEBASE-MAP.md`, which is the agent-facing one.

The Obsidian MCP is registered at USER scope, not in this repo, so
`mcp__obsidian__*` is available only in sessions that have it connected —
several do not. If those tools are absent, skip the wiki and say so rather
than working around it; the repo-side map is the fallback that always works.

**When to update the wiki** — after work that meaningfully changes:

- A module's surface (new endpoints, new permission, new tab)
- The data model (new migration that touches an existing concept)
- An architectural decision (always add to `Houzs ERP/Decisions.md`)
- A core pattern (ACL, polling, UDF, scoping)
- The roadmap (move items between sections, mark done, add new ones)

**When NOT to update** — bug fixes, refactors that don't change the
surface, dependency bumps, doc fixes inside the code itself.

**How to update** — append a section under the existing structure;
don't rewrite. Cross-link with `[[wiki-link]]` syntax. Match the tone
of the existing notes (concrete, terse, callouts where useful).

The user's preference, in their words: *"do your best and be creative"*
and *"fill them with details specific"* — the wiki should always carry
real schema columns, real LOC counts, real SQL, real permission keys.
Not generic narrative.

## Coding conventions specific to this repo

- **No emoji.** Anywhere. Empty states, status copy, comments, commits.
- **A parameter that DECIDES something is required, never optional.** If its
  absence changes an answer — a gate, an exemption, a scope, a threshold, a
  default that is not neutral — write it as `x: T | null` and let the compiler
  enumerate the call sites. `x?: T` means every caller that says nothing keeps
  the OLD behaviour, with no compile error, no failing test and no runtime
  signal, so the rule ends up applying only where someone remembered it. This
  cost four days on `itemCode` (DIVAN ONLY lines kept demanding a mattress Gap
  after PR #1763 said "every desktop + mobile call site"), and the same hole
  shipped `onMultiPo` on the drop-ship batch resolver, where the silent default
  was the permissive one. Where "no value" is legitimate, pass an explicit
  `null` — it reads as a decision — and assert what `null` means. An optional
  parameter is acceptable only when its absence is the STRICTER direction, and
  then the comment has to say so (precedents: `assertNotMirrored`'s missing
  context leaves the guard active; `scopeToCompanyId` in
  `scm/lib/companyScope.ts` states this rule in full). See **BUG CLASS
  optional-param-noop** —
  `docs/bugs/0098-bug-class-optional-param-noop-an-optional-argument-that-deci.md`.
- **If you write "every call site", PROVE it in the PR body.** Claiming a whole
  population — "every desktop + mobile call site", "all four arms",
  "system-wide", "everywhere" — makes
  `.github/workflows/completeness-claim.yml` require a fenced ` ```enumeration `
  block holding the command that ENUMERATES that population and its output. CI
  re-runs the command against the PR head and fails on any difference, so a
  pasted list cannot be stale or invented. Allowed commands are `grep`, `rg`,
  `git grep`, `git ls-files` and `node -e` one-liners over this checkout;
  nothing goes through a shell. Two populations need two blocks. If the words
  were not meant as a claim, reword them — say what you DID cover ("the three
  desktop call sites") — or add the `completeness-not-claimed` label, which
  waives the proof and then prints the wording back and asks you to change it.
  This exists because PR #1763's body said "every desktop + mobile call site"
  and five of its thirteen call sites did not get the argument; see **BUG CLASS
  unverified-completeness-claim** —
  `docs/bugs/0099-bug-class-unverified-completeness-claim-every-call-site-unch.md`. As of
  2026-08-13 the detector fires on 13.6% of merged commit messages — roughly one
  PR in seven makes a claim of this shape; re-measure before quoting that.
  **A `path:NNN:` line number in your pasted output is NORMALISED AWAY before
  the diff** (since 2026-08-17): a merge that shifts a 12,000-line router no
  longer fails a PR that changed no member of the population. Membership is
  still exact — an added, removed, retexted or file-MOVED site fails as before —
  so `git grep -n` is safe to paste. The one shape that is not normalised is a
  BARE `NNN:` with no path (`grep -n pattern onefile`), because a leading number
  with nothing in front of it is indistinguishable from content; the gate fails
  and tells you to include the path.
- **Drizzle ORM for new code.** New routes / services use Drizzle —
  schema in `backend/src/db/schema.ts`, client via
  `getDb(env)` from `backend/src/db/client.ts`. Raw
  SQL via `c.env.DB.prepare(...)` is still allowed in legacy code
  paths until they're converted route-by-route. Don't mix the two
  styles inside a single function — convert the whole handler. **Migrations
  remain hand-written `.sql` files** — in `src/db/migrations-pg/` for
  anything that must reach production (see *Migrations* above) — numbered
  and immutable after deploy. Drizzle-kit is for type generation /
  schema diffing only, never as the migration runner.
- **Demo / test seed data does NOT belong in numbered migrations.**
  Numbered migrations run in prod. Migs 067 + 069 seeded 39 fake
  `sales_reps` with `@example.my` emails; mig 079 then had to delete
  them. All three live in `src/db/migrations/`, the D1 tree production
  no longer reads, so the seed-then-cleanup cost is now paid only by a
  fresh D1 test DB — not by prod. Do not read that as the rule being
  spent: it is the same mistake in `migrations-pg/` that would be
  permanent. Put demo data in a one-shot `backend/scripts/seed-*.mjs`
  script you run manually against the local D1 (precedent: existing
  `backend/scripts/backfill-project-codes.mjs`). Numbered migrations
  are for schema changes + production-required data only — lookup
  tables, default roles / permissions, canonical enum rows. If a
  table needs sample rows to develop against, that's a script, not
  a migration.
- **Anything a TEST imports lives in `backend/scripts/lib/` and carries
  NO shebang.** Runnable scripts keep their `#!/usr/bin/env node` (~200
  do). A module a test imports must not have one: on Windows vitest
  INLINES it and wraps the source before `vm.runInThisContext`, so a `#!`
  that is no longer at byte 0 is `SyntaxError: Invalid or unexpected
  token`. It dies at LOAD, so it reports as a failed FILE with zero
  tests, no assertion and no line number — it reads exactly like a
  corrupt byte, and one such throw is counted TWICE (failed suite +
  Unhandled Rejection), so it looks like two broken files. Linux
  externalizes the same module and node strips the shebang itself, so
  **CI stays green and only local Windows breaks** (#2062 — BUG-HISTORY
  has the trace). No test-imported `.mjs` carries a shebang today, which
  is the property that matters — but three of them do NOT live in
  `scripts/lib/`: `scale-pg-real-schema.mjs`, `scale-target-guard.mjs`
  and `repair-so-fee-line-integrity.mjs` sit directly in
  `backend/scripts/`, imported by `tests/scale*.test.mjs` and
  `tests/soFeeLineRepairRow.test.ts`. Adding a `#!` to any of those three
  breaks local Windows and CI will not tell you. If a runnable script
  needs to expose a function to a test, put the pure part in
  `scripts/lib/` and import it from the script.
  *(Said `tests/scale*.node.mjs` until 2026-08-15. Those files were renamed to
  `*.test.mjs` by #2180 — a `node:test` suite contributed nothing to the merged
  coverage report — and this line was not updated with them, so it pointed at
  files that do not exist. Re-check with `ls backend/tests/scale*`.)
- **Keep schema and data in separate migrations when both are large.**
  An `ALTER TABLE` + 100-line `INSERT` block in the same file makes
  rollback awkward and the diff hard to read. Numbered migrations are
  cheap; prefer two small ones over one big one.
- **No WebSockets yet.** Polling is the realtime mechanism — see the
  wiki's *Polling Strategy* note for cadence and rationale.
- **URL is state.** Filters/tabs/modes go in `useSearchParams`.
  localStorage is fallback for personal prefs only.
- **Company scope: the predicate is the only isolation — on WRITES too.**
  The SCM/Houzs supabase client is the **service role**, so it **bypasses
  RLS** and no policy is ever evaluated on an app request. The
  `company_id` predicate a statement carries is the entire tenant
  boundary. Three rules follow:
  (a) put it on the write itself, not only on the read that preceded it —
  nothing re-checks between two PostgREST round trips, which is how a
  scoped-read-then-open-update shipped across the whole system;
  (b) a parent-ownership predicate (`so_doc_no`, `purchase_invoice_id`,
  `trip_id`) proves the row is on that document, NOT that the document is
  in your books — you need both;
  (c) a cross-company module still takes a predicate, just a wider one
  (`scopeToAllowedCompanies` = the caller's granted companies); "shared
  queue" never means "no predicate". Use `scopeToCompany` /
  `scopeToCompanyId` from `scm/lib/companyScope.ts` (that file's header is
  the reference), and `maybeSingle` not `single` on any by-id statement
  carrying one — the predicate can legitimately match zero rows and
  `single()` reports that honest 404 as a 500. If a route is
  deliberately cross-company or deliberately shared, say so in a comment
  naming why, so the next sweep does not "fix" it. Background:
  `docs/MULTICOMPANY-MODULE-MAP.md`.
- **Permissions are flat strings**, e.g. `projects.read`. Catalogue
  lives in `backend/src/services/permissions.ts`. New verbs since
  mig 047: `projects.chat`, `projects.checklist.tick` — use
  `requireAnyPermission([...])` to gate routes that accept either a
  narrow verb or `projects.write`.
- **Project row-level visibility is COMPANY-ONLY (owner decision 2026-08-19).**
  The old two-dimensional PIC one-hop + brand allow-list ACL (migs 048/049,
  `services/projectAcl.ts` [gone]) was REMOVED: within a company, any user with
  the projects page permission sees every one of that company's projects.
  Visibility = the `requirePageAccess` gate + the `company_id` /
  `activeCompanySql` predicate. Crew scoping (helpers/storekeepers/drivers →
  their crewed events) is a separate axis and stays. `user_brands` and
  `GET/PUT /api/users/:id/brands` were kept because they still drive the
  DIRECTOR approval-lane brand split (`approverBrandBlocked` in
  `services/projectGates.ts`), NOT project visibility. See
  `docs/modules/projects-pms.md` Axis 2.
- **Section + attachment data on tasks** (mig 050). Project tasklist
  groups by `project_checklist_sections`; per-task attachments live
  in `project_checklist_attachments`. The project-level
  `project_attachments` table is kept for legacy data, no longer
  surfaced in the UI.

## Working agreement

- Don't add features, refactor, or introduce abstractions beyond what
  the task requires.
- Default to no comments. WHY only, never WHAT.
- For UI changes, test in the browser before claiming success.
- Confirm before destructive ops (force push, dropping tables, deleting
  branches). Auto-mode is not blanket consent for risky writes.
  - Write TODO when planning is confirmed 
  - After meaningful work lands, end the reply with a one-line offer to
  `/sync-wiki` if the wiki should be updated.

## A merged PR's branch gets DELETED — MANDATORY (owner rule, 2026-08-12)

*"确保做好了的PR 就delete掉."* A branch whose PR has merged is finished: its
content is on `main`, and leaving it on `origin` costs a real thing. On
2026-08-12 the repo carried **1,510 remote branches, 1,406 of them heads of
already-merged PRs** — a `git branch -r` nobody could read, a tab-complete
nobody could use, and 1,406 chances to branch off dead work by mistake. They
were pruned in one pass, with a name+SHA manifest kept so every one stays
restorable.

**The durable fix is a repo setting, not a habit** — habits are what produced
the 1,406. Settings -> General -> **Automatically delete head branches**.

**IT IS ON. Verified 2026-08-19** — `gh api repos/Houzs-Century/Houzs-ERP --jq
.delete_branch_on_merge` returns `true`, and the branches of #2483 and #2487
were both already gone the moment their merges landed: `git push origin --delete`
answered `remote ref does not exist`. So the manual delete after a merge is no
longer yours, and a session that still does it by hand is doing nothing.

This paragraph said `false` as of 2026-08-12 and asked the owner to flip it, for
a week after somebody flipped it. That is the shape this file warns about in its
own words — an auto-loaded stale fact is worse than no fact, because every
session believes it. Re-run the command above rather than trusting this
paragraph either.

Deliberately NOT solved with a workflow. A GitHub Action could delete the branch
on merge without admin, but this repo has just paid for a workflow that died
silently and went unnoticed for three weeks (`docs/staging-bench-rot-coe.md`). A
setting cannot rot; a workflow can. One checkbox beats one more thing to watch.

What the setting does NOT cover, and stays manual:

- **PRs closed without merging.** GitHub leaves those branches alone, correctly
  — the work was abandoned, not landed, and the branch is the only copy. Review
  before deleting, never bulk-prune them.
- **Branches with no PR at all.** As of 2026-08-12 there were 51, and `main` and
  `staging` are among them. Never bulk-delete this set.

To prune by hand, select on the PR being MERGED — never on age, and never on
`git branch -r --merged`, which misses everything squash-merged (it found 291 of
the 1,406):

```sh
gh pr list --state merged --limit 3000 --json headRefName --jq '.[].headRefName' | sort -u > /tmp/merged.txt
git ls-remote --heads origin | sed 's|.*refs/heads/||' | sort -u > /tmp/branches.txt
comm -12 /tmp/branches.txt /tmp/merged.txt   # verify this list before deleting anything
```

Record `sha<TAB>branch` for whatever you delete. `git push origin <sha>:refs/heads/<branch>`
restores it without depending on GitHub's Restore button.

## See also

- **`docs/KNOWLEDGE-SYSTEM.md`** — the layers, what belongs where, and why
- **`docs/CODEBASE-MAP.md`** — start here for anything you would otherwise
  go exploring for; `docs/generated/` for the mechanical inventory
- **`docs/bugs/`** — the bug ledger, one file per entry. Read the entries for a
  subsystem before touching it; `npm --prefix backend run gen:bug-index` is the
  way in, and `docs/bugs/README.md` explains the layout
- **`docs/repo-hygiene.md`** — the branch rules and the file-size ratchet
- `/sync-wiki` — user-scope slash command for the Obsidian refresh; the
  command file is NOT in this repo, so it exists only where the user has it
  installed
- The user's auto-memory MOC at `~/.claude/projects/<hash>/memory/MEMORY.md`
- The Obsidian wiki's `Houzs ERP/00 Home.md` for the map of content
