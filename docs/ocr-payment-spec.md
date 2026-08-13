# Houzs SO — Payment & OCR Spec

Owner-specified, captured 2026-06-24. Single source of truth for the consolidated
Payment-Method + OCR (scan-so + scan-payment) wave. Implement AFTER the in-flight
scan-so quality workflow lands (to avoid concurrent edits to the same files).

---

## 1. Payment Method model — 3 top-level methods

Top-level `payment_method` = **Merchant, Online, Cash** (drop "Installment" as a
top-level method — installment is the *plan under Merchant*, not a method).
These are wired-to-order-logic core methods, so reduce the protected list 4 -> 3
in the backend + seed (not just deactivate the config row, or the guard re-adds it).
There are currently **0 payment rows** in `scm.mfg_sales_order_payments`, so this is
a zero-data-migration change.

Per-method required sub-fields (the Payments cascade on New SO / SO Detail):

| Method | Requires |
|---|---|
| **Merchant** | (a) Bank = `merchant_provider`; (b) Plan = `installment_months` (One Shot, or 3/6/12/24/36 months) |
| **Online** | Sub-Type = `online_type` (Bank Transfer / TNG / Cheque / DuitNow) |
| **Cash** | nothing extra |

Config tables (`scm.so_dropdown_options`): `payment_merchant` (banks),
`installment_plan` (One Shot + 3/6/12/24/36 months), `online_type` (the 4 sub-types).

---

## 2. scan-payment OCR — card-terminal receipt -> payment row

Read a card terminal receipt photo and map to a payment row:

- **Amount** -> `amount_centi` (Maybank RM4600.00 -> 460000; AEON TOTAL RM1500.00 -> 150000).
- **Approval / APPR CODE** -> `approval_code` (Maybank 073496; AEON 046501).
- **Swipe date on the receipt** -> `paid_at`. **THIS CAN BE A PAST DATE** — the
  salesperson may open the SO 2-3 days after collecting the money. Use the receipt's
  DATE/TIME, NOT today.
- **Months / Tenure:**
  - Receipt shows "Tenure: N Months" / IPP / installment (e.g. AEON Credit, 12 Months)
    -> Method = **Merchant**, `installment_months` = N (e.g. 12). AEON = installment route.
  - **No months** on the receipt (e.g. a Maybank Merchant swipe) -> **One Shot**
    (`installment_months` = "One Shot"), Method = Merchant.
- **Bank / Host** -> `merchant_provider` (Maybank "Host: MBB" -> MBB; AEON terminal -> AEON).
  See Open Question on banks not in the list.

---

## 3. Processing / Delivery date

- **Processing date** = when the order is "proceeded" (procurement starts). Some
  customers aren't ready for delivery yet, so the order may sit un-proceeded.
- **The two dates are COUPLED — both set, or both empty.** A Processing date never
  exists without a Delivery date (you only "proceed" once there is a delivery to plan for).
- On create / scan, default:
  - If a **Delivery date** is present (from the slip or typed): set Delivery, and
    `Processing = max(today, Delivery − 6 weeks)`.
    (Delivery far out -> proceed ~6 weeks before, not too early -> don't buy stock too soon.
     Delivery soon / within 6 weeks -> proceed today. Never a past date.)
    Example: Delivery Jun 1 -> Processing ~Apr 15.
  - If **no Delivery date**: leave **BOTH Processing and Delivery EMPTY** (the order is
    un-proceeded — customer not ready). Do NOT default Processing to today.
- The "Processing Date and Delivery Date must be set together — Save is blocked" guard is
  CORRECT (both-or-neither). The earlier fix that force-seeded Processing = today on every
  scan is WRONG and must be removed — only seed Processing when a Delivery date exists.

---

## 4. Address — Google Maps assist

- Postcode is the driver: picking a **postcode** auto-cascades **city + state** (localities).
  Do NOT hard-set city/state independently.
- Use Google (Places/Geocoding) to match the customer's **condo / taman / jalan** name
  to the nearest real place -> resolve the precise **postcode** -> the cascade fills
  city/state. Goal: nail the taman/jalan/condo + postcode; the rest follows.
- Fail-soft: if the key is missing or geocode fails, fall back to the LLM parse (no crash).

---

## 5. scan-so line items (in-flight workflow)

- Match every slip line against the **FULL** catalog (un-truncated, ~1141 SKUs).
  Aggressive fuzzy / abbreviation match: "holes" -> AKEMI SLEEP ESSENTIAL 7 HOLES PILLOW;
  "W. Protector (King)" -> WATERPROOF PROTECTOR King; "Guardian (King)" -> Guardian model
  + King size; "bolster" -> AK-ESSENTIAL BOLSTER. Never invent a code not in the master.
- Line item product field is **ALWAYS a SKU dropdown** — never free-text. A no-match line
  = an empty **required** dropdown the user must pick from. No back-door insert.
- Phone -> +60 without the leading 0. Notes -> only the essential order remark (not a dump
  of venue / other phones / delivery terms / payment). Per-line "Slip: ..." annotation -> short.

---

## 6. OCR SYSTEM_PROMPT corrections (scan-so.ts)

The vendored prompt still carries 2990-era + pre-3-method wording. Fix in place:

- **Company name**: the prompt (and GLOBAL_ALIAS_META_PROMPT) say "**2990's Home**, a
  Malaysian furniture retailer" — wrong. This is **Houzs Century**. Replace the company
  name (the Zanotti / AKEMI brand references are real products — keep those).
- **No "Installment" method**: `paymentMethodMatch` must only ever return Merchant / Online
  / Cash. Remove the "Installment method = in-house" carve-out. A bank EPP is already
  Merchant + an installment term — keep that, but drop Installment as a returnable method.
- **No tenure -> One Shot**: the prompt currently DEFAULTS `installmentPlanMatch` to 12
  months when EPP is indicated but no count is written, and returns null for a plain swipe.
  Both wrong. Rule: a card paid through a bank with **no month/tenure written -> One Shot**
  (Maybank receipt = One Shot). Only set N-months when the receipt/slip actually shows a tenure.
- **Banks**: add AEON / HSBC to the bankMatch examples once seeded (see Open question).

## 7. Branding as configuration (not hardcoded)

Root cause of the "2990's Home" leak: company identity is hardcoded across the prompt, PDF
letterhead, and emails. Make it a **maintained Branding config** (Settings): company name,
registration no., logo, address — one source of truth that the OCR prompt, PDF letterhead,
and outbound email all read. Owner wants this maintainable, not hardcoded. (Built deliberately
as its own step after the POM round, since it touches PDFs + emails — not rushed in parallel.)

## Open question — bank list is incomplete

`payment_merchant` is seeded with 6 (MBB / CIMB / Public / HLB / Alliance / Pinelabs),
but the field's own hint lists 9 (… RHB / Bank Islam / BSN / AmBank …) and these receipts
need **AEON** (issuer HSBC). Decide how a receipt bank not in the list maps:
add the missing banks (+ AEON/HSBC), have the OCR pick the closest, or leave it blank for
a manual pick. Recommendation: seed the full intended set + AEON, leave unknowns blank for manual.

## Round 2 — OCR polish (owner test 2026-06-24; do AFTER the Branding wave to avoid file conflicts)

NOTE over-stuffing was already fixed in v53 (`ScanOrderModal` buildPrefill keeps only
remarks + unresolved-venue + non-date-delivery). The owner's screenshot still showing the old
`Venue/location on slip:` / `Other phone(s):` / `Payment method on slip:` / `Deposit on slip:`
prefixes is a STALE SW cache (old frontend) — hard-refresh resolves it. Genuine remaining bugs:

1. **Phone country defaults to US +1** — must default to **MY +60** (frontend PhoneInput
   default + the scan prefill). The number is Malaysian; the selector picks US.
2. **"W. Protector (King)" matched a JM-branded protector** instead of the plain
   **MATTRESS PROTECTOR (KING)** — when several SKUs match a token, prefer the plain/generic
   row over a branded variant (scan-so prompt tuning: "prefer the most generic catalog match
   unless the slip names the brand").
3. **Receipt = the payment slip**: when a payment row is created from a scanned card receipt,
   store that receipt image AS the payment's slip so the "Each payment needs a slip uploaded
   before saving" guard is auto-satisfied — the owner has no separate slip, the receipt IS it.
   (PaymentsTable scanReceiptIntoRow + the slip-required guard + the scan-payment R2 image.)
   *2026-08-13: shipped, and the guard it was auto-satisfying no longer exists — the slip is
   optional on every SO path (owner ruling; see `docs/modules/sales-order.md`). Storing the
   receipt as the payment's slip is still the behaviour: it is now proof, not an exemption.*
4. **Payments table right side skewed** — the Slip upload column overflows / is cut off;
   layout fix in PaymentsTable (responsive/overflow).
5. (Confirm w/ owner) the per-line PHOTOS upload section on scanned lines — keep or drop?
