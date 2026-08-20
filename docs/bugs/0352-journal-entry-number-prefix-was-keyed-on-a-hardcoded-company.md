## Journal-entry number prefix was keyed on a hardcoded company id, so it could land under the wrong company in some environments [medium]

<!-- area: Accounting + GL -->

**Symptom.** `jePrefixForCompany` (backend/src/scm/lib/doc-no.ts) — the one
minter for every JE number's company prefix — decided the prefix with
`companyId == null || Number(companyId) === 1 ? '' : '2990-'`. This was the only
place in the codebase that keyed company behaviour on a hardcoded numeric id and
a literal `'2990-'`. Everywhere else resolves the company from `companies.code`
ON PURPOSE, because (companyScope.ts) the `companies.id` bigint differs across
staging and prod.

**Root cause.** Keying on the id, not the code. Two failure modes, both latent:
(a) in any environment where 2990 is not id 2, a HOUZS document's JE would be
minted with `2990-` or a 2990 document's with `''`, landing accounting vouchers
under the wrong company's running number; (b) a future THIRD company would fall
into the `'2990-'` else-branch and mint into 2990's sequence. Not yet observed
in prod (today HOUZS is id 1 / 2990 is id 2), so this was a latent trap, not a
live corruption — labelled [medium] accordingly.

**Fix.** Resolve the prefix from the company CODE, via the same
`docPrefixForCode` resolver the SO/PO minters use. New pure helper
`jePrefixForCode(code)`: HOUZS → `''` (its JEs are historically BARE —
`JE-2607-0001` — deliberately unlike its `HC-` SO/PO doc numbers, so this is
preserved BYTE-IDENTICAL and not renamed), 2990 → `'2990-'`, a third company →
`'<CODE>-'`. `jePrefixForCompany(sb, companyId)` is now async: it reads the code
from the companies master by id and calls `jePrefixForCode`; an unresolved
company degrades to base bare `''`, matching companyDocPrefix's base fallback.
The two callers (acc/engine.ts postJournal + reverseJournal) now `await` it.
What stays identical: every HOUZS JE (`JE-YYMM-NNNN`) and every 2990 JE
(`2990-JE-YYMM-NNNN`) in the CURRENT prod id layout. Unit test
`scm/lib/doc-no.test.ts` pins both — resolves from code, and asserts HOUZS/2990
output under a deliberately non-prod id layout (HOUZS=7, 2990=3).

**Ref.** PR fix/je-prefix-company-code, 2026-08-18.
