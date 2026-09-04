## The accounting masters fell back to company 1 in silence [high]

<!-- area: Accounting + GL -->

**Symptom.** Nothing on screen. That is the point of the entry: a journal entry
whose company could not be resolved was validated against **company 1's** chart
of accounts, took **company 1's** role codes and **company 1's** acquirer
mapping, and was then written with **no company at all** — and it looked
identical to an entry validated against its own books. Found while auditing what
makes the two companies behave differently (owner, 2026-09-02: 「明明同样一套系统，
为什么不同 company 出来的东西却是不一样的」).

**Root cause (traced).** One decision, written three times, all three silent:

```
engine.ts:94    checkAccounts   companyId == null ? 1 : Number(companyId)
rules.ts:93     resolveRoles    the same expression, inline in the filter
payments.ts:51  transitFor      the same expression again
```

On top of the duplication, `engine.ts` uses `companyId == null` to mean **two
different things inside one call**. The WRITE path reads it as "stamp no
company" — `:208` `companyId != null ? { company_id: companyId } : {}` — while
the LOOKUP path read the same null as "company 1". So the validation and the row
it validated disagreed about which company the entry belonged to, by
construction.

This contradicts the repo's own stated rule for a write. `requireActiveCompanyId`
(`scm/lib/companyScope.ts:114`) is documented as *"Never degrades, never
defaults"*, and `scopeToCompanyIdOrOpen` (`:136`) states plainly that *"Null
means UNRESOLVED"*. Posting a journal entry is unambiguously a write.

**Null is REACHABLE, and not only from a degraded request.** Three call sites
pass the DOCUMENT's own nullable `company_id`, not the request's active company:
`scm/routes/accounting.ts:295` (`jeCompanyId ?? null`),
`scm/routes/payment-vouchers.ts:694` and `:1409` (`head.company_id ?? null`).
Every sibling in the module — `bank.ts`, `daily-close.ts`, `settlement.ts` —
already types `companyId: number`, non-nullable. The three nullable ones are the
outliers.

**Fix.** `acc/masters-company.ts` is now the one place that decides which
company's accounting masters a posting reads, and the three ternaries call it.
Behaviour is preserved EXACTLY — the fallback is still company 1 — but every
substitution now logs at error level and names the call site, so an entry
validated against another company's chart no longer looks like one validated
against its own.

**Deliberately NOT changed, and this is the owner's decision, not an oversight.**
Refusing (the house rule) would stop any document with a null `company_id` from
posting. Whether such documents exist in production, and how many, is a question
about data that no amount of reading settles.

> **Owner decision owed.** Run **Report money check (read-only)** or a one-SELECT
> probe for `journal_entries` / source documents carrying `company_id IS NULL`,
> then choose:
>
> 1. **Refuse** — `accMastersCompanyId` throws instead of substituting. Matches
>    the house rule. Cost: those documents stop posting until their company is
>    stamped.
> 2. **Backfill then refuse** — stamp the missing `company_id` from each
>    document's own parent, then flip to (1). More work, no lost postings.
> 3. **Keep the fallback, now that it is loud** — acceptable only if the probe
>    returns zero, in which case the branch is dead code and (1) is free.
>
> Recommended: run the probe first; if it returns zero, take (1) immediately.

**Ref.** `fix/system-self-contradiction`, 2026-09-02.
