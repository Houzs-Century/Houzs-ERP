# Houzs OCR Prompt Audit — coherence + upstream borrow-list

**Date:** 2026-06-24
**Scope:** READ-ONLY audit. No source files edited.
**Files audited (Houzs):**
- `backend/src/scm/routes/scan-so.ts` (handwritten SO slip OCR + per-rep/global distill)
- `backend/src/scm/routes/scan-payment.ts` (card-terminal / EPP receipt OCR)
- `backend/src/scm/index.ts` (route mounting), `backend/src/index.ts` (cron wiring)

**Upstreams compared:**
- 2990 — `wenwei4046/2990s` **ACCESSIBLE** (cloned shallow to `C:\Users\User\Desktop\_2990_ref`). `apps/api/src/routes/scan-so.ts` is the direct ancestor of Houzs scan-so. **2990 has NO scan-payment and NO scan-supplier** — those are Houzs-native / Hookka-only.
- Hookka — `C:\Users\User\Desktop\_hookka_ref`. `src/api/routes/scan-po.ts` (typed customer-PO PDFs, the grand-ancestor), `src/api/routes/scan-supplier.ts` (supplier DO/invoice → GRN/PI), `src/api/lib/ocr-distill.ts` (per-customer + per-supplier distillers).

**Houzs OCR prompts inventoried (4 live, all in the 2 files above):**
1. `scan-so.ts` → `buildSystemPrompt(companyName)` — the SO-slip extraction prompt
2. `scan-so.ts` → `buildDistillMetaPrompt(companyName)` — per-salesperson rule distiller
3. `scan-so.ts` → `buildGlobalAliasMetaPrompt(companyName)` — cross-rep alias dictionary distiller
4. `scan-payment.ts` → `buildSystemPrompt(companyName)` — payment-receipt extraction prompt

A repo-wide grep for `SYSTEM_PROMPT|META_PROMPT|DISTILL|anthropic|messages.create` across `backend/src` returns only these two route files plus `index.ts` (route mount / key-presence check) and `routes/systemHealth.ts` / `types.ts` (which only check `ANTHROPIC_API_KEY` presence — no prompt). **No other OCR/LLM prompt exists** — in particular Houzs has **no supplier-doc / GRN scan** prompt today.

---

## (A) Coherence-audit table

| # | Prompt | Wired? | Reflects current Houzs rules? | Issues found |
|---|--------|--------|-------------------------------|--------------|
| 1 | scan-so `buildSystemPrompt` | **Yes** — built into `buildCachedPrefix`, sent by `/scan-so/extract`, `/scan-so/warm`, and the keep-warm cron. Route mounted `scm.route('/scan-so', scanSo)` and guarded `scmAreaGuard('scm.sales.orders')`. | **Yes.** Company name injected from Branding (= "Houzs Century"). Payment method "ONLY valid values are Merchant, Online, Cash; never any other" (no Installment). No-tenure card → "One Shot" value, with an explicit "NEVER default to 12 months". AEON/HSBC named in `bankMatch`. `addressStateMatch` snapped to the live `my_localities` states list; postcode is the documented driver. SKU/fabric never-invent + forced server-side `validateSlip` clear. | **Stale comments only (no prompt-text contradiction):** the file header (lines 53–55) and the `distillAllSalespersonRules` docstring (lines 1278–1280) say the weekly distill cron is "NOT wired here yet / FOLLOW-UP". It **IS** wired in `backend/src/index.ts` (Sunday-gated 02:00 UTC slot, line ~290) and the keep-warm cron is wired too (line ~244). Comments are out of date. Prompt content itself is coherent. |
| 2 | scan-so `buildDistillMetaPrompt` | **Yes** — called by `distillSalespersonRules` (fire-and-forget on `/confirm`, manual `/rules/:sp/distill`, weekly cron). | **Yes.** Company name injected. Per-category sections (SOFA/MATTRESS/BEDFRAME/ACCESSORY/SERVICE/GENERAL). "Output ONLY the rule text … first characters must be a section label" anti-pollution guard present. Diff-driven ("DERIVE THE RULES FROM THE DIFFS"). | No internal contradiction. (See borrow item B5 — the BEDFRAME example "drops leading zeros in suffixes" is the only category cue; could be enriched but not incoherent.) |
| 3 | scan-so `buildGlobalAliasMetaPrompt` | **Yes** — called by `distillGlobalAliases` (fire-and-forget on `/confirm`, weekly cron, first in `distillAllSalespersonRules`). Injected into EVERY `/extract` as the `SHARED PRODUCT ALIASES` block (before the per-rep block). | **Yes.** Aliases-only ("DO NOT write per-salesperson style notes"), "Use ONLY codes / base models that appear in the operator-corrected JSON — NEVER invent". Section-label anti-pollution guard present. | Coherent. Minor: header comment block is accurate here. |
| 4 | scan-payment `buildSystemPrompt` | **Yes** — sent by `/scan-payment/extract`. Route mounted `scm.route('/scan-payment', scanPayment)` and guarded `scmAreaGuard('scm.sales.orders')`. | **Yes — and the most rule-consistent of all four.** "PAYMENT METHODS are exactly THREE: Merchant, Online, Cash. There is NO 'Installment' method." No-tenure swipe → "One Shot". AEON host handling + "if host bank NOT in MERCHANT BANKS, return null — do NOT substitute". `paidAt` = receipt swipe date, may be past, "NEVER today" (enforced again in `normalizeReceipt.isoDate`). Amount = financed TOTAL not monthly. | No internal contradiction. **Cross-prompt consistency gaps vs scan-so (see C-issues below).** |

### Cross-prompt coherence issues (sibling-rule drift)

- **C-1 (low):** scan-payment's `installmentPlanMatch` rule omits the explicit **"NEVER default to 12 months when no tenure is written"** sentence that scan-so carries. scan-payment still gets it right ("no tenure → One Shot"), but the negative guard is load-bearing on EPP receipts that print "EPP" without a month count. Worth mirroring the exact negative.
- **C-2 (CORRECTED 2026-08-13 — this entry was wrong):** the claim that "scan-so never reads a receipt's `paidAt`/swipe date" is **false**, and was false when written. scan-so's `payments[]` block has always read each receipt's own printed transaction date; `planReceiptPayments` coalesces it (falling back to the slip's own date, then today) and it becomes the payment-ledger row's `paid_at` (`scan-receipt-plan.ts`). The two prompts do **not** split receipt-date ownership. What misled the audit is that scan-so called the field **`processingDate`** — the same word the Sales Order's factory-start date uses — so it did not read as a receipt date at all. It is now `ExtractedPayment.receiptTxnDate`; scan-payment's equivalent stays `paidAt` because that route emits the ledger value directly. See `docs/modules/scan-to-so.md` §2b.
- **C-3 (info, not a bug):** scan-so injects the FULL option catalog (customer/building/venue) while scan-payment injects only the 4 payment categories. Deliberate — scan-payment is extraction-only for ONE payment row. No change.

**Net coherence-issue count: 4** — 1 stale-comment pair counted as one issue (#1), plus C-1, C-2, C-3. Only **one** (C-1) is a prompt-text fix worth making; the rest are comment hygiene / informational.

---

## (B) Borrow-list (upstream prompt improvements Houzs lacks)

Each item: exact text to add, where it belongs, why it helps, priority. **All vetted against Houzs's deliberate changes** — nothing here re-adds 2990's Home, the Installment method, or the 12-month default.

| # | Source | Exact text / rule to add | Where in Houzs prompt | Why it helps | Priority |
|---|--------|--------------------------|-----------------------|--------------|----------|
| **B1** | Hookka scan-po (multi-digit number guard) | Add to the LINE ITEMS section: *"NUMBERS — read the FULL numeric token, never truncate a two-digit number to its first digit. A digit followed by another digit before any non-digit is the multi-digit number: '12' → 12 (NOT 1), 'RM1,250' → 1250. The inch mark (\") and trailing words are unit/spec text, not digit separators."* | scan-so, end of LINE ITEMS (after the `priceRmGuess` bullet); optionally mirror one line into scan-payment's `amountRm` field note. | Hookka logged a real recurring bug: Claude truncates "10"/"12" to "1" even at temperature 0. Houzs slips carry handwritten prices and qty like "x12"; a truncated price/qty silently corrupts the SO. Houzs has NO equivalent guard today. | **High** |
| **B2** | Hookka scan-po (ambiguous → flag, don't guess) | Generalize Hookka's drawer-side rule into a universal: *"When a field is genuinely ambiguous (two equally-plausible readings, smudged digit, unclear size), do NOT pick one at random — return your best single guess at LOWER confidence (below 0.6) and state the ambiguity in `notes`/`reason` so the operator reviews it. A flagged ambiguity the operator catches beats a confident wrong value that slips through review."* | scan-so SYSTEM_PROMPT, new short paragraph right after the opening "prefer extracting a raw transcription over guessing" line. | Houzs's confidence scale exists but the prompt never tells the model to LOWER confidence on ambiguity or surface it — so a 50/50 size guess comes back at 0.9 and gets auto-applied. Hookka's hard-won lesson: wrong-but-confident is the value that survives operator review. | **High** |
| **B3** | Hookka scan-supplier (own-figures discipline) | Add to scan-payment intro: *"Extract EXACTLY what is printed on the receipt. Do NOT 'correct' the figures and do NOT compute a total the receipt doesn't show. If a field is genuinely absent, return null — never guess."* | scan-payment `buildSystemPrompt`, second paragraph (before HOW TO CLASSIFY). | scan-payment currently leans on per-field nulls but lacks the blanket "don't invent a total / don't recompute" instruction. EPP receipts show monthly + financed amounts; the model can be tempted to compute or reconcile. Cheap, high-signal guardrail. | **Med** |
| **B4** | scan-so itself (mirror to sibling) | Mirror scan-so's exact negative into scan-payment's `installmentPlanMatch`: *"NEVER default to a 12-month (or any N-month) value when no tenure / month count is printed — a card receipt with no tenure is One Shot, even when it says 'EPP' / 'INSTALMENT' without a number."* | scan-payment FIELDS → `installmentPlanMatch` bullet (and rule 1's installment sub-bullet). | Fixes coherence issue **C-1**. scan-payment handles EPP receipts that print "EPP"/"ANSURAN" with no month count; the explicit negative stops a spurious 12-month fill. Preserves the deliberate One-Shot rule, just states it as a negative too. | **Med** |
| **B5** | Hookka ocr-distill (richer "what's bespoke" checklist) | Extend `buildDistillMetaPrompt`'s per-category bullet list with the Hookka cues it lacks: *"• Their document/serial number format (prefix, length, letter/digit pattern) — e.g. their customer-SO-ref style. • Header/letterhead layout cues unique to this rep's slips. • Default delivery hub/state if they consistently ship to one area. • Quirks that CONFLICT with the universal rules — call those out explicitly."* | scan-so `buildDistillMetaPrompt`, inside the "Within each category section capture what is BESPOKE TO THIS REP" list and/or the GENERAL: section description. | Houzs added `customerSoRef`, address-parts, and venue extraction to the SO prompt but the distiller's checklist still only covers line-item shorthand/size/fabric/price/qty. Adding the ref-format + conflict-callout cues lets per-rep rules also learn header/ref habits — exactly the fields Houzs newly extracts. The "quirks that conflict" cue is a proven Hookka technique missing from Houzs. | **Med** |
| **B6** | Hookka scan-po (gold-reference few-shot weighting) | Concept, not prompt text: add an operator "mark as gold reference" flag on `so_scan_samples` and boost gold rows in the `/extract` few-shot pool ahead of plain confirms (Hookka: `ORDER BY isGold DESC`). | scan-so `/extract` few-shot selection (the `picked` pool builder) + a new `is_gold` column; no SYSTEM_PROMPT change. | Houzs's few-shot pool currently weights only by rep + recency. A rep's *messiest* recent slip can crowd out a clean canonical example. Hookka lets the operator pin gold standards. Improves the signal quality of the 5 injected examples. | **Low** |
| **B7** | Hookka scan-supplier (skip non-goods rows) | If/when Houzs builds a supplier-doc OCR, port scan-supplier's *"one object per goods line. Skip non-goods rows (subtotal, SST, rounding, freight-as-note, 'Thank you' lines)"* + `docType` DELIVERY_NOTE/INVOICE/OTHER classification + "currency default MYR". | N/A today — Houzs has no supplier/GRN scan. Future module. | Documents the cleanest available template for the GRN/PI OCR Houzs lacks. Not actionable now; logged so it isn't re-derived from scratch later. | **Low** |

---

## (C) Upstream changes that are TRAPS — do NOT borrow

| Trap | Source | Why it must NOT be ported |
|------|--------|---------------------------|
| **"An in-house installment arrangement → 'Installment'"** | 2990 scan-so `paymentMethodMatch` rule (line 342) | 2990 still lists a 4th `Installment` method. Houzs **deliberately removed it** (3-method model: Merchant/Online/Cash; a bank EPP is Merchant + tenure). Re-adding it would reintroduce a returnable method the Houzs cascade and `so_dropdown_options` don't have. **Already correctly absent in Houzs — keep it absent.** |
| **"paid-in-full / no term → the One-off value ONLY when the slip explicitly says so, else null"** | 2990 scan-so `installmentPlanMatch` (line 345) | 2990 returns **null** for a no-tenure card. Houzs deliberately flipped this to **"One Shot"** (a no-tenure Merchant card = One Shot, with the explicit anti-12-month guard). Porting 2990's null-default would regress Houzs's One-Shot behaviour. **Do not "simplify" Houzs back toward the 2990 wording.** |
| **Company name "2990's Home"** | 2990 scan-so / distill / alias prompts | Hardcoded "2990's Home". Houzs injects "Houzs Century" via Branding. Never copy 2990's literal. (Houzs already does this correctly.) |
| **`base_model` in the catalog block** | 2990 scan-so `formatCatalog` (3 columns) | Houzs deliberately dropped `base_model` from the SKU lines on 2026-06-23 (`code | name` only) to shrink the cached prefix (1141 SKUs). Don't "restore" the third column when syncing other catalog tweaks — it bloats the cache for no matching gain. |
| **Hookka scan-po LHF/RHF + diagram-order + divan/leg/gap inch geometry** | Hookka scan-po (lines 368–566) | This is for typed sofa-diagram **purchase-order PDFs** with spatial box-counting and server-side LHF/RHF swap math. Houzs scans **handwritten retail SO slips** with no module diagrams. Porting the sofa-geometry block would be a large irrelevant prompt bloat that confuses the model on Houzs's domain. Borrow only the *generalizable* number-reading + ambiguity rules (B1/B2), not the geometry. |
| **Hookka per-CUSTOMER rule keying** | Hookka scan-po / ocr-distill | Hookka learns per *customer*; Houzs deliberately learns per *salesperson* (each rep's handwriting) plus a global alias layer. Don't refactor Houzs toward customer-keyed rules — the per-rep model is the intentional Houzs design. |

---

## Verification notes

- Both routes are **mounted and permission-guarded** (`scm.sales.orders`) in `scm/index.ts`.
- The keep-warm cron (`warmCatalogCacheForCron`) and weekly distill cron (`distillAllSalespersonRules`, Sunday-gated) **are wired** in `backend/src/index.ts` `scheduled()` — contradicting the "not wired yet" comments inside `scan-so.ts`. (Comment-hygiene fix, not a prompt fix.)
- `ANTHROPIC_API_KEY` is optional on the Houzs Env; both `/extract` endpoints return `503 anthropic_key_missing` when absent (consistent, graceful).
- Server-side never-invent enforcement (`validateSlip` / `validateReceipt`) is present on both and clears any match outside the live active lists — the anti-hallucination belt-and-braces is already in place.
