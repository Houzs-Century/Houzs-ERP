## Nine convert pickers told the operator the work was finished when the query had simply come back empty [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** Every line-level convert picker in the app answered an empty result
with a verdict about the business: "every line has been fully delivered", "every
line has been fully invoiced or returned", "every posted GRN has already been
invoiced", "all qty already received". The from-PO picker had this removed in
#2367 after the owner watched it say every line of a purchase order had been
received while the order itself showed two lines still outstanding — the server
had returned nothing because its read was truncated. The sentence stayed on the
other eight pickers, and was reintroduced on the from-PO picker itself five
commits later in a rewritten helper, with a test asserting the claim was
legitimate.

**Root cause.** The rule was expressed in prose and reproduced anyway — the
shape this repo keeps finding, a rule present at N-1 of N call sites. An empty
read cannot support any of those sentences here:

- `scopeToCompany` (`scm/lib/companyScope.ts:312`) answers an unresolvable
  company with `.in('company_id', [])`. PostgREST returns `[]` with
  `error: null`, which is byte-identical to a company with no work left.
- PostgREST truncates at `db-max-rows` silently, so a `.limit()` above the
  server ceiling is an upper bound and not a request.
- A swallowed read error returns empty; 954 such sites predate the ratchet.
- A filter the operator forgot narrows the read invisibly.

Two of the sites were worse than unprovable. `GrnNew` and
`PurchaseConsignmentReceiveNew` had NO error arm at all — a FAILED read of a
purchase order rendered as "all qty already received", so the operator receives
nothing against a live order. And `no_returnable_qty` in `purchase-returns.ts` /
`purchase-consignment-returns.ts` said "every line is already fully returned"
about a value computed from the REQUEST BODY (`items.filter(qty > 0)`), naming a
cause nothing on that path had read.

**Fix.** Eleven surfaces now report what was searched and what would explain a
false empty, in the wording the owner approved on the from-PO picker: the three
cases (read failed / rows loaded but hidden / server returned nothing) are told
apart, and only the middle one says anything about work. Two behavioural fixes
came with it. `NotificationBell` was the one of three `useNotifications`
consumers that never consulted `loadFailed`, so a failed poll rendered "Nothing
new. You're caught up." — the hook's own contract says consumers MUST consult
it. And `acHeadline` ignored `counts_complete`, which the outbox route sets to
`false` when its count scan gives up: the green "Everything is in AutoCount" was
printing beside a banner saying the numbers were incomplete.

**The gate, because the comment had already failed twice.**
`backend/scripts/check-empty-state-claims.mjs`, wired as
`audit:empty-state-claims` in the REQUIRED `backend-typecheck` context. It is
honest about what it is: a regex cannot read meaning, so it is a REVIEWED
ALLOWLIST over eleven claim SHAPES. Every claim-shaped string in the tree is
either rewritten or listed in `scripts/data/empty-state-claim-allowlist.json`
with a one-line reason, and a NEW one fails the build until somebody decides
about it. Silence becomes a decision. Keyed by (file, line text) rather than by
line number so a merge keeps the review and an EDIT re-opens it; stale entries
print and never fail, because a gate that punishes the fix stops fixes. A string
that states the claim in order to DENY it is reported separately and allowed —
that is what the owner-approved wording does.

**Proven not vacuous, and re-proven on every run.** Planted
`"No outstanding lines — every line has been fully received."` and watched
`npm run audit:empty-state-claims` exit 1 naming the file and the string;
removed it and watched it exit 0. `tests/emptyStateClaimGate.test.ts` repeats
that in CI by planting into a temp directory OUTSIDE the source tree, so the
gate re-proves itself without a bad string ever entering `frontend/src`. It also
pins the step's presence in `ci.yml` and `package.json` — a check that cannot
run reports nothing and reads as a pass, which this repo has now produced three
times.

**Then the gate earned itself, twice, inside one merge.** #2372 landed while
this branch was open and the gate went red on eleven new claim-shaped strings —
so each was read. Nine were the LEGITIMATE shape and are now recorded as such: a
claim tied to a NAMED document whose lines the server COUNTED
(`verifiedComplete` = `candidateLines > 0 && outstandingLines === 0`) is
evidence, not inference, and `outstandingEmptyReason.ts` is the worked example
the allowlist now points at. Two were not. #2372 gave the mobile wizard's GRN
arm a counted per-document reason and left the SI / PO / DO arm of the SAME
component saying "Nothing left to {noun} on this document" — the N-1 shape
reproduced inside the fix for it, caught by a gate that had existed for an hour.
Its backend twins (`grns.ts`, `purchase-invoices.ts`) were the last two claims
whose five siblings this branch had already reworded, and they are reworded now
too. Nothing is deferred.

**Two defects in the gate itself, found by watching it rather than trusting it.**
`console.log` to a pipe plus `process.exit()` truncated its own report at 9,146
bytes under capture — a correct exit code beside a list that stopped
mid-sentence, and CI captures. And the comment stripper read the apostrophe in
JSX text (`<Muted>Couldn't load…</Muted>`) as the start of a string literal,
desynchronising everything after it. That one was measured rather than assumed:
the old and new hit sets were diffed, and the bug had added two false positives
and hidden nothing. Both are pinned by the self-test, which refuses to report a
number at all when it fails.
