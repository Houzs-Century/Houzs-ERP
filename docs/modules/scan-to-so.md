# Module: Scan to Sales Order (OCR)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Per-module technical doc — a phone photo of a handwritten showroom slip becomes
a DRAFT Sales Order, and the operator's corrections train the next scan. Same
structure as [`sales-order.md`](./sales-order.md).

> Verified against `main` @ `8f8427ed`, then updated for
> `feat/ocr-relearn-from-corrections` (2026-07-22), which reconnected the
> correction feed in §4. Where `docs/ocr-self-evolution.md` describes something
> that is not in the tree, §5 says so explicitly — that document mixes shipped
> and unshipped.

> Convention: the module lives in the **`scm` Postgres schema**
> (`scm.so_scan_samples`, `scm.so_scan_rules`, `scm.scan_jobs`) and is reached
> under `/api/scm/scan-so/*`. The one exception is the completion notice, which
> is written to `public.announcements`.

---

## 1. Frontend

### Screens

| Surface | File | Notes |
|---|---|---|
| Desktop "Scan Order" modal | `frontend/src/vendor/scm/components/ScanOrderModal.tsx` (833 lines) | multi-order batch: N slips in one session, one `/enqueue` per order |
| Mobile Scan screen | `frontend/src/mobile/MobileScan.tsx` (1,278 lines) | the primary surface — the rep photographs the slip in the showroom |
| Shared job helper | `frontend/src/vendor/scm/lib/scan-jobs.ts` | the `ScanJob` shape, the camel/snake dual-read normaliser, the time predicates |
| Shared prefill reconciler | `frontend/src/vendor/scm/lib/scan-prefill.ts` (297 lines) | `reconcileScanPrefill()` — pure function, no hooks, no fetch |
| Job cards on the SO list | `frontend/src/mobile/MobileSalesOrders.tsx` | re-exports through `MobileScan` |

Both shells now take the **same** path: `POST /scan-so/enqueue` per order, then
poll `GET /scan-so/jobs` through `scan-jobs.ts`
(`ScanOrderModal.tsx:53-58`, `MobileScan.tsx:65-71`). The desktop modal used to
run a blocking `POST /scan-so/extract` for a single order and no longer calls
`/extract` itself (`ScanOrderModal.tsx:174`). Mobile keeps `/extract` only as a
fallback for when `/enqueue` 404s on an older deploy (`MobileScan.tsx:72`,
`submitLegacy` `:801-811`).

The shared layer is a plain module, **not a React hook**:
`vendor/scm/lib/scan-jobs.ts` exports the `ScanJob` type, `normalizeJobs`,
`jobTs`, `isTodayTs`, `hhmm` and `isActiveJob`. Its header says it exists so the
desktop modal reuses mobile's code path rather than keeping a third copy
(`scan-jobs.ts:1-12`).

Where the two surfaces still differ (all deliberate):

| | Desktop modal | Mobile Scan |
|---|---|---|
| Poll predicate | this session's enqueued ids (`:323-328`) | any listed job active (`:536-537`) |
| Visible jobs | everything enqueued this session | **today only**, and `done` rows are hidden — active + `error` only (`:167`, `:541-553`) |
| Legacy `/extract` fallback | none | yes (`:707`, `:877`) |
| "Clear failed" button | none | yes (`:566`) |
| After the draft lands | a button that closes and navigates to `/scm/sales-orders` (`:807`) — no toast | a toast driven by job polling, with a localStorage ack set (`MobileSalesOrders.tsx:65-70`, `:270-340`) |

Both poll at **4,000 ms** while anything is unsettled and stop entirely when
everything settles.

### `scan-prefill.ts` is the file that made mobile OCR work

Its header (`scan-prefill.ts:1-30`) is the clearest statement of the desktop/mobile
trap in this module. The *extraction* was always shared (it is server-side), but
the **client-side mapping of the extract result into the New SO form had
drifted**: desktop reconciled the raw OCR values against the real catalog (venue
text to venue id, dropdown value snapping, SOFA `specialCodes`, a structured
bank/plan/One-Shot payment block) while mobile took the raw strings and its
consumer then re-guarded them against *stale hardcoded lists*. Same server, same
JSON, and "mobile OCR doesn't work". `reconcileScanPrefill()` is now the single
source of that mapping; value snapping is deliberately non-destructive
(`snapValue`) — a value the live catalog does not contain is kept as-is rather
than dropped.

### Loading behaviour

- `POST /scan-so/warm` is fired on modal open / screen mount
  (`ScanOrderModal.tsx:304`, `MobileScan.tsx:470`) so the cached catalog prompt
  prefix is warm before the operator finishes photographing.
- After enqueue the client holds nothing: the job row is the durable state. Both
  surfaces poll `GET /scan-so/jobs?salesperson=` (latest 20) and show today's
  jobs first (`MobileScan.tsx:135-140`, `ScanOrderModal.tsx:308-320`).
- The operator can close the app. That is the entire point of the background
  path — the pre-0067 flow had the phone awaiting `/extract` and then POSTing the
  DRAFT itself, so closing the app killed the order
  (`backend/src/db/migrations-pg/0067_scm_scan_jobs.sql:3-9`).
- Completion is delivered as a **private announcement** to the rep who scanned —
  see [`announcements.md`](./announcements.md) and §3 below.

---

## 2. API surface

Mounted at `backend/src/scm/index.ts:516-517`:

```
scm.use("/scan-so/*", scmAreaGuard("scm.sales.orders", { writeLevel: "view" }));
scm.route("/scan-so", scanSo);
```

plus `scanSo.use('*', supabaseAuth)` (`scan-so.ts:99`). Full public prefix is
`/api/scm/scan-so/*`.

| Method | Path | Line | Purpose |
|---|---|---|---|
| POST | `/enqueue` | `:4172` | multipart slip + receipt photos → durable job → `202 { job_id, status:"queued" }` |
| GET | `/jobs` | `:4610` | latest 20 jobs, optional `?salesperson=`; also runs the stale-job reaper |
| GET | `/jobs/:id` | `:4639` | poll one job; also runs the reaper |
| POST | `/jobs/clear-failed` | `:4677` | delete the caller's `status='error'` rows **in the active company** (`*` clears every rep's, same company) |
| POST | `/extract` | `:2967` | the blocking client-driven path — kept as mobile's fallback |
| POST | `/samples/:id/confirm` | `:4718` | store the operator-reviewed JSON; triggers the distillers |
| GET | `/salespeople` | `:2269` | distinct reps across samples + rules (the modal datalist) |
| GET | `/rules/:salesperson` | `:2302` | view a rep's distilled rules |
| POST | `/rules/:salesperson/distill` | `:2325` | manually regenerate a rep's rules |
| GET | `/slip-image` | `:2345` | stream a stored slip photo |
| POST | `/warm` | `:2376` | pre-warm the cached catalog prompt prefix |

Note `/rules/:salesperson` and `/rules/:salesperson/distill` carry **no check
beyond the area guard** (`:2302`, `:2325`): any admitted caller can read any
rep's distilled rules, and can trigger a **billed Anthropic distill** for any
rep, with no rate limit. `/slip-image` (`:2345`) guards only that the key starts
with `scan-slips/` (`:2347`) — knowing a sample id returns the customer's slip
photo.

The sibling `POST /api/scm/scan-payment/extract`
(`backend/src/scm/routes/scan-payment.ts`, mounted `scm/index.ts:526-527`)
reads a card-terminal / EPP receipt into a payment row. It is
**extraction-only — no samples, no learning** (`scm/index.ts:525`).

For the machine-generated route inventory see
[`docs/generated/route-capability-matrix.csv`](../generated/route-capability-matrix.csv).

---

## 2b. Three different dates, three different names (2026-08-13)

Until 2026-08-13 this module used the word **`processingDate` for three
unrelated facts**, which is how the wrong one kept getting picked. They are now
named for what they are, and nothing about which value flows where changed:

| Name | What it is | Where it lives | Where it goes |
|---|---|---|---|
| `ExtractedSlip.slipDate` | **the handwritten slip's own date** — the day the rep wrote the order | OCR output, `scan-so.ts` extraction rule 6 | the duplicate probe (same phone + same slip date + same total), and the payment planner's **fallback** date |
| `ExtractedPayment.receiptTxnDate` | **a card terminal's printed transaction date** — the swipe date on ONE printed receipt | OCR output, `scan-so.ts` `payments[]` | `planReceiptPayments` → `resolvePaidAt` → the payment-ledger row's **`paid_at`** |
| `processingDate` | **the Sales Order's Processing Date** — the factory-start date | `scm.mfg_sales_orders.processing_date` (named `internal_expected_dd` until mig 0286, 2026-08-13) | the SO itself; the operator keys it at review |

Only the third one is still called `processingDate`. If you are reading a date
off a slip photo or a receipt photo, it is **not** that field.

- The planner's precedence is `receiptTxnDate` → `slipDate` → today, each
  clamped by `resolvePaidAt` to `[today−60d, today+7d]`
  (`scan-receipt-plan.ts`). The SO's Processing Date is **not an input to the
  planner at all** — it does not appear in `PlanReceiptPaymentsInput`.
- The sibling `scan-payment` prompt calls its equivalent of `receiptTxnDate`
  **`paidAt`**, because that route emits the ledger value directly. Here the two
  must stay distinct: `ExtractedPayment.receiptTxnDate` is the raw OCR read,
  `PlannedReceiptPayment.paidAt` is the clamped value actually booked.
- **Back-compat:** stored `so_scan_samples.extracted` / `corrected` blobs written
  before the rename still carry the old `processingDate` key, and those blobs are
  fed back verbatim as few-shot examples — so the model can echo the old key.
  `normalizeSlip` reads `slipDate ?? processingDate` and
  `receiptTxnDate ?? processingDate` for exactly that reason. Do not remove those
  fallbacks until the sample pool has fully rolled over.

### Known mismatch, NOT fixed by the rename — latent, not live

The two surfaces seed the **SO's** Processing Date from different facts:

- **Mobile** — `MobileNewSO.tsx` seeds its `procDate` state from
  `scanPrefill.slipDate`, i.e. **the day the rep wrote the slip**, which is not
  a factory-start date at all.
- **Desktop** — `SalesOrderNew.tsx` derives it as **Delivery − 6 weeks**
  (`PROCESSING_LEAD_DAYS = 42`), floored at today, and never reads the slip's
  date. Its own comment already says "a scanned slip may carry a Delivery date
  but never a Processing date".

**Neither is reachable today**, which is why this is a write-up and not a fix:

- `MobileNewSO`'s `scanPrefill` prop is **never supplied** — the screen union in
  `MobileApp.tsx:83` declares it, but neither `setScreen({t:"new-so"})` call site
  passes it. The live mobile scan path is `createDraftFromPrefill`, which sends
  `processingDate: null` outright (`MobileNewSO.tsx:476`). Note the stale
  COMMENT twenty lines further down at `:730` still says `internalExpectedDd:
  null` — this bullet used to be written off that comment rather than off the
  code, which is how it outlived the rename.
- Desktop's `soScanPrefill` sessionStorage handoff has a **reader and no
  writer** — `ScanOrderModal` became a pure `/enqueue` surface (§4).

So the wrong-value seed is **latent**: it fires the moment someone re-wires
either handoff, which is exactly the kind of reconnection this module has done
before. Both paths also invert the SO's Processing Date back into the slip's
`slipDate` when building a `corrected` learning blob; that is inert because
`slipDate` is in `CARRIED_NOT_INVERTED` (§4), so the key never reaches a
distiller. The rename made all of this legible; it changed none of it.

---

## 3. Backend — the background pipeline

`backend/src/scm/routes/scan-so.ts` (4,815 lines). Model `claude-sonnet-4-6`
(`:101`), endpoint `https://api.anthropic.com/v1/messages` (`:102`), retried on
429/500/502/503/529 with backoff (`anthropicFetchWithRetry`, `:113-120`).
`ANTHROPIC_API_KEY` is **optional** on the Env — absent, `/extract` returns
`503 anthropic_key_missing` rather than breaking the Worker (`:64-67`).

### enqueue → job → DRAFT

1. **`POST /enqueue`** (`:4172`) parses the multipart upload, normalises the rep
   key, runs the duplicate probe, writes the photos to R2 under
   `scan-jobs/{jobId}/{n}`, inserts the `scm.scan_jobs` row, then dispatches.
2. **Dispatch** (`:4317-4344`) — the pipeline **is a Cloudflare Queue job**, not
   `waitUntil`:
   ```
   if (c.env.SCAN_QUEUE) { await c.env.SCAN_QUEUE.send({ jobId }); }
   else { c.executionCtx.waitUntil(runScanJob(...)); }
   ```
   The message carries only the job id; the consumer rebuilds everything from the
   row and the R2 photos. `waitUntil` remains only as a fallback for a runtime
   with `SCAN_QUEUE` unbound (older deploy, tests).
   > The long comment block at `scan-so.ts:3105-3140` still describes the
   > pipeline as running "inside ctx.waitUntil". That header is **stale** — read
   > `:4308-4344` and `backend/wrangler.toml:124-139` for what actually runs.
3. **Consumer** — `backend/src/index.ts:566-580`, queue `houzs-scan-ocr`, DLQ
   `houzs-scan-ocr-dlq`, `max_batch_size = 1`, `max_retries = 3`
   (`backend/wrangler.toml:131-139`). Success `ack()`, failure `retry()`. The move
   off `waitUntil` was a reliability fix: Cloudflare evicts the isolate on the
   60-110s real-slip OCR calls, which left jobs stuck `running` forever
   (`wrangler.toml:124-129`, `index.ts:560-565`).
4. **`runScanJob`** (`:3872`) calls the *same functions* `/extract` uses — not
   copies: `loadCatalog`, `buildCachedPrefix`, `loadPromptInjections`,
   `callClaudeSlipExtract`, `insertScanSample`, `storeScanImages`,
   `postProcessSlip` (`:3136-3139`).
5. **DRAFT create** goes through `createDraftSalesOrder` imported from
   `./mfg-sales-orders` (`scan-so.ts:80`) — the factored, pricing-critical create
   core, never reimplemented here. Each scanned receipt becomes a payments-ledger
   row through `recordSoPaymentRow`, the same factored insert+audit core the
   interactive payments route uses.
6. **Reaper** — `SCAN_JOB_STALE_MINUTES = 3` (`:4375`). A job stuck
   `queued`/`running` past 3 minutes is re-run once from its durable R2 photos
   (`retry_count` 0 → 1, migration 0070) and only errored after that single retry
   is spent. 3 rather than 10 because `/extract` carries a 110s abort, so past 3
   minutes the job is a deploy/isolate-killed zombie, not a slow-but-alive call
   (`:4370-4374`). The reaper rides the poll endpoints (`:4613`, `:4643`), so a
   client polling is what advances a stranded job; the claim is conditional so
   concurrent polls cannot double-run it.
7. **Notice** — `postScanNotice` (`:3568-3588`) delegates to
   `postPersonalNotice` (`backend/src/services/personalNotice.ts`) with
   `source:'scan'` and a 7-day expiry, targeting the single `houzs_user_id`
   captured at enqueue. Fail-soft: a notice insert must never fail the scan job.

### Address correction

Google Geocoding lives in this file, not in a maps module: `geocodeAddress`
(`:187`), gated on `GOOGLE_MAPS_API_KEY`. When it resolves, its state / city /
postcode are **preferred over** the model's parse, because the LLM mis-parses
Malaysian addresses; **postcode is the driver** (`:222`, and
`docs/ocr-payment-spec.md` §4). When the key is unset the model's parse is left
untouched. The geocoded state is seeded into `addressStateMatch` so the
never-invent validator can check it against the live locality list (`:2911-2916`).

### Duplicate handling — A blocks at upload, B only warns

Migration `0068_scan_dedup.sql` documents the two rules: **A (image)** — the same
photo SHA-256 as a sample from the last 30 days whose job already minted an SO;
**B (content)** — a non-cancelled SO with the same normalised phone AND (same
customer SO ref, or same slip date + same grand total). They are enforced
**differently**, and only B is warn-never-block:

- **A is a synchronous HARD REJECT in `POST /enqueue`** — `409 duplicate_slip`,
  nothing written and nothing queued (owner 2026-07-04, `scan-so.ts:4296-4318`).
  Fail-OPEN: if the lookup itself errors the upload queues normally. The client
  re-sends the identical upload with `force=1` after the operator confirms
  "create anyway", which skips the reject entirely (`:4269-4274`).
- **B stays a soft warning inside the job** — the DRAFT is still created and
  `scan_jobs.duplicate_of` is stamped with the original (`:4044-4045`). A genuine
  repeat order is legal.

The SO note is **never** prefixed with the warning. Owner standing rule
(`:4060-4065`): the note carries only the customer's handwritten remark, so the
duplicate signal rides `scan_jobs.duplicate_of` (the mobile Scan card's
"Duplicate of <doc>" pill) and the private scan announcement, whose body gets
`This looks like a possible duplicate of <doc_no>.` (`:4171`).

> The code carries **two owner rulings that point opposite ways** and does not
> reconcile them: `:4263-4265` quotes 2026-07-15 "this was already opened;
> whether to open again is the person's decision — don't be too strict" as
> WARN-not-BLOCK, directly above the 2026-07-04 hard reject it describes as
> policy. Shipped behaviour is unambiguous — reject unless `force=1`. Which
> ruling the owner intends to stand is an OWNER DECISION, not readable from the
> tree (UNVERIFIED as of 2026-08-13).

---

## 4. The learning loop — the part people get wrong

### One table, four statuses, two consumers that want opposite things

`scm.so_scan_samples.status` is free text (no CHECK constraint, so the vocabulary
needed no migration). The authoritative explanation is the block at
`scan-so.ts:1658-1682`:

| Status | Meaning |
|---|---|
| `EXTRACTED` | the AI read it; no human has reviewed it |
| `CONFIRMED` | the operator reviewed **and changed something** — `corrected` and `extracted` DIFFER, so the pair carries a teachable diff |
| `ACCEPTED` | the operator reviewed and took the extraction **as-is**. Ground truth, but **no diff** |
| `FAILED` | the extraction itself errored |

Note the vocabulary trap: the constant for "corrected" is
`SAMPLE_CORRECTED = 'CONFIRMED'` (`:1682`). The stored string says CONFIRMED; it
means *corrected*.

The split exists because the two consumers want opposite things:

- **The distillers MINE THE DIFF.** "Wherever they differ, the AI misread." A
  zero-diff pair teaches them nothing, and inside their `LIMIT` window it would
  push a real correction out of the pool. They read `status = CONFIRMED` only —
  `:1875`, `:1998`, `:2108`, `:2220`.
- **The few-shot pool shows the model GOOD OUTPUT.** There both outcomes are
  equally true, and corrected-only was a **biased sample of the AI's own
  failures**: while the edit-gate was the only writer, the pool could contain
  only slips the AI got wrong. **Status RANKS this pool, it does not filter it**
  (2026-08-05, `:2638-2648`): the only predicate is `corrected IS NOT NULL`, and
  status is used solely to sort `CONFIRMED` ahead of the rest (`goldFirst`,
  `:2657-2660`). It used to be gated on `status IN (CONFIRMED, ACCEPTED)`, and
  because `status` is free text with no CHECK constraint, any row whose status
  was missing, legacy or merely spelled differently was silently deleted from
  the model's memory — production had exactly that.

**So: a zero-diff confirm teaches the DISTILLERS nothing, but it does still
teach the few-shot pool.** That is the precise statement. The confirm handler
short-circuits explicitly rather than spending Anthropic calls to regenerate
identical rules from an unchanged pool (`:4770-4773`).

### "The diff" means three different things — none of them is a structural differ

There is **no TypeScript function anywhere that computes an
`extracted` ↔ `corrected` diff.** What exists is:

1. **A label-computing comparison, in the frontend.** `maybeLearnFromScan`
   (`SalesOrderNew.tsx:1216-1324`, mobile twin `MobileNewSO.tsx:1327-1395`) walks
   a fixed field list — customer name, address parts, `customerSoRef`, customer
   and building type, the four payment matches, line count, per-line `itemCode` —
   with `const mark = (a, b) => { if (a !== b) changed = true }` (`:1235-1236`),
   and sends `accepted: !changed` (`:1322`). The comment at `:1230-1234` is
   explicit that this is **no longer a gate — it is the sample's LABEL**.
2. **The rule-deriving diff, done by the model.** The pairs are serialised by
   `pairExamplesText` (`scan-so.ts:1776-1790`, each side truncated) and the
   meta-prompt instructs the model to derive the rules: *"DERIVE THE RULES FROM
   THE DIFFS: compare each 'AI extracted' JSON against its 'Operator corrected'
   JSON"* (`:1733`; alias version `:1949`, global-rules version `:2060`).
3. **A "was it edited at all" check, in the backend.** `scan-sample-review.ts:95-102`
   asks `mfg_so_audit_log` for any row whose action is not in
   `("CREATE","UPDATE_STATUS")`. This is a boolean, not a diff.

### How a correction is captured

Two paths *can* write a sample review. Only the second one runs today (see
"There is no live UI path…" below), and it writes **both** outcomes:

1. **Interactive** — the operator reviews inside the New SO form (desktop or
   mobile) and the form POSTs `/scan-so/samples/:id/confirm` on save
   (`:4718`). `accepted: true` in the body means "I changed nothing" → status
   `ACCEPTED`; absent/false → `CONFIRMED`. **No live caller.**
2. **Background** — nothing confirms the sample, because the operator's review is
   the DRAFT they open later. `backend/src/scm/lib/scan-sample-review.ts`
   (`noteScanDraftAccepted`) listens to the **DRAFT → CONFIRMED status
   transition** on the SO and records the operator's verdict:
   - confirmed **unchanged** → `EXTRACTED → ACCEPTED` with `corrected = extracted`;
   - confirmed **with edits** → `EXTRACTED → CONFIRMED` with `corrected` rebuilt
     from the final SO by `buildCorrectedSlipFromSo`.

   Before this module existed the main scan route fed the loop **nothing**; until
   the edited branch landed it fed the *distillers* nothing.

**The edited branch is an OVERLAY on `extracted`, not a reversal of the lossy
slip → SO mapper.** That distinction is the entire safety argument, and the
reason no new review screen was needed. It starts from the AI's own blob and
overwrites a curated set of faithfully-invertible fields, **and only where the
value genuinely moved** — comparing on trimmed text, on an OptionMatch's
`value`, on a code set, never by blind assignment. Re-stamping an unchanged
`skuMatch` with `reason:'operator-confirmed'` would make every line of every
sample "differ", and the distillers turn every difference into a rule.

Everything whose forward mapping is lossy, derived or overwritten downstream is
carried across untouched and contributes **no diff**. The list is in code as
`CARRIED_NOT_INVERTED`, each entry with its reason:

| Carried, never inverted | Because |
|---|---|
| `locationMatch` / `location` | the create core's venue-by-active-project autofill resolves a venue the slip never named |
| `remarks` | still carried, but the reason recorded beside it in code (`scan-sample-review.ts:88-89` — "the dedup path prefixes the note") is **stale**: the pipeline never writes into the SO note (§3). Whether `remarks` should now become invertible is an owner call, not readable from the tree |
| `processingDate` | a DRAFT never carries a Processing Date (owner 2026-08-08, 2990-SO-2608-007 — supersedes the 2026-07-04 pin-to-today rule): scan drafts land with BOTH dates null, and the operator keys the pair at review against the slip photo |
| `slipDate` (the SLIP'S OWN date — **not** the SO's Processing Date; see §2b) | the SO has no column for it, and the SO's Processing Date is a **different fact**. A DRAFT never carries a Processing Date at all (owner 2026-08-08, 2990-SO-2608-007 — supersedes the 2026-07-04 pin-to-today rule): scan drafts land with BOTH dates null, and the operator keys the pair at review against the slip photo. Inverting the SO's factory-start date back into `slipDate` would teach the model to read it off the slip's date line |

| `priceRmGuess` | the create core **reprices** every goods line — `unit_price_centi` is the catalog's figure, not a correction |
| `installmentPlanMatch` | the header stores an integer month count; the pool's label spelling is unrecoverable, and inventing one breaks the never-invent rule |
| `onlineTypeMatch` | there is no `online_type` column on the SO header (it lives on the payment ledger row) |
| `totalRm`, `salesRep`, `paymentMethod`, `images`, `payments` | no SO column is the slip's written total / the rep's signature / the raw payment words / extraction metadata |
| `rawText`, `rawSpec`, `notes`, the inch hints | the line REMARK is deliberately kept CLEAN, so the raw transcription is never on the SO line; the inch hints collapse into snapped Maintenance-pool strings |

Service lines (`item_group='service'`), free-gift lines (`variants.freeGift`) and
cancelled lines are excluded — they are not slip lines.

**Line pairing refuses to guess** (`alignSoLinesToSlip`). It anchors
monotonically on unchanged item codes, then fills each gap between anchors
positionally **only when both sides of the gap are the same length**. An unequal
gap is genuinely ambiguous — which slip row was deleted, which item was added? —
and mis-pairing `rawText` with a code would teach the alias distiller a
handwriting → SKU mapping nobody wrote. There the line keeps the operator's code
and qty and asserts **no** slip provenance (`rawText: ''`). Losing signal is
acceptable; a wrong pair is not.

Guards worth knowing:

- **A wrong pair is still worse than no pair.** `corrected = extracted` is never
  written for an edited draft. And when the edit touched only things the OCR does
  not emit, the rebuilt blob *equals* `extracted`: storing it would be a zero-diff
  `CONFIRMED` row (teaches nothing, and evicts a real correction from the distill
  window), while downgrading it to `ACCEPTED` would assert the AI was right about
  a draft a human had just edited. That case writes **nothing**.
- **No downgrade.** An `ACCEPTED` write can never bury a sample already
  `CONFIRMED` (`:4753`); on the background path the same guarantee comes free
  from writing only `WHERE status='EXTRACTED'`, which also keeps a scan counted
  exactly once across repeated re-confirms. Edit
  detection reads `mfg_so_audit_log`, excluding only `CREATE` and `UPDATE_STATUS`
  by name so that a mutation action added later counts as an edit by default —
  and `source IS NULL` counts as an edit, because unknown provenance must fail
  toward *not* learning.
- **Best-effort and silent.** The whole function is inside one `try` and never
  throws: a sample failing to record must not cost the operator their confirm.
- **The salesperson's workflow is unchanged.** There is no review screen, no
  extra click and no new prompt. The server already knew both "this came from a
  scan" and "a human corrected it"; the edited branch only reads what those two
  facts already imply.

### There is no live UI path that produces a `CONFIRMED` sample

Read this before you plan work on the learning loop. Re-grepped repo-wide on
2026-08-13; the conclusion still holds, the mechanism has moved.

`POST /scan-so/samples/:id/confirm` has exactly **two** callers, both now
routed through the shared `postScanLearningSample`
(`vendor/scm/lib/scan-learning.ts:75`) rather than a raw fetch —
`SalesOrderNew.tsx:1362` and `MobileNewSO.tsx:1459`. Each is behind three early
returns in `maybeLearnFromScan`: `!fromScan` (silent), then `!scanSampleId` and
`!scanAiOriginal`, which now **report** the skip through `reportClientError`
instead of vanishing (`scan-learning.ts:57-66`; `SalesOrderNew.tsx:1257-1259`,
`MobileNewSO.tsx:1380-1385`). The `fromScan` gate cannot open today:

- **Desktop.** `fromScan` is `searchParams.get('fromScan') === '1'`
  (`SalesOrderNew.tsx:380`), and the prefill is read from the scoped handoff
  store, `readScmHandoff<ScanPrefill>('soScanPrefill')` (`:393-394`) — the
  `sessionStorage[SCAN_PREFILL_KEY]` this doc used to cite no longer exists
  anywhere in `frontend/src`. Nothing navigates with `?fromScan=1` (the string
  appears only in `SalesOrderNew.tsx`'s own comment), and nothing **writes**
  `soScanPrefill`: its only hits are the key registry
  (`lib/scmHandoffStorage.ts:17`), the read, the removal, and a test regex.
  `ScanOrderModal` stopped calling `/extract` when it became a pure enqueue
  surface, and the prefill writer went with it.
- **Mobile.** `fromScan = !!scanPrefill` (`MobileNewSO.tsx:873`), and
  `scanPrefill` arrives as a screen prop (`MobileApp.tsx:83`, `:710`). The only
  two `setScreen({ t: "new-so", ... })` call sites are `MobileApp.tsx:678`
  (`mode:"edit"`) and `:822` (`mode:"new"`); neither supplies it. MobileScan
  instead calls the **headless** `createDraftFromPrefill`
  (`MobileNewSO.tsx:436`, its only caller is `MobileScan.tsx:929`), which POSTs
  `/mfg-sales-orders` and nothing else.

So the only live writer into the learning pool is `noteScanDraftAccepted`.

> **Both halves of the above were true until `feat/ocr-relearn-from-corrections`
> (2026-07-22).** At `8f8427ed`, `noteScanDraftAccepted` wrote **`ACCEPTED` only**
> and refused to write anything for an edited draft, while every distiller filters
> `status='CONFIRMED'` — so no new operator correction could enter any distill
> pool at all, and the distillers were re-chewing whatever `CONFIRMED` rows
> already existed. The endpoint's unreachability is unchanged; what changed is
> that the background writer now covers both outcomes, so the `CONFIRMED` pool
> has a live feed again **without** the review screen the two dead callers needed.
> `08975b9d feat(scan): feed the OCR learning loop from the path that actually
> runs (#656)` added `noteScanDraftAccepted`; the edited half was the gap it left.

> Still unverifiable from the tree: whether any `CONFIRMED` rows exist in the live
> DB, and how many. That is runtime data.

The two dead callers and `POST /samples/:id/confirm` itself are **left in place**.
They are unreachable, not harmful, and nothing above depends on them; removing
them is a separate change so it can be reverted alone.

### The rule layers that exist in code today

All three live in **one table**, `scm.so_scan_rules`, keyed by `salesperson`;
two keys are reserved. No migration was needed for either reserved row.

| Layer | Storage key | Distiller | Pool it mines |
|---|---|---|---|
| **Per-salesperson rules** | the rep's normalised name | `distillSalespersonRules` | that rep's latest ≤50 `CONFIRMED` samples |
| **Global alias dictionary** | `'__GLOBAL__'` (`:1716`) | `distillGlobalAliases` (`:1972`) | latest ≤80 `CONFIRMED` samples across all reps |
| **Global shared rules** | `'__GLOBAL_RULES__'` (`:1723`) | `distillGlobalRules` (`:2058`) | `CONFIRMED` corrections across all reps |

`isGlobalKey()` (`:1726`) keeps both reserved rows out of the salesperson
datalist, the per-rep enumeration and the weekly per-rep pass.

Per-rep rules are organised by product category (SOFA / MATTRESS / BEDFRAME /
ACCESSORY / SERVICE / GENERAL) because a rep's notation differs between slip
types (`:1685-1690`). `__GLOBAL__` holds product-name and fabric-code **aliases**
("Bamboo Cruise" / "Cruise" / "B.Cruise" → one SKU). `__GLOBAL_RULES__` holds
the common, rep-independent **extraction patterns** — how the operator
consistently fixes sizes, fabric-code casing, payment-note mapping, address
splitting, `customerSoRef` shape — so one rep's corrections raise the baseline
for everyone including a brand-new rep with no rules of their own
(`:2046-2057`).

### When the distillers run

- **On every confirm**, fire-and-forget in `waitUntil` (`:4775-4812`): the rep's
  rules, then `__GLOBAL__`, then `__GLOBAL_RULES__` — sequential, to keep it to
  one Anthropic call at a time. Each cheap-skips below its sample threshold
  (2 for the rep, 3 for the global rules) without an API call, so firing on every
  confirm is safe. Never blocks the confirm. This *was* the primary fast path —
  it hangs off `POST /samples/:id/confirm`, which has no live caller, so today it
  never fires.
- **NOT on the background writer.** `noteScanDraftAccepted` deliberately does not
  trigger a distill. It runs on the SO status transition, and hanging three
  sequential billed Anthropic calls off every DRAFT → CONFIRMED would put API
  traffic on a hot order path — and would need an import of `scan-so.ts`, which
  imports `mfg-sales-orders.ts`, which imports that module: a cycle. **So today:
  corrections land immediately, distilled rules refresh weekly.** The few-shot
  pool reads `corrected` live at extract time, so a new sample still takes effect
  on the very next scan.
- **Weekly**, Sunday-gated inside the daily 02:00 UTC cron slot
  (`backend/src/index.ts:536-545`) — `distillAllSalespersonRules` rebuilds every
  rep plus both global rows in bulk. There is deliberately **no dedicated cron
  trigger**; adding one would double-run a Claude-API-billed distill every week
  (`scm/index.ts:503-509`).
- **Manually**, `POST /scan-so/rules/:salesperson/distill` (`:2325`).

### Where the layers are injected

`loadPromptInjections` (`:2485`) builds four blocks, and they are appended to the
message in this order (`:2717-2720`):

```
globalAliasText → globalRulesText → repRulesText → fewShotText
```

All four sit **after** the `cache_control` boundary so the SYSTEM_PROMPT +
catalog prefix stays byte-stable across reps and across distills. The prefix is
cached with **`ttl: '1h'`** under the `anthropic-beta:
extended-cache-ttl-2025-04-11` header (`:2698`, `:2711`) — the default 5-minute
ephemeral cache was extended because Houzs is a retailer and the injected
catalog is large (1,141 SKUs + 705 fabrics), so the default expired between
scans spaced apart (`:2693-2697`).

> **Divergence from the design doc.** `docs/ocr-self-evolution.md:18` states
> "Injection order in the prompt = **personal first, then global**". The code
> does the opposite — global aliases, then global rules, then the per-rep block,
> whose own comment says it is placed last so "a rep's own rules can still refine
> on top" (`:2514-2517`). Every block's prompt text also says it "complements,
> never overrides" the universal rules and the catalog. Whether the shipped order
> honours the owner's intent is a judgement call, but the literal ordering in the
> doc is **not** what runs.

---

## 5. What `docs/ocr-self-evolution.md` describes vs what is in the tree

That document is dated 2026-06-24 and mixes an owner vision with a build log.
Audited feature by feature at `8f8427ed`:

| Feature described | Status | Evidence |
|---|---|---|
| Per-salesperson auto-distilled rules | **SHIPPED** | `distillSalespersonRules`, per-rep `so_scan_rules` row |
| Global alias dictionary | **SHIPPED** | `'__GLOBAL__'`, `scan-so.ts:1716`, `:1972` |
| Global shared rules layer (cross-rep distill + store + inject for every rep) | **SHIPPED** | `'__GLOBAL_RULES__'`, `:1723`, `:2058`, injected `:2718` |
| Fire-and-forget distill on confirm | **SHIPPED** | `:4775-4812` |
| Weekly Sunday cron rebuild | **SHIPPED** | `backend/src/index.ts:536-545` |
| `/samples/:id/confirm` is "edit-gated: only when actually edited" | **STALE, twice over.** The edit gate was deliberately removed (`accepted` became a **label**, not a gate — `SalesOrderNew.tsx:1230-1234`; vocabulary `scan-so.ts:1658-1682`), and the endpoint then lost both its callers. The edited/unedited split now lives server-side in `noteScanDraftAccepted` — see §4 |
| Injection order "personal first, then global" | **NOT AS DESCRIBED** — code injects global before per-rep | `:2717-2720` |
| **Manual technique upload** — a rep types their own quirks ("my K = King", "my 7 has a slash") | **NOT FOUND IN CODE** | grep for `manual_rules` / `manualRules` / `so_scan_manual` over `backend/src` and `frontend/src` returns nothing |
| A `so_scan_manual_rules` table, or a manual-rules column on `so_scan_rules` | **NOT FOUND** | `so_scan_rules` is `(salesperson, rules, sample_count, updated_at)` — `0023_so_scan_samples.sql`; no later migration adds a column |
| "Teach the scanner your writing quirks" editor UI | **NOT FOUND** | no such surface in `frontend/src` |
| Owner promoting an individual tip to the global layer | **NOT FOUND** | the global rows are written only by the distillers |

Net: **both automatic engines ship; the entire "active upload" wave — the
manual, human-authored half of the personal layer — does not exist.** A rep can
today only teach the scanner by correcting it.

Two sibling documents:

- **`docs/ocr-prompt-audit.md`** (2026-06-24) is a read-only prompt audit. Its
  inventory says "4 live prompts" and lists **three** in scan-so;
  `buildGlobalRulesMetaPrompt` (`:2058`) shipped afterwards, so the real count is
  4 in scan-so + 1 in scan-payment. Its borrow-list has since been worked
  through: **B1** (multi-digit number guard) is in the prompt at `:852`, **B2**
  (ambiguity → lower confidence, do not guess) at `:850`, **B3** and **B4** in
  `scan-payment.ts:182`, `:192`, `:203`, **B5** (richer distiller checklist,
  including the "quirks that CONFLICT" cue) at `:1751`, `:1755`. **B6** shipped
  *differently* from the proposal: there is no `is_gold` column and no operator
  "mark as gold" control — the ranking is status-based (`goldFirst`,
  `:2595-2599`). **B7**'s premise ("Houzs has no supplier/GRN scan") is now half
  stale: a supplier-document scanner DID land as
  `backend/src/scm/routes/scan-lorry-invoice.ts` (a workshop quotation/invoice →
  repair record, mig 0241 — one synchronous `/extract`, no job row, no learning,
  writes nothing). It is not the GRN/PI goods-line scan B7 was written for, and
  B7's borrow-list was never applied to it. Its §C
  ("upstream changes that are traps") is still current and is the thing to read
  before touching the prompt.
- **`docs/ocr-payment-spec.md`** covers the sibling `scan-payment` receipt OCR,
  the 3-method model, the processing/delivery date coupling and the
  postcode-driven address rule. One divergence worth knowing: §3 specifies
  `Processing = max(today, Delivery − 6 weeks)`, but the code sets NEITHER
  date on a scan draft (owner 2026-08-08, 2990-SO-2608-007: a DRAFT never
  carries a Processing Date — this superseded the 2026-07-04 "pin processing
  to today" ruling, which itself superseded the spec's 42-day arithmetic).
  The create core's both-or-neither pairing rule is what forbids carrying the
  slip's delivery date alone; the operator keys the pair at review.

---

## 6. Database

All in the `scm` schema. Postgres-only — SCM has no D1 twin, so there is no
mirror file in `backend/src/db/migrations/`.

| Migration | Effect |
|---|---|
| `0023_so_scan_samples.sql` | `scm.so_scan_samples` + `scm.so_scan_rules` + 2 partial indexes |
| `0033_so_scan_slip_image.sql` | slip image key on the sample |
| `0034_so_scan_receipt_image.sql` | receipt image key on the sample |
| `0067_scm_scan_jobs.sql` | `scm.scan_jobs` + `created_at` / `salesperson` indexes |
| `0068_scan_dedup.sql` | `scan_jobs.duplicate_of` + 3 lookup indexes (`so_scan_samples(image_sha256)`, `scan_jobs(sample_id)`, `mfg_sales_orders(phone)`) |
| `0070_scan_jobs_retry_count.sql` | `retry_count` — the reaper's single-retry budget |
| `0141_scan_jobs_receipt_image_keys.sql` | `receipt_image_keys jsonb` — the audit manifest of which uploads the model classified as receipts |

**`scm.so_scan_samples`** — `id uuid`, `created_at`, `image_sha256` (SHA-256 of
the first upload, for dedupe), `salesperson`, `extracted jsonb`,
`corrected jsonb`, `status text DEFAULT 'EXTRACTED'`. Both indexes are
**partial, `WHERE corrected IS NOT NULL`**: `(created_at DESC)` and
`(salesperson, created_at DESC)` — exactly the two reads the few-shot pool and
the distillers make.

**`scm.so_scan_rules`** — `salesperson text PRIMARY KEY`, `rules text NOT NULL`,
`sample_count int`, `updated_at`. One row per rep plus the two reserved rows.

**`scm.scan_jobs`** — `id uuid`, `status` (`queued|running|done|error`),
`salesperson` (normalised; reads use `ilike`), `salesperson_id uuid`
(scm.staff, replayed as the SO's `created_by`), `houzs_user_id bigint` (drives
the venue-by-active-project auto-fill *and* is the notice target),
`image_keys jsonb`, `receipt_image_keys jsonb`, `sample_id uuid`, `so_doc_no`,
`error` (a short plain-language sentence, never a raw exception),
`duplicate_of`, `retry_count`, `created_at`, `updated_at`.

Known gap, flagged in code: `scan_jobs.so_doc_no` is **not indexed**
(`scan-sample-review.ts`). `noteScanDraftAccepted` is the only lookup
travelling that direction and it fires only on DRAFT → CONFIRMED, so it is fine
at today's volume — but an index on `so_doc_no` is the right follow-up, and it
needs a staging-first migration. Its cost is now: **1** read for a non-scan SO —
the usual case, and unchanged — **3 + 1 write** for a scan confirmed as-is, and
**5 + 1 write** for a scan confirmed with edits (the SO header and its items are
read in parallel). All inside `waitUntil`; none blocks the operator.

The completion notice writes to **`public.announcements`** via the D1-compat
Postgres shim (`personalNotice.ts:94-111`), not to any scm table.

---

## 7. Who can see / do what, and where it is enforced

| Actor | Can | Enforced at |
|---|---|---|
| Unauthenticated | nothing | `/api/*` auth wall, then `supabaseAuth` on every route (`scan-so.ts:99`) |
| Any signed-in user whose position holds **at least `view`** on `scm.sales.orders` | scan: `warm`, `enqueue`, `extract`, `slip-upload`, poll jobs, confirm samples | `scm/index.ts:516` — `scmAreaGuard("scm.sales.orders", { writeLevel: "view" })` |
| Owner / `*` | everything, plus `clear-failed` across every rep — still only within the active company | `area-guard.ts:122-126` (wildcard bypass); `scan-so.ts:4751-4763` (the delete carries `.eq('company_id', activeCompanyId(c))` for every caller) |
| A rep | clear only their **own** failed job rows | `scan-so.ts:4693` — `ilike` on the caller's normalised name, taken from `user_metadata.name` |

`writeLevel: 'view'` is deliberate and dated 2026-07-04 (`scm/index.ts:510-515`):
these POSTs only stage uploads and background OCR producing the **caller's own**
draft — the salesperson uuid is stamped from the caller — and never mutate an
existing SO. Requiring `edit` 403'd every view-level rep (Sales Executive) on the
mobile Scan flow. The actual SO create/edit routes keep the default `edit` gate.

Salesperson attribution on write is **not** caller-trusted: the draft's staff id
comes from `resolveScanUploaderStaffId` on the authed request (`:4146-4166`,
called `:4222-4223`), never from the request body.

Read scope, on the other hand, is thin. Above the area guard there is **no
per-user check anywhere in this router**:

- `GET /scan-so/jobs` is scoped by **company only** (`:4623` —
  `.eq('company_id', activeCompanyId(c))`). `?salesperson=` is a filter the
  client chooses, not a gate; omit it and you get the latest 20 jobs of the whole
  company.
- `GET /scan-so/jobs/:id` has **no company filter and no owner filter**
  (`:4648-4655`) — a known job id resolves for any admitted caller,
  cross-company.
- `GET /scan-so/slip-image?key=` guards only the `scan-slips/` prefix (`:2347`),
  so a known sample id returns the customer's slip photo.
- `GET /scan-so/rules/:salesperson` returns any rep's distilled rules, and
  `POST /scan-so/rules/:salesperson/distill` triggers a billed Anthropic call for
  any rep — neither has an owner or admin check (`:2302`, `:2325`).
- `POST /scan-so/samples/:id/confirm` overwrites any sample's `corrected` blob
  and label with no ownership check (`:4718`). It has no live UI caller today
  (see §4) but the endpoint is live.

None of this leaks order *content* through the jobs endpoints (the payload is
status / doc-no / error / image keys), but do not assume per-rep or
cross-company isolation here.

### Desktop and mobile files that must change together

| Change | Desktop | Mobile |
|---|---|---|
| Job shape, poll normalisation, time predicates | **`vendor/scm/lib/scan-jobs.ts`** — shared; edit once | |
| OCR result → New SO form mapping | **`vendor/scm/lib/scan-prefill.ts`** — shared; this is where the two surfaces previously diverged | |
| Image compression before upload | **`vendor/shared/image-compress.ts`** — shared (`compressForOcr` / `compressAllForOcr`) | |
| Upload / capture UX, batch handling, duplicate confirm | `vendor/scm/components/ScanOrderModal.tsx` | `mobile/MobileScan.tsx` |
| The sample-labelling comparison (`maybeLearnFromScan`) | `pages/scm-v2/SalesOrderNew.tsx:1216-1324` | `mobile/MobileNewSO.tsx:1327-1395` — **two copies of one rule**; keep them in step |
| Draft-landed notification | `pages/scm-v2/MfgSalesOrdersListV2.tsx` (none today) | `mobile/MobileSalesOrders.tsx:270-340` |
| The `ExtractedSlip` type | declared in `ScanOrderModal.tsx`, imported by `scan-prefill.ts:34` — a desktop file the mobile path depends on | |
| Anything server-side (prompt, rules, pipeline) | `backend/src/scm/routes/scan-so.ts` — one implementation, both shells | |

---

## 8. Performance summary

### Timeouts and retries

| Layer | Value | Cite |
|---|---|---|
| Anthropic extract call | `AbortSignal.timeout(110_000)` — bounds the **whole retry window**, not each attempt | `scan-so.ts:2684-2688` |
| Anthropic distill call | **no explicit timeout** | `claudeDistillCall` `:1792-1836` |
| Google Geocoding | `AbortSignal.timeout(8_000)`, fail-soft to null | `:197` |
| Frontend fetch | 120s for any `/scan-` path, 30s otherwise | `frontend/src/vendor/scm/lib/authed-fetch.ts:64-66` |
| Transport retry | 3 tries on 429/500/502/503/529 | `:111-120` |
| Queue | `max_retries = 3`, then DLQ | `backend/wrangler.toml:135-139` |
| Reaper | 3 min → one re-run from R2 → terminal error | `:4375-4376` |
| Job poll | both clients poll `/jobs` every 4s while a job is unsettled, `false` when settled | `ScanOrderModal.tsx:323-328`, `MobileScan.tsx:536-537` |

### Sizes

- Server cap `MAX_FILE_BYTES = 20 MB` per file (`:100`, enforced `:2430`).
- **Client pre-compression is the load-bearing one**: 2000px long edge, JPEG
  q0.85 (`frontend/src/vendor/shared/image-compress.ts:38`, `:68`). Its header
  carries the measured figure — *2000px @ q0.85 lands ~400-700KB* — against
  Anthropic's 1568px effective cap and 5 MB per-image API limit. The 20 MB gate
  was roughly 2.7× the model's per-image cap before this landed.
  `frontend/src/lib/imagePipeline.ts:28` explicitly forbids wiring the generic
  image pipeline into the scan paths.
- `max_tokens` 8192 extract (`:2702`), 2048 distill (`:1806`). Distilled rules
  soft-capped at 32,000 chars (`:1907`). Distill windows: 50 samples per rep
  (`:1878`), 80 global (`:2001`, `:2110`). Few-shot pool: 5, from a 15-row fetch.

### Caching

- Cached prefix `ttl: '1h'` under `anthropic-beta:
  extended-cache-ttl-2025-04-11` (`:2698`, `:2711`) — extended from the 5-minute
  default because the catalog is large (1,141 SKUs + 705 fabrics, `:2694`). Hit
  rate is observable from `usage.cache_read_input_tokens` /
  `cache_creation_input_tokens` (`:2748-2749`).
- `POST /warm` on modal/screen open, plus a business-hours keep-warm cron
  (`backend/src/index.ts:427-439`, UTC 00-13 ≈ MYT 08:00-22:00).
- **Cheap-skip distillers** — below their sample threshold (2 per rep, 3 for the
  global rules) they return without an API call, which is what makes firing on
  every confirm affordable.
- Partial indexes on `so_scan_samples` matched exactly to the two learning reads.

### Watch

- The distillers are sequential on the confirm path (three Anthropic calls, one
  at a time) inside `waitUntil` — a Worker eviction loses that regeneration. The
  weekly cron is the backstop.
- `scan_jobs.so_doc_no` unindexed (see §6).
- Both poll endpoints run the stale-job reaper on **every** call, so reaper cost
  scales with the number of open Scan screens.
- Test coverage is thin: `backend/tests/scanReceiptPlan.test.ts`,
  `backend/tests/scanSlipPhone.test.ts` (the slip path's phone normalisation) and
  `backend/src/scm/lib/scan-sample-review.test.ts` (the learning-loop feed) are
  the only tests for this module — `backend/tests/scanLorryInvoice.test.ts` is
  the sibling workshop-document scanner, not this one — and `e2e/specs/` holds
  only `smoke` + `assr-lifecycle`, no scan spec. Nothing covers the pipeline
  itself — `runScanJob`, `buildDraftSoBodyFromSlip`, `validateSlip`.

The only measured numbers in the tree are the compression figure above and the
catalog size. The "60-110s real-slip OCR calls" range quoted throughout comes
from `wrangler.toml:124-129` and `scan-so.ts:4312` — statements in comments, not
a benchmark. **No end-to-end latency or accuracy benchmark for this module exists
anywhere in `docs/`.**
