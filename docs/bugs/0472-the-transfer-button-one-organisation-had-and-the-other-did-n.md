## The transfer button one organisation had and the other did not [high]

<!-- area: Delivery, DO, returns -->

**The owner.** *"你统一掉整个 Transfer DO to Sales Invoice 的那一个，为什么两间公司
看到的东西却是不一样的？"* Same build, same permissions, same screen — and one
company could raise a Sales Invoice from a delivery and the other could not.

**It was never a company branch.** A repo-wide sweep for `company_id === <n>`,
`companyCode === '…'`, `isHouzs`, `is2990` returns 27 lines in 11 files, and
every one is branding, a print entity, a per-company default layout, or a
`typeof` coercion. Nothing on this chain.

**Two hand-typed status lists.** The system has ONE declaration of "this
delivery has shipped and is billable" —
`DO_SHIPPED_STATES = ['DISPATCHED','IN_TRANSIT','SIGNED','DELIVERED','INVOICED']`
(`backend/src/scm/shared/do-shipped-states.ts`), whose first transition writes
the inventory OUT. Both desktop entry points gated the transfer on
`["signed","delivered"]` instead:

- `DeliveryOrderDetailV2.tsx` — `canConvertToSi = rawStatus === "signed" || rawStatus === "delivered"`,
  **sixteen lines above** a `locked=` prop that spelled the correct five states
  out to stop a shipped delivery's lines being edited. One file knew a
  DISPATCHED delivery had shipped and refused to offer its transfer.
- `MfgDeliveryOrdersListV2.tsx` — an `if / else-if` chain, so a DISPATCHED
  delivery matched the `Mark signed` arm and **returned**. The transfer was not
  disabled there; it was never rendered, and the slot it would have taken showed
  `Mark signed`.

Everything else on the chain was already right: the server picker
(`resolveCandidateDoIds`, everything except `CANCELLED`/`DRAFT`) and the mobile
convert wizard both offered those same deliveries. So the operation was never
blocked — it completed from the Sales Invoice side or from a phone, which is
what made it read as a phantom rather than a refusal.

**Why it landed on one organisation.** DATA, not code. 2990's source system had
no "delivered" step on delivery orders, so its imported deliveries sit at
DISPATCHED; the AutoCount carry-overs on the HOUZS side were inserted with the
literal `'DELIVERED'` (`create-migrated-documents.mjs`). Same predicate, two
status histograms. **Identical code is not identical behaviour when the data
behind it differs** — that is the whole lesson, and it is why the fix is the
shared constant rather than a data repair. Flipping the statuses was already
tried: `backfill-2990-delivered-dos.mjs` did it for some of them and the button
stayed missing on the rest.

**Fix.** `do-shipped-states.ts` gets a byte-identical frontend twin at
`frontend/src/vendor/shared/`, held there by
`do-shipped-states.canonical.test.ts` (the repo's existing mirror-plus-pin
pattern, the same one `total-height.canonical.test.ts` uses). This sentence
originally credited `check-shared-mirrors.mjs --strict`, and that was wrong —
see "A mirror pin that was refereeing a different pair" below. Both surfaces import it; the
detail page's `locked=` prop now uses the same expression it gates the button
on, so the two cannot disagree again. The list drawer renders `Mark signed`
(secondary, pre-signed states) and the transfer (primary, shipped states)
independently — `docs/modules/document-conversion.md` had stated that rule since
the vocabulary PR and the drawer was the copy that never got it.

### Three more asymmetries fixed in the same pass

- **The AutoCount Sync page told 2990 a false sentence.**
  `scm.autocount_writeback` is a company ALLOW-LIST and all eight enqueue gates
  read it as `isWritebackEnabled(sb, companyId)`. Exactly one caller —
  `routes/autocount-outbox.ts`, the page's status banner — read it bare and
  published `on: scope !== 'off'`, i.e. *is it on for anybody*. With the switch
  set to one company, the other organisation's operator was told sending was
  switched on **for his company** and that saving a document would queue it.
  His queue is company-scoped, so it stays empty and nothing errors: a false
  statement with no symptom attached. `on` is now answered per company, `scope`
  still reports the whole allow-list, and an unresolved company answers `null`
  rather than guessing "off". The sibling flag built on the same parser
  (`write-freeze-status.ts`) never had the bug — it prints "company 1, 3", never
  "this company".

- **A 409 the operator could not read.** A migrated document must be invoiced by
  the converter, not by hand; `migrated-chain.ts` writes a careful sentence
  saying so. It is **205 characters** and `authed-fetch.ts` keeps a server
  message only when `r.length < 200`, with no curated `ERROR_CODE_MESSAGES`
  entry and no `describeRefusal` shape — all three doors shut, so it fell to the
  generic *"That clashes with something already in the system. Please refresh
  and check."* Refreshing changes nothing: the document is migrated and will be
  refused every time, so the advice was a loop. The code is now curated, which
  is the house rule `companyScope.ts` already states. This can only ever fire
  for the organisation that has migrated documents, so a company-neutral refusal
  was in practice one organisation's experience.

- **The 2990 bulk importer would have imported the wrong Processing Date.**
  Migration 0286 renamed this side's `internal_expected_dd` to
  `processing_date`. The 2990 source is a separate repo on its own deploy
  schedule and carries BOTH names — its LIVE column is `internal_expected_dd`
  and its `processing_date` is the dead twin migration 0189 dropped here.
  `migrate-2990-into-houzs.mjs` matches columns BY NAME, so it would have filled
  the live Processing Date from the source's dead column and dropped the real
  one into the `[drop:…]` list, where it reads as an ordinary unmapped field.
  Not cosmetic: the Processing Date gates Proceed, the allocator and MRP, and a
  wrong one is worse than a missing one because nothing downstream can tell. The
  live SO mirror already had this alias; the bulk path never did — the same rule
  at N call sites, present at N-1. `RENAME_COLS` is now **derived from**
  `lib/so-processing-date.mjs` rather than hand-typed, because
  `soProcessingDateOneName.test.mjs` forbids typing the retired name in a script
  and it is right to: eleven scripts once did, every query answered 42703, and
  because 42703 fails the whole statement those audits returned nothing and read
  as clean.

Two more were corrected in place without a behaviour change:
`consignmentWarehouseId` resolved the hidden Consignment (Out) warehouse with no
company predicate and a discarded `error`, so three failure modes — global
singleton, wrong company's warehouse, and `.maybeSingle()` erroring on two rows
— all rendered as one `null` whose documented handling is to skip the stock
transfer silently. It now takes a required `companyId`, the same medicine
`defaultWarehouseId` took on 2026-08-03. And `warehouse-mirror.ts` justified
forcing `is_default = false` by quoting a company-BLIND reader that was fixed on
that same date; the justification is now marked expired, with the measurement
the removal needs named rather than the force silently removed.

**The gate.** `check-company-divergence.mjs --strict` (new, in the required
`backend-typecheck` job): a reviewed allowlist over every line that NAMES a
company — 78 today, each with a reason **and whose decision it was**, because
the owner's test for a legitimate per-company difference is whether he set it.
"Historical" and "legacy" are not people, and the test rejects them. It catches
shapes the literal grep misses: a rule expressed against `BASE_COMPANY_CODE`,
or scoped by doc-number PREFIX, which is how the SO-PO edit lock is confined to
one organisation without naming it. Proven non-vacuous both by hand and in CI
(`companyDivergenceGate.test.ts` plants a branch, asserts exit 1, removes it,
asserts exit 0 — twice, once in the shape the grep missed).

**Stated in the gate's own header, and worth repeating here: it would NOT have
caught this bug.** The predicate that broke had no company term in it. What
catches that class is one declaration per concept, mirrored and pinned — and a
gate that let its own limits go unsaid would be the same failure in a new
costume.
