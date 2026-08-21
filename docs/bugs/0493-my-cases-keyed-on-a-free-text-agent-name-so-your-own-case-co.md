## My Cases keyed on a free-text agent name, so your own case could be missing from it [high]

<!-- area: Service cases (ASSR) -->

**Symptom.** A person raises a service case and it does not appear in their My
Cases. Owner, 2026-08-21: 「如果是他开的 就算不是他as agent它也可以看啊 … 那就是他
submit就代表他认领这个case了啊」 — if he opened it, he can see it, agent field or
not; submitting is claiming.

**Root cause (traced).** `GET /api/assr/my-cases` (`routes/assr.ts`, before this
change) built its whole WHERE from
`LOWER(COALESCE(sales_agent,'')) LIKE '%<subtree display name>%'` and nothing
else. `sales_agent` is free text mirrored from AutoCount (mig 010), so a rename,
a stray space or a different spelling silently dropped a person's own case out of
their list — and a case raised on an order whose AutoCount agent is someone else
never appeared at all. This is the SAME free-text mechanism behind the 2026-08-20
visibility incident; the ACCESS gate was moved onto ids then
(`assrVisibilityPredicateSql`), this list was explicitly left alone.

Measured before changing it — census run **32463589829**, production, §6 of
`backend/scripts/census-service-case-visibility.mjs`: of 862 non-archived cases,
**824 were raised by someone the agent text does not name**.

**Fix.** `myCasesPredicateSql` (`services/assrVisibility.ts`) ORs a creator arm —
`created_by IN (subtree ids)`, self + full downline BY ID, so the pyramid rule
stands and nothing depends on spelling — onto the existing name arm. The name arm
is **kept**, because the same census found 1,113 user→case pairs across 28 users
reachable ONLY by the agent text (office raising a case on a rep's behalf):
union, never replace.

`backend/tests/assrMyCasesByCreator.test.ts` pins both halves against a real D1.
PROVED RED on the unfixed rule first — with the creator arm disabled, 6 of 11
failed, including *"a case the caller RAISED is theirs even when sales_agent
names someone else"* (`expected [] to deeply equal [ 1 ]`) and *"the pyramid rule
stands"* (`expected [] to deeply equal [ 3 ]`); the 5 that passed are the
name-arm tests, which is the point — they pin what must NOT be lost. All 11 green
after.

**Ref.** feat/my-cases-by-creator, 2026-08-21.
