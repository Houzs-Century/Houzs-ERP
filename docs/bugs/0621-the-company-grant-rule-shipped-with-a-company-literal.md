## The company-grant rule shipped with a company literal [high]

<!-- area: Service cases (ASSR) -->

**Symptom — and it is a LATENT one, stated carefully.** The door to Service Cases
admits on holding *the Houzs Century* company grant, so a colleague granted only
2990 is refused by that term. **Nobody is locked out today**, and that is
measured, not assumed: `docs/modules/service-case.md` records census run
32351722894 (2026-08-20, production) — six Sales-titled active users hold no
HOUZS grant, and *"None of them loses access today, because each is admitted by
the permission or director term as well."*

So this is PREVENTION of a gap the guide had already written down, in the same
paragraph, as the thing that breaks next:

> *"a FUTURE 2990-only rep with neither would be refused by this gate. If 2990
> grows its own sales team, this term needs a second company, or it needs to
> become **'holds any granted company'**."*

That last clause is exactly the fix below. And 2990 is not a hypothetical tenant:
the 2026-08-21 census counted 862 non-archived cases, **HOUZS 854 / 2990 8**.

**Root cause (traced).** `canAccessServiceCases` (`routes/assr.ts:122`) admitted
on `holdsHouzsCompanyGrant(c)` — a test for one specific company — where the rule
it implements is about holding *a* company grant.

`#2538` (2026-08-20) was correct in substance: it replaced `isSalesUser(user)`, a
`/^sales/i` test over a free-text job title, with a company grant, because a
batch of Sales Agents had lost every case at once and a title is free text nobody
re-checks. The owner's words in `docs/SERVICE-CASE-VISIBILITY-DECISION.md`:

> 「我们不 control Agent，可是我们 control Company」
> 「有 Houzs 这家公司的授权 就好（**不看职称**）」

**The load-bearing half is the parenthesis.** The ruling took the TITLE out of
the decision. It was written while HOUZS agents were the ones losing access, so
it named HOUZS, and the literal travelled into the code with it.

That literal contradicts the rule already recorded in the same file's decision
trail from **2026-07-20**:

> Service Cases now follow the caller's GRANTED companies like the rest of the
> SCM portal — no ASSR-specific role pin. A rank-and-file rep sees ONLY their own
> company (a HOUZS rep's grant is {HOUZS}; **a future 2990 rep's is {2990}**).

**The census named the stranded cohort in advance, in the very PR that stranded
it.** `census-service-case-visibility.mjs` §1 shipped carrying:

> `Sales-titled active users WITHOUT the HOUZS grant = N` *(the 2990-only cohort
> the literal rule would strand)*

It was measured, printed, and the literal shipped anyway.

**How this was nearly mis-filed, which is the part worth keeping.** On the first
pass it was reported to the owner as an unresolvable contradiction — the decision
trail said admit, and `assrVisibilityRule.test.ts` had a green test titled *"a
Sales TITLE alone no longer admits — this is the input the owner ruled out"*
asserting `ctx([2])` (granted only 2990) → `false`. Two things disagreeing, so it
was left alone.

**That reading was wrong, and it was wrong because the test conflated two
inputs.** Its user had a Sales title AND only the 2990 grant, so it proved "the
title does not admit" and "2990 does not admit" with one assertion, and only the
first was the ruling. Reading the decision document — which was never opened on
that pass — settles it in a paragraph. *A test whose fixture varies two things
cannot be cited for either.*

**Fix.** `holdsAnyCompanyGrant(c)` — same three-state sentinel, so `undefined`
(unresolved / pre-migration / cold start) still degrades to YES and cannot 403
everyone on a blip, and `[]` (granted nothing) is still NO.
`holdsHouzsCompanyGrant` STAYS: the AutoCount mirror arm (`:~1270`) still needs
the HOUZS-specific question, because `sales_orders` holds only HOUZS rows and a
2990 caller correctly gets nothing from it.

**Admitting is not showing, and that is why the door can widen safely.** Every
read is already scoped by `assrCompanySql` → `allowedCompaniesSql`, so a 2990
grantee sees 2990's cases and nothing else. Unchanged: row visibility, the
subtree, `assrUnrestricted` (which the decision requires must not narrow —
「要不然 office 的帮不到 sales 处理东西了」), My Cases, and every
write/manage/approve/delete gate, which keep their own `requirePermission`.

**Tests.** `assrVisibilityRule.test.ts`:
- the Sales-title case now uses `ctx([])` — granted NOTHING — so it isolates the
  title instead of proving two things at once;
- a new case pins that a 2990 grantee IS admitted;
- a new case pins ADMITTING IS NOT SHOWING, by asserting the scoping SQL the same
  context produces.

Proved RED by putting `holdsHouzsCompanyGrant` back: the 2990 case fails, the
other 22 pass — which is the measurement showing the old suite could not have
caught it.

**The measurement the decision document demands is one dispatch away.** It says
*"Measure who gains access… this repo does not ship access changes on reasoning
alone."* §1 of the census now compares the SHIPPED gate against this one (it had
been comparing against the long-retired `isSalesUser`) and prints every affected
user by name. **UNRUN — I have no production access.** Run **Census: service case
visibility (read-only)** and put the number on the PR before merging.

**The FRONTEND term did NOT follow, and that gap is pre-existing.**
`PageGuard`'s `allowSales` resolves `capability(user, "org.sales.staff")` =
`pmsAccess.isSalesUser` — still the job title — so the browser gate and the API
gate have admitted on different classifiers since 2026-08-20.
`docs/modules/service-case.md:823` already records that as open. It is NOT
widened here and it does not blunt this fix for the cohort the guide named: those
six are Sales-TITLED, so `allowSales` lets them through the browser and the API
now agrees. What stays open is a 2990-only caller with neither the title nor the
page grant. Closing it properly means making the capability context-aware —
`canAccessServiceCases` needs the request's company grants and the capability map
takes only the user — which is a change to `resolveCapabilities`'s signature and
belongs in its own PR.

**Ref.** `fix/assr-2990-access`, 2026-09-03.
