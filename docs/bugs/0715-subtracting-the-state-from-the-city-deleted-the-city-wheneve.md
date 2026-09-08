## Subtracting the state from the city deleted the city whenever they are the same word [medium]

<!-- area: Cutover + migrated data -->
<!-- status: fixed -->

**Symptom.** Creating a delivery order from `HC-SO-012565` on 2026-09-08, the
Create-DO banner read:

> **HC-SO-012565 does not carry:** Email, Customer Type, City. These fields are
> blank because the sales order has no value for them — fill them in from the
> customer, not from memory.

The book has that customer. `backend/scripts/data/ac-outstanding-so.json.gz`
holds `DebtorCode 300-C002`, `DebtorName "Lisa"`, a `Phone1`, and
`InvAddr1/InvAddr3/InvAddr4` with `InvAddr4 = "Kuala Lumpur"`. The addresses
themselves reconcile at zero differences — the field-identity table reads
`invoice addr 1..4` and `delivery addr 1..4` all agreeing. Only the CITY is
missing, and the city is the one field of the three that is DERIVED rather than
copied.

**Root cause (traced).** `backend/scripts/import-ac-outstanding-so.mjs:306-308`:

```js
const addrStr  = [h.InvAddr1, h.InvAddr2, h.InvAddr3, h.InvAddr4].filter(Boolean).join(", ");
const postcode = /\b(\d{5})\b/.exec(addrStr)?.[1] ?? null;
const cState   = stateOf(postcode);
let city = null;
if (postcode) city = (addrStr.slice(addrStr.indexOf(postcode) + 5).split(",")[0] || "")
  .replace(new RegExp(cState || "$^", "i"), "").trim() || null;
```

The text after the postcode is read, and then **the state name is subtracted from
it**. Simulated over all 13,365 book sales-order headers in the committed cut:

| the subtraction | headers |
| --- | --- |
| changes nothing | 9,697 |
| correctly trims a trailing state — `PADANG SERAI KEDAH` -> `PADANG SERAI` | 914 |
| **deletes the whole city** | **1,935** |

The 1,935 are every address whose city and state are the same word — Kuala
Lumpur (1,539 + 39 upper-case), Melaka (215), Putrajaya, Penang — plus a handful
left holding punctuation, where `KUALA LUMPUR.` became `.` and `.` was stored as
the city because `"." || null` is truthy.

`HC-SO-012565` is the first class exactly: `52200 Kuala Lumpur` with
`stateOf("52") === "Kuala Lumpur"`, so the replace emptied it.

**Email and Customer Type are NOT this bug and must not be reported as a
migration loss.** No AutoCount export in `backend/scripts/data/` carries an email
column or a debtor-type column — scanned across all 43 snapshots, the only
type-ish field anywhere is `ItemCategory` on the item master — and the
sales-order "customer master" is the prior sales orders themselves
(`backend/src/scm/routes/mfg-sales-orders.ts:11405` autocompletes
`debtor_code, debtor_name, phone, address1..4` from `mfg_sales_orders`). There is
nowhere those two could have been carried FROM. The banner naming them is
correct behaviour, not a defect.

**And `InvAddr4` is the STATE, not the city.** It reads "Kuala Lumpur" on this
one document only because KL is both. Its commonest values across the book are
Selangor 2,647, Penang 1,797, Kuala Lumpur 1,560, Johor 820 — so copying
`InvAddr4` into `city` would stamp a state name onto thousands of orders. That is
the wrong repair and it is written down here so nobody reaches for it.

**Fix.** `backend/scripts/lib/customer-block.mjs` states the rule once and
`repair-customer-block.mjs` applies it: read the text after the postcode from the
order's own address lines (the book's `InvAddr1..4`, copied verbatim by the
importer) and accept it **only when `scm.my_localities` — the ERP's own postcode
-> city master, mig 0022 — lists it as a city of that exact postcode**, writing
the master's spelling. So `KUALA LUMPUR.` at 50000 becomes `Kuala Lumpur`;
`Selangor` at 40000 is REFUSED because the master says Shah Alam; a postcode with
nothing after it is REFUSED; `KL` is REFUSED. The book has to say it and the
master has to confirm it — neither a copy of a state nor a guess from a postcode.

Pinned by `backend/tests/customerBlock.test.mjs` — 15 cases, nine of them
refusals.

The size of the class is measured by
`backend/scripts/check-customer-block-gap.mjs` +
`.github/workflows/check-customer-block-gap.yml`, read-only, which prints the
refusals with their reasons beside the repairable count.

**Not fixed here, deliberately.** The importer's own derivation at
`import-ac-outstanding-so.mjs:308` is left as it is. It runs only on a fresh
cutover import, the population it would serve is already imported, and changing a
one-shot importer that will not run again buys nothing while risking a re-import.
If it is ever run again, replace those three lines with `cityFromBook`.

**Sized, then closed, on production.** Probe run
[`34221966031`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34221966031)
(19:38 Malaysia): of 2,883 company-1 sales orders, **711 carried a blank city**
(3 of them holding a stored `.`), and the gate accepted a city for **417** of
them. The other 294 are printed refusals — 142 the book gives no postcode, 112
the book writes nothing after it, 40 the book writes something
`scm.my_localities` does not list for that postcode (`KL`, `BM`, `JB`, and
district-vs-locality disagreements such as `KUALA LUMPUR` at 53300 where the
master says Setapak), 3 the order carries no address at all. **The book has no
city for those and none was invented.**

Apply run
[`34222124527`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34222124527)
wrote 417 cities. On the plan, `the book's address differs from the ERP's: 0` —
the orders' address lines are still the book's, verbatim. Verified on a FRESH
connection, which re-read the address master as well: `0` cities not the value
planned and `0` the master would refuse. Re-measured by probe run
[`34222237940`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34222237940):
blank cities **711 -> 294**, repairable **417 -> 0**. `HC-SO-012565` now reads
`city=true`, so the banner no longer names City on it.

Email and Customer Type were counted and left alone: blank on all 2,883 sales
orders and 2,882 respectively, and the probe re-asserts on every run that the
book has neither column (`email column present: false; debtor-type column
present: false`).

**Ref.** fix/customer-info-gap, 2026-09-08. Full before/after:
`docs/customer-block-gap-2026-09-08.md`.
