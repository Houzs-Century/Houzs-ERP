## A 2990 scan minted a Houzs Century document number [high]

<!-- area: Sales orders + pricing -->

**Symptom.** A sales order created by photo-scanning a slip while working in
2990 is minted `HC-SO-YYMM-NNN` — Houzs Century's prefix — while carrying
`company_id = 2`. Permanent: a document number cannot be renamed once it exists
(`companyScope.ts:535`, and the batch → lot → COGS trail hangs off it).

Found while auditing what makes the two companies behave differently (owner,
2026-09-02: 「明明同样一套系统，为什么不同 company 出来的东西却是不一样的」).

**Root cause (traced).** `companyDocPrefix` (`scm/lib/companyScope.ts:548`)
degrades to the BASE company when the context carries no `companyCode`:

```ts
if (typeof code !== "string" || !code) return docPrefixForCode(BASE_COMPANY_CODE);
```

That branch was written when HOUZS minted **bare** numbers, so degrading was
invisible — it produced the same string as having no prefix at all. Since
2026-08-07 HOUZS mints `HC-`, and the branch became a *claim*: this document
belongs to Houzs Century.

The headless scan job hits that branch on **every** run. `createDraftSalesOrder`
(`scm/routes/mfg-sales-orders.ts:5644`) rebuilds its context from the
`scan_jobs` row, which captured the company **id** and not the code, and
returned `undefined` for the code deliberately — under a comment promising
*"companyDocPrefix fall back to bare HOUZS numbering honestly"*. **That comment
stopped being true on 2026-08-07 and was never revisited**, so the fallback
silently changed meaning underneath it.

The company was known the whole time. Nothing needed to be guessed.

**Not the only path, and the others are recorded rather than fixed here.** The
procurement agent (`mfg-purchase-orders.ts:2535` ← `procurement-execute.ts:169`)
validates id and code separately so the code can degrade to null, and
`middleware/companyContext.ts:311` sets `companyId` without `companyCode` when
the companies master is briefly unreadable. Both reach the same branch. They are
listed here because the next reader must not conclude the class is closed.

**Fix.** `companyCodeById` (`scm/lib/doc-no.ts`) resolves the code from the id
against `public.companies`, extracted from `jePrefixForCompany`, which already
did exactly this read — including the `.schema('public')` that five days of an
unwritten general ledger paid for (`0511`). `createDraftSalesOrder` resolves the
code once and hands it to the synthetic context, so any future caller of that
factored create is covered without remembering to.

It **fails closed** on an unreadable master, deliberately: a refused scan job is
retried, a permanently mis-numbered sales order is not.

The stale comment is replaced with one that states the live behaviour and why
`undefined` still survives for a legacy row that captured no company at all.

**Tests.** `scm/lib/companyCodeById.test.ts` — the public schema is named, each
company resolves to its own code, a null id short-circuits without a read, an
unknown id resolves to null rather than to the base company, an unreadable
master throws, and the outcome stated as the outcome: a resolved 2990 code mints
`2990-` where the missing-code branch minted `HC-`.

**What this does NOT establish.** Whether any mis-numbered document exists in
production. `check-doc-no-prefix.mjs` measured **zero** company-2 rows missing
their prefix on 2026-08-21 (run 32504616506) — but that was 12 days ago, the
workflow is manual-dispatch only, and it reads doc-number COLUMNS, so it would
see this. Re-dispatch **Doc number prefix check (read-only)** to find out whether
this is prevention or also cleanup.

**Ref.** `fix/system-self-contradiction`, 2026-09-02.
