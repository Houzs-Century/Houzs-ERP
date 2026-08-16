// ----------------------------------------------------------------------------
// houzs-lint-rules.mjs — the ONE declaration of what this repo's linter checks.
//
// WHY THIS FILE EXISTS, and why it is not two copies inside backend/ and
// frontend/: `BUG-HISTORY.md` records the duplicated-list class ~30 times, most
// recently the DO status list hand-typed into ELEVEN files ("a comment naming
// the file it copied from is not a link to it"). A lint layer whose own rule
// list is hand-copied per app is that bug wearing a badge. Both
// eslint.config.mjs files import this; neither declares a selector.
//
// It takes NO dependencies (plain data + string selectors) so it loads under
// `working-directory: backend` with only backend/node_modules installed.
//
// EVERY entry below cites the BUG-HISTORY.md entry it exists to catch. A rule
// with no entry behind it does not belong here — see the PR that added this
// file. Selectors are esquery, the same language `no-restricted-syntax` speaks.
// ----------------------------------------------------------------------------

/** The DO lifecycle statuses. Any array literal of 3+ elements that spells
 *  IN_TRANSIT by hand is a copy of `scm/shared/do-shipped-states.ts`.
 *
 *  Why IN_TRANSIT and not DISPATCHED or SIGNED: the legitimate NON-copies in
 *  this tree are the filter-pill partition in `delivery-orders-mfg.ts`
 *  (`in_transit: ['DISPATCHED','IN_TRANSIT']`, 2 elements — under the length
 *  floor; `delivered: ['SIGNED','DELIVERED','INVOICED','COMPLETED']`, which is a
 *  UI bucket and NOT the shipped set). Every real copy of the shipped/lifecycle
 *  list carries IN_TRANSIT among 3+ members. Measured, not guessed: this
 *  selector matches `do-shipped-states.ts` itself and nothing else in
 *  `backend/src`.
 *
 *  BUG-HISTORY.md — "The delivery agent's DO pipeline never counted COMPLETED,
 *  because it kept its own copy of the status list": *"`DO_STATUSES` ... the
 *  copy had lost COMPLETED. `collectDoStatusCounts` issues one count per member
 *  of that list, so a status missing from the list is a status never queried."*
 *  The same sweep found the "has shipped" set written out by hand in ELEVEN
 *  files across two spellings, which is how two audits came to measure the same
 *  question over different populations with neither output saying so. */
const doStatusList = {
  selector: "ArrayExpression[elements.length>2] > Literal[value='IN_TRANSIT']",
  message:
    'Hand-typed DO status list. Import DO_SHIPPED_STATES / DO_STOCK_OUT_STATES / ' +
    'DO_STATUSES / DO_PRESHIP_STATES from scm/shared/do-shipped-states (backend) — ' +
    'the .mjs audits use scripts/lib/do-shipped-states.mjs, pinned by ' +
    'tests/doShippedStatesMirror.test.ts. This list was hand-copied into eleven ' +
    'files and two of the copies had already drifted apart. If this array is a ' +
    'genuinely different partition, disable this line and say which one.',
};

/** snake_case finance column vocabulary — the PostgREST spelling.
 *
 *  BUG-HISTORY.md — "Six routes hand-declared the finance list that
 *  `lib/finance-keys.ts` exists to end — THREE PRs after its header said 'keep
 *  ONE list, imported everywhere'": *"What the shared module lacked was any
 *  force: nothing made importing easier than typing three strings ... Six
 *  identical copies is not six bugs; it is six loaded guns — #574 / #600 / #625
 *  / #632 are all the same story played out AFTER the copies drifted."*
 *
 *  This is the force. The six per-document subsets that exist today each carry a
 *  written rationale for staying local; they are in the ratchet at their current
 *  count and the ceiling may only fall. A SEVENTH copy fails the job. */
const financeKeyListSnake = {
  selector:
    "ArrayExpression[elements.length>2] > Literal[value=/^(unit_cost_centi|line_cost_centi|line_margin_centi|total_cost_centi|total_margin_centi|margin_pct_basis|cost_price_sen)$/]",
  message:
    'Hand-declared finance-key list. scm/lib/finance-keys.ts is the one vocabulary ' +
    '(SO_FINANCE_KEYS / SO_ITEM_FINANCE_KEYS / PRODUCT_FINANCE_KEYS / ' +
    'AUDIT_FINANCE_FIELDS). Six routes re-declared it after that file said not to, ' +
    'and every copy drifted; #574/#600/#625/#632 are one bug seen four times. If ' +
    'this really is a per-document subset, disable this line and state which ' +
    'columns THIS document has that the shared list does not.',
};

/** camelCase finance vocabulary — the API/audit spelling, and the documented
 *  escape hatch. `finance-keys.ts` warns in writing that "a camelCase surface
 *  (e.g. `unitCostCenti`) would escape this list".
 *
 *  BUG-HISTORY.md: *"`field_changes` is a jsonb blob keyed by the API's
 *  camelCase field names, while every finance strip list is snake_case PostgREST
 *  column names. `lib/finance-keys.ts` even warns about this ... the warning was
 *  written and the audit-log was still missed."* The sanctioned homes are
 *  `lib/finance-keys.ts` (AUDIT_FINANCE_FIELDS) and `lib/entity-audit-fields.ts`
 *  (the camel->snake pair maps, which are 2-element arrays and sit under the
 *  length floor). Everything else is a fifth copy of a leak.
 *
 *  Currently ZERO in both trees. */
const financeKeyListCamel = {
  selector:
    "ArrayExpression[elements.length>2] > Literal[value=/^(unitCostCenti|lineCostCenti|lineMarginCenti|depositCenti)$/]",
  message:
    'Hand-declared camelCase finance-key list — the escape hatch finance-keys.ts ' +
    'warns about in writing ("a camelCase surface would escape this list"), and the ' +
    'mechanism behind the SO audit-log cost leak. Import AUDIT_FINANCE_FIELDS / ' +
    'stripAuditFinance from scm/lib/finance-keys.',
};

/** `as never` — the cast that turns the compiler off exactly where it was about
 *  to help.
 *
 *  BUG-HISTORY.md — "The new 3PL fleet form could not add a lorry at all — it
 *  offered lorry types the database enum does not have": *"`type: lorryType as
 *  never` — the cast silenced the one check that would have caught it. Typecheck,
 *  960 unit tests and the production build were all green ... Only submitting the
 *  form against production found it."* And its lesson: *"`as never` is a request
 *  for the compiler to stop checking exactly where it was about to help."* */
const asNever = {
  selector: 'TSAsExpression > TSNeverKeyword',
  message:
    '`as never` turns off the check that was about to help. A hand-written option ' +
    'list cast past its enum shipped a form that refused every value it offered ' +
    '(3PL lorry types, 2026-08-02) — typecheck, 960 tests and the build were all ' +
    'green. Type the value, or import the shared constant that already types it.',
};

/** The `no-restricted-syntax` option list. Order is the report order. */
export const restrictedSyntax = [
  doStatusList,
  financeKeyListSnake,
  financeKeyListCamel,
  asNever,
];

/**
 * Rules shared by both apps, with the BUG-HISTORY entry each one answers.
 *
 * EVERY rule here is `warn`. That is deliberate and it is the whole design:
 * `scripts/lint-ratchet.mjs` is the gate, and it holds a per-file CEILING that
 * may only fall. A rule whose tree is already clean has no ceiling entries at
 * all, so its first violation anywhere fails the job — an error in everything
 * but the word. A rule with 2,618 pre-existing hits is pinned where it stands
 * instead of failing the build on day one and getting the whole layer deleted.
 */
export const sharedRules = {
  // ── no-floating-promises ──────────────────────────────────────────────────
  // BUG-HISTORY.md, "A leaked timer in the chunk-recovery boundary failed
  // `npm test` on a deploy — and SKIPPED a production frontend release":
  //   "`hardRecover()` in `frontend/src/components/RouteFallback.tsx` is
  //    FIRE-AND-FORGET — `componentDidCatch` starts it and never awaits it."
  //   "A fire-and-forget async function is a promise nobody is holding:
  //    anything it touches after its last `await` can outlive the thing that
  //    started it."
  // The deploy that swallowed the release was green everywhere else; the run
  // blamed an unrelated test file. Also the shape behind "`setDialog` runs
  // synchronously after the unawaited `q.refetch()`, so a stalled refetch still
  // shows 'Successfully created N POs' with the numbers."
  '@typescript-eslint/no-floating-promises': 'warn',

  // ── no-unnecessary-condition ──────────────────────────────────────────────
  // The rule that needs types, and the reason this repo gets ESLint rather than
  // another grep script: it is the only gate here that can SEE a `??` whose
  // left side is never nullish, or a `?.` on a value the type says is present.
  // `tsc --noEmit` reports neither.
  //
  // BUG-HISTORY.md, the reversal-triplet audit:
  //   "`orig.company_id ?? null` can never take its right-hand branch: the
  //    value is a real id from a row that was successfully read, not an optional
  //    lookup ... No change needed — recorded so the next reader does not 'fix'
  //    it."
  // A human had to trace a NOT NULL column through two migrations to prove one
  // `??` was dead. This rule answers that in a second.
  //
  // And when the same shape is NOT dead it has shipped an outage:
  //   "`d.status` is NOT NULL, so the `''` fallback was dead code — but Postgres
  //    still type-checks the branch when the statement is planned, so it throws
  //    unconditionally, on the very first call, forever."
  //
  // The optional-chain half, from the jsPDF upgrade review:
  //   "If `lastAutoTable.finalY` ever stopped being published, the optional
  //    chain would swallow it and the GRAND TOTAL block would be drawn back on
  //    top of the line items — no exception, no failing typecheck, and a
  //    corrupted invoice leaving the building."
  // and the standing frontend rule: "`a?.b.c` guards only `a` — chain every hop
  // that can be undefined."
  //
  // allowConstantLoopConditions keeps `while (true)` legal; the rest is on.
  '@typescript-eslint/no-unnecessary-condition': [
    'warn',
    { allowConstantLoopConditions: true },
  ],

  // ── no-explicit-any ───────────────────────────────────────────────────────
  // Load-bearing here, not stylistic: this codebase's own authors already
  // believed it was on. There are 98 hand-written
  // `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comments in
  // backend/src + frontend/src, and until this PR there was no ESLint in the
  // repo for any of them to suppress.
  //
  // BUG-HISTORY.md, the 3PL lorry-type entry, on the sibling cast:
  //   "a hand-written option list against a database enum is a duplicate of that
  //    enum, and `as never` is a request for the compiler to stop checking
  //    exactly where it was about to help."
  // Same class: `any` at a wire boundary is how a payload keeps a shape nothing
  // checks. Compare the entry that refused it — "No `as any`, no cast: the
  // vendored aggregation still computes margin exactly as 2990 does."
  '@typescript-eslint/no-explicit-any': 'warn',

  // ── the hand-copied literal lists ─────────────────────────────────────────
  // Each selector cites its own entry above.
  'no-restricted-syntax': ['warn', ...restrictedSyntax],
};

/**
 * Rules considered and DELIBERATELY LEFT OFF, recorded here so the next reader
 * does not re-derive the decision (and so "why isn't X on?" has an answer that
 * is not "nobody thought of it"):
 *
 * - `@typescript-eslint/require-await` (58 backend / 38 frontend hits). No
 *   BUG-HISTORY entry describes a defect an `async` function with no `await`
 *   caused, or would have caused. The brief that commissioned this layer
 *   suggested it next to `no-floating-promises`; the corpus backs the second and
 *   not the first. 96 findings with no incident behind them is the wall of style
 *   rules that gets a lint job deleted in a day.
 * - `@typescript-eslint/no-misused-promises` (730 frontend hits). Almost all are
 *   `onClick={async () => …}`, which React handles. No entry behind it.
 * - `@typescript-eslint/await-thenable` (6 frontend hits). No entry behind it.
 * - `react-hooks/*`. The plugin is REGISTERED in the frontend config with every
 *   rule off, purely so the 97 `eslint-disable-next-line react-hooks/…`
 *   directives already in the tree resolve instead of failing as "Definition for
 *   rule was not found". Turning `exhaustive-deps` on is a separate PR with its
 *   own evidence; it is not smuggled in under this one.
 * - Every stylistic rule (`semi`, `quotes`, `no-console`, import order, …).
 *   There are 213 `eslint-disable … no-console` directives in the tree; none of
 *   them is a bug.
 */
export const deliberatelyOff = [
  '@typescript-eslint/require-await',
  '@typescript-eslint/no-misused-promises',
  '@typescript-eslint/await-thenable',
  'react-hooks/exhaustive-deps',
  'react-hooks/rules-of-hooks',
];
