## The GRN picker's empty state claimed completion again, one merge after it was removed [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Two parallel fixes for the same owner report (2026-08-17, the
unreceived PO showing zero outstanding lines) landed within hours of each other.
PR #2367 removed the sentence *"every line has been received"* from
`GrnFromPo.tsx` and replaced it with copy that explicitly denies the completion
reading. The other fix — this branch — moved the whole empty state into
`frontend/src/lib/outstandingEmptyReason.ts`, and its unscoped branch said *"No
Purchase Order lines are awaiting receipt in this company right now — every
SUBMITTED and PARTIALLY_RECEIVED order has been received in full."* Same claim,
different words, in the file whose header forbids it.

**Root cause.** The module's own property test banned a LITERAL, not the claim:
`expect(...).not.toContain('every line has been received')`. The replacement
phrasing passes that assertion while asserting the same fact. And the fact is not
knowable from an empty read: `scopeToCompany` FAILS CLOSED — when the company
context resolves but no single active company can be picked it appends
`.in('company_id', [])`, and PostgREST answers `[]` with `error: null`. A
companies-master blip is byte-identical on the wire to a company with nothing
outstanding, so during one the operator would be told every order is received
while unreceived orders sit in his own company's books.

**Two more empty-state defects found in the same pass.** A **RECEIVED** purchase
order was told *"Submit the order first, or reopen it"* — the picker's SQL filter
now excludes only DRAFT and CANCELLED, so a closed order genuinely reaches the
screen, and reopening a finished order invites a second receipt against lines
already received in full. And a scoped, fully-received PO viewed with a stale
toolbar filter escaped every scoped branch and fell through to the unscoped one,
so a one-PO read made a statement about the whole company.

**Fix.** The unscoped branch carries #2367's wording. Completion is decided on
EVIDENCE the server took — `candidateLines > 0 && outstandingLines === 0`, i.e.
the read COUNTED this document's lines and found none outstanding — rather than on
a status name the frontend would have to keep its own list of; a closed order at
zero is reported FINISHED and one that still counts outstanding lines keeps the
reopen advice. The `!filtersActive` guard is gone from the completion branch (the
read is scoped, so `serverRowCount === 0` already proves no filter hid anything)
and a scoped fallback names the document instead of falling through. New input
`scopedRowCount`, because the screen's own PO scope / append lock is its own
cause: rows it dropped were being reported as rows the operator's unsaved DRAFT
had already taken, which sends them to the wrong screen. The property test now
bans the CLAIM in every phrasing the module can produce, and asserts that every
completion sentence names the document it is about. The mobile convert wizard uses
the shared module too — it had the identical hard-coded claim, *"Nothing left to
receive on the selected order(s)"*, and the module's header already said both
surfaces shared it.

**Ref** — collides with #2367. Also in this merge: #2367 landed the truncation fix
as `lib/outstanding-po-items.ts` while this branch landed it as
`lib/outstanding-po-lines.ts`. Keeping both would have left the module whose header
says *"three properties this must keep"* with zero callers, its tests passing about
code the endpoint no longer runs. `-items` was deleted and its three assertions
carried into `outstanding-po-lines.test.ts` as BEHAVIOURAL tests of
`loadOutstandingPoLines` against a recording PostgREST stand-in — no `.limit()`
anywhere in the chain, the status filter through the `!inner` embed, `order('id')`
as a total order, every page read, the company predicate failing closed, a read
error surfacing instead of an empty list. Reintroducing `.limit(500)` fails 3 of
them.
