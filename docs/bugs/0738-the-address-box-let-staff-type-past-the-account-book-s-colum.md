## The address box let staff type past the account book's column [medium]

<!-- area: Sales order -->

**Symptom.** Nothing visible, until a sales order silently failed to reach
AutoCount. The person filling the form could type an address of any length; the
column it has to fit is 40 characters, and they were never told. `HC-SO-2609-006`
spent all six attempts on `Cannot set column 'InvAddr1'. The value violates the
MaxLength limit of this column.` (docs/bugs/0728).

**Root cause.** The limit existed only on the way OUT. `soInvoiceAddress` fits
an address to the book's four lines as the document is composed, so the write-back
was safe — but the six address inputs on the three sales-order forms carried no
limit at all, so an over-long line was accepted, stored, and only re-flowed later
somewhere the person who typed it never sees. A limit the form does not have is a
limit staff discover as a document that did not arrive.

The owner's instruction, 2026-09-09: 「我们超过 40 个字的地址全部拆分成 address 1
和 address 2 ... 把我们的 address lock成 40 个字」.

**Fix.**

* `{...addressLineProps(setLine, spill)}` on all six sales-order address inputs
  — desktop and mobile, which change together (`MobileNewSO.tsx`,
  `scm-v2/SalesOrderNew.tsx`, `scm-v2/SalesOrderDetail.tsx`). ONE bundle rather
  than two attributes, because they are not separable and written apart the next
  address input gets one of them.
* **`maxLength` ALONE WOULD HAVE BEEN A REGRESSION, and that is the part worth
  reading.** A browser truncates an over-long PASTE to fit and the tail is gone
  — where the write-back re-flows the same text across four lines and loses no
  word. Staff paste addresses out of WhatsApp all day, so the common path would
  have been the lossy one. `onAddressPaste` therefore breaks the paste at a word
  boundary and hands the remainder to the NEXT line, which is the other half of
  the same instruction (拆分成 address 1 和 address 2).
* The spill target is **required and may be `null`** — the last line saying
  "there is nowhere after me, keep the whole paste and let the write-back re-flow
  it". Optional would have meant every caller that said nothing silently kept the
  truncating behaviour: BUG CLASS optional-param-noop
  (`docs/bugs/0098-bug-class-optional-param-noop-an-optional-argument-that-deci.md`).
* **The bundle came out of the file-size ratchet, and it is better code for
  it.** Two attributes per input grew `MobileNewSO.tsx` and `SalesOrderDetail.tsx`
  past their ceilings; the gate's rule is "make the diff net-non-positive, or
  move the new code into its own module", and the second option produced the
  helper. The remaining line was paid for by deleting a decorative banner comment
  that repeated the card title rendered on the very next line.
* **The number is one number.** `ADDRESS_LINE_MAX` (frontend) is a copy of
  `AC_ADDRESS_LINE_MAX` (backend, measured on AED_HOUZS); the frontend cannot
  import from the backend, so `frontend/scripts/check-address-line-max.mjs` reads
  both files and fails if they disagree.

**Verified.**

* `frontend/src/lib/addressLimit.test.ts` — **13 tests**: the two constants
  agree (read out of the backend source, and a missing match FAILS rather than
  passing quietly); a break lands on a space with line 1 inside the column; a
  90-character single word is broken, not dropped; putting head and tail back
  together returns the original text; a paste that fits is left to the browser; a
  paste over a SELECTION replaces only what was selected; the LAST line keeps an
  over-long paste uncut; and the bundle carries both the width and a working
  spill.
* `npm --prefix frontend run typecheck` (`tsc -b`) clean.
* Full frontend suite **3977 passed** (359 files), coverage floors held, lint at
  ceiling, `check:file-size` OK, `check-docs-drift --strict` 0 CERTAIN.
* **The gate was proven RED before it was trusted green.** With one bundle
  removed it named the box and exited 1; with
  the frontend constant set to 41 it reported `the input limit is 41 and the
  account book's column is 40`. Restored, it reports 3 forms / 6 boxes / OK.
* The gate's SCOPE is derived, not hand-listed, and correcting it found a real
  hole: the first marker (`mfg-sales-orders`) missed `SalesOrderDetail.tsx`
  entirely — it calls `/scm/sales-orders` and names the other route only in
  comments. Anchoring the marker to a path segment gives exactly the three forms
  that WRITE a sales order and excludes the ten other address forms.

**Why the consignment / delivery-order / invoice address forms are NOT capped.**
Measured 2026-09-09: `autocount-outbox.ts`, `autocount-writeback.ts` and
`so-edit-header.ts` compose a document only from `mfg_sales_orders`, with **zero**
consignment references, and `/consignment-orders` writes `consignment_sales_orders`
— a different table. Those addresses never meet AutoCount's column, and capping
them would invent a constraint their system does not have.

**Ref.** feat/address-input-stops-at-forty, 2026-09-09.
