# The customer block on delivery orders and sales orders — 2026-09-08 (Malaysia, UTC+8)

Delivery orders opened to staff at 17:41 and the owner sent two screens. This is
what each one turned out to be, how big its class was, what was repaired, and
what was deliberately left blank.

Measured, not recalled. Every number names the run that produced it. No customer
name, phone number, address or email appears anywhere in this document or in any
of those runs' output — counts and document numbers only.

---

## 白话文：三句话

1. **173 张交货单上没有电话、没有地址** —— 司机拿着那张单没办法送货。**现在
   173 张全部有了**，客户资料是从它的销售单抄过来的，销售单的资料是从账本抄的。
2. **711 张销售单的「城市」是空的**，其中 **417 张** 单子自己的地址里就写着城市名，
   已经补回去。剩下 294 张是账本本来就没写城市，**留空是对的**，不乱填。
3. **Email 和 Customer Type 从来就不在 AutoCount 里** —— 账本根本没有这两栏。
   不是搬漏了，是没得搬。以后不用再去找。

一样东西都没有动到：单据数、行数、数量、金额、库存、备料状态，前后完全一样。

---

## What he saw, and what each one was

| screen | document | what renders | cause |
| --- | --- | --- | --- |
| 1 | `HC-DO-011556`, from `HC-SO-013124` | phone, email and address all `—` | **A** — the migrated delivery-order writer never had a customer block |
| 2 | creating a DO from `HC-SO-012565` | *"does not carry: Email, Customer Type, City"* | **B** for City; **neither** for the other two — AutoCount has no such column |

The two are different causes and their counts are never added together.

---

## Cause A — the migrated delivery order never had a customer block

`backend/scripts/lib/migrated-do-writer.mjs`'s header INSERT named fourteen
columns and not one of them was `phone`, `email`, `customer_type`,
`building_type`, `address1`, `address2`, `city`, `state`, `customer_state`,
`postcode`, `customer_country` or the emergency contact — all of which
`scm.delivery_orders` HAS and the interactive create path fills
(`delivery-orders-mfg.ts:3459`). Absent by construction, on every document that
writer produced.

**The book is not at fault.** `ac-doc-headers.json.gz` carries `DebtorCode`,
`DebtorName`, `Phone1` and `InvAddr1..4` for `SO-013124`, and the sales-order
importer copied them onto the parent order. The parent held the block; the
delivery order it produced did not.

### The hypothesis this lane started from, and how it was refuted

The brief proposed that `HC-SO-013124` had arrived through a DELIVERY-ORDER
import, because it is absent from `ac-outstanding-so.json.gz` (all four book
lines have `transferedQty = qty`, so `fullyDelivered()` drops it). **That is
false.** It was PRESENT in every cut up to and including the 2026-08-30 one
(commit `e75d461bc`), reading `TransferedQty 0` with a phone and three address
lines; it became fully delivered after it was imported. And only
`import-ac-outstanding-so.mjs` inserts sales orders in this tree. The missing
block was on the DELIVERY ORDER, never on the sales order — which the probe then
confirmed on the live row: `parent SO: phone=true addr=true`.

### The count, before

Probe run [`34221966031`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34221966031) (19:38):

```
company-1 delivery orders, not cancelled              185
  no phone AND no address line at all                 173   <- a driver cannot use these
    of them migrated                                  173
    of them created in the ERP by a human               0
  REPAIRABLE from the parent sales order               173
  parent is blank too but the BOOK holds it             0
  neither the ERP parent nor the book holds anything    0
  partial (a phone or an address but not both)          0
```

**173 of 185.** Not two, and not two thousand.

---

## Cause B — a derived field, deleted by its own cleanup step

**AutoCount has no city column.** `InvAddr4` is the STATE. On the company-1
orders with a blank city its commonest values are Selangor 733, Penang 503,
Kuala Lumpur 390, Johor 283 — so copying `InvAddr4` into `city`, which is what
the brief's reading of `HC-SO-012565` suggests, would stamp a state name onto
hundreds of orders. It reads "Kuala Lumpur" on that one document only because KL
is both a city and a federal territory.

So `city` is DERIVED. `import-ac-outstanding-so.mjs:308` reads the text after the
5-digit postcode and then **subtracts the state name from it**. Simulated over
all 13,365 book headers:

| the subtraction | headers |
| --- | --- |
| changes nothing | 9,697 |
| correctly trims a trailing state — `PADANG SERAI KEDAH` -> `PADANG SERAI` | 914 |
| **deletes the whole city** | **1,935** |

Every one of the 1,935 is an address whose city and state are the same word —
Kuala Lumpur, Melaka, Putrajaya, Penang — plus a few left holding `.`, which was
then stored as the city because `"." || null` is truthy.

### The count, before

```
company-1 sales orders, not cancelled                 2883
  city blank or nothing but punctuation                711
    of those, a stored value with no letter in it        3   (".")
    the order's own address states it AND the master confirms it   417   <- repairable
    refused  142  no 5-digit postcode in the book address
    refused  112  the book writes nothing after the postcode
    refused   40  the book writes something the address master does not list for that postcode
    refused    3  the order carries no address at all
```

### The gate, and what it refuses

The rule is `backend/scripts/lib/customer-block.mjs` (`cityFromBook`), shared by
the probe that counts the gap and the repair that closes it so the two cannot
answer differently. The book's own text is accepted **only when
`scm.my_localities` — the ERP's postcode -> city master, mig 0022, 5,973 rows
over 3,028 postcodes on production — lists it as a city of that exact
postcode**, and the master's spelling is what gets written.

| the book writes | postcode | outcome |
| --- | --- | --- |
| `KUALA LUMPUR.` | 50000 | accepted, written `Kuala Lumpur` |
| `LUNAS KEDAH` | 09600 | accepted, written `Lunas` (trailing state trimmed) |
| `Selangor` | 40000 | **REFUSED** — the master says Shah Alam |
| nothing after the postcode | any | **REFUSED** — the book has no city |
| `KL` | 51200 | **REFUSED** — an abbreviation the master does not carry |

Nine of the fifteen cases in `backend/tests/customerBlock.test.mjs` are
refusals. This is not a derivation from the postcode: the book has to say it AND
the master has to confirm it.

---

## Email and Customer Type never existed. Nobody should look for them again

- **No AutoCount export in `backend/scripts/data/` carries an email column or a
  debtor-type column.** Scanned across all 43 snapshots; the only type-ish field
  anywhere is `ItemCategory` on the item master. The probe re-asserts it on every
  run: `email column present: false; debtor-type column present: false`.
- **The sales-order "customer master" is the prior sales orders themselves.**
  `GET /mfg-sales-orders/debtors/search` autocompletes
  `debtor_code, debtor_name, phone, address1..4` out of `mfg_sales_orders`
  (`mfg-sales-orders.ts:11405`). There is no separate record holding an email for
  a migrated debtor.

`email` is blank on all 2,883 company-1 sales orders and all 185 delivery orders;
`customer_type` on 2,882 and 185. **That is not a migration loss and it was not
repaired.** The Create-DO banner naming them is the banner doing its job — the
source order genuinely does not carry them — and its instruction stands: fill
them in from the customer, not from memory.

---

## What was written

Apply run [`34222124527`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34222124527)
(19:42:42–19:43:28), `MODE=apply CONFIRM="CARRY THE CUSTOMER BLOCK"`, one
transaction. Plan run [`34222052076`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34222052076)
first; the plan and the apply printed the same 417 / 175.

```
WROTE: 417 sales-order cities, 175 delivery-order headers.

DELIVERY ORDERS — headers to fill       175
  answered by the parent sales order    175
  answered by the book alone              0
  still with no phone and no address      0
    phone                    173      state             168
    address1                 173      customer_state    168
    address2                 173      postcode          168
    city                     158      emergency phone     1
```

175 rather than 173 because two further delivery orders were missing only a city.

### The verification — a FRESH connection, and values not counts

```
sales-order rows re-read              417 of 417
city is not the value planned           0
city the address master would refuse    0
delivery-order rows re-read           175 of 175
a field is not the value planned        0
a written field is not text             0
disagrees with its parent sales order   0
still no phone and no address           0
```

The address master is re-read on that second connection too: asserting a written
city against the map the writing session already held would only prove the write
agreed with itself.

### The control — nothing else moved

Read on the same fresh connection, before -> after:

| control | before | after |
| --- | --- | --- |
| sales-order documents | 2,883 | 2,883 |
| sales-order lines | 15,072 | 15,072 |
| sales-order quantity | 25,416 | 25,416 |
| sales-order total | 1,981,629,100 sen | 1,981,629,100 sen |
| sales-order paid | 1,038,468,600 sen | 1,038,468,600 sen |
| sales-order balance | 945,253,100 sen | 945,253,100 sen |
| delivery-order documents | 185 | 185 |
| delivery-order lines | 886 | 886 |
| delivery-order quantity | 1,330 | 1,330 |
| delivery-order total | 108,400,350 sen | 108,400,350 sen |
| inventory movements | 3,774 | 3,774 |
| inventory movement quantity | 7,360 | 7,360 |
| allocation READY / PENDING / PARTIAL | 1,974 / 13,087 / 11 | 1,974 / 13,087 / 11 |

`control rows moved: 0`. **A customer name is not a line, a quantity or an
amount, and none of them moved.**

---

## Before and after, against the AutoCount reconcile

| run | time | disagreements NOT covered by a declared design difference | field identity (SO+PO+DO, PROCEEDED) | SO verdict |
| --- | --- | --- | --- | --- |
| [`34221922832`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34221922832) | 19:40, **2 minutes before the apply** | **14** | 71 differ, 76 ERP-blank | 2,736 open / 146 locked |
| [`34222294313`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34222294313) | 19:44, **after the apply** | **14** | 71 differ, 76 ERP-blank | 2,736 open / 146 locked |

**Unmoved on every axis, which is the expected and the correct result.** `city`
is not in the reconcile's field-identity table at all — the book has no column to
compare it against — and the customer block on a delivery order is not a line, a
quantity or an amount.

**The brief's baseline of 21 is stale and the drop is not this lane's.** Measured
at the start of this work it was **17** ([`34220274598`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34220274598),
19:22), and it was already **14** at 19:33 and 19:40 — before anything here was
written. 17 -> 14 belongs to whichever lane applied in that window, not to this
one.

---

## After

Probe run [`34222237940`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34222237940) (19:44):

| | before | after |
| --- | --- | --- |
| delivery orders with no phone AND no address | **173** | **0** |
| delivery orders with a blank phone | 173 | 0 |
| delivery orders with a blank address1 | 173 | 0 |
| delivery orders with a blank city | 175 | 17 |
| sales orders with a blank city | 711 | 294 |
| of those, repairable | 417 | **0** |

`HC-DO-011556`, the document he sent: `phone=true addr=true` where it read
`phone=false addr=false`. `HC-SO-012565`: `city=true` where it read `city=false`,
so the banner will no longer name City on it.

### What is still blank, and why that is the right answer

- **294 sales orders have no city** and every one of them is a printed refusal:
  142 the book gives no postcode, 112 the book writes nothing after the postcode,
  40 the book writes something the address master does not list for that postcode
  (`KL`, `BM`, `JB`, and district-vs-locality disagreements like `KUALA LUMPUR`
  at 53300 where the master says Setapak). **The book has no city for these and
  we did not invent one.**
- **17 delivery orders have no city**, for exactly that reason on their parent.
  `HC-SO-013124` is one: the book writes no `InvAddr4` for it at all.
- **3 sales orders have no address and no phone**, and the book holds neither.
- **143 sales orders have no postcode.** Only 1 of them has a 5-digit postcode
  anywhere in the book's address, so there is no class here to repair — it is
  reported rather than worked.
- **Email and Customer Type stay blank everywhere.** See above.

---

## The owner's delivered-order ruling, and the line drawn against it

He ruled the same day 「已经出货了的就随便把 不去关注了 留个底记录而已 数据对不对
不重要了」 — for lines already delivered, do not spend effort on accuracy.
`SO-013124` is fully delivered, so **that ruling covers its DATA and this lane
reconciled none of it** — not one line, quantity, price or payment column on that
order or any other was read for correctness or written.

What was repaired is the PAPERWORK. **A delivery note with no phone and no
address is unusable as a document even when its figures do not matter**, and that
is what he was pointing at. The distinction is stated in the repair script's
header, in `docs/bugs/0714` and in `docs/modules/delivery-order.md`, so the next
person does not read this lane as a licence to reconcile delivered orders.

---

## What was NOT touched, deliberately

- **The ERP -> AutoCount write-back.** Owner 2026-09-08:
  「写回autocount的你不需要理了」. No outbox row was written and no AutoCount call
  was made. `scm.delivery_orders` carries only a BEFORE DELETE trigger, so a
  header UPDATE enqueues nothing.
- **Payment columns.** Out of scope, and none is in the field map.
- **`venue` / `venue_id` on the delivery order**, even though the live SO -> DO
  converter carries them: venue text is rewritten by a canonicalising trigger on
  write and a repair must not move a value it did not measure.
- **The importer's own derivation** at `import-ac-outstanding-so.mjs:308`. It
  runs only on a fresh cutover import, the population it would serve is already
  imported, and changing a one-shot importer that will not run again buys nothing
  while risking a re-import. If it is ever run again, replace those three lines
  with `cityFromBook`.

## What stops it recurring

`insertMigratedDo` now copies the block from the parent sales order in the same
transaction, folding the order's four address lines into the delivery order's two
the way `backend/src/scm/lib/so-to-do-fields.ts` does. Nothing is defaulted — a
field the order does not carry stays NULL. Pinned by
`backend/tests/migratedDoWriter.test.mjs`, proved RED against the unfixed file.

## Ledger

- `docs/bugs/0714-the-migrated-delivery-order-never-carried-a-customer-block-s.md`
- `docs/bugs/0715-subtracting-the-state-from-the-city-deleted-the-city-wheneve.md`

## Tools

| file | what it does |
| --- | --- |
| `backend/scripts/check-customer-block-gap.mjs` + `.github/workflows/check-customer-block-gap.yml` | READ-ONLY. Sizes both classes; prints every refusal with its reason |
| `backend/scripts/repair-customer-block.mjs` + `.github/workflows/repair-customer-block.yml` | plan by default; apply needs `CONFIRM="CARRY THE CUSTOMER BLOCK"`. **RE-RUN: inert** — every UPDATE requires its own column to be empty |
| `backend/scripts/lib/customer-block.mjs` | the city rule and the delivery-order field map, stated once |
