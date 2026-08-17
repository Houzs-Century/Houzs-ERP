# Acquirer statement formats — what the real files actually look like

> This is 决定4, filled in from the owner's OWN exports rather than from asking.
> Everything here was read off real files on 2026-08-17. The parser
> (`backend/src/acc/settlement-parse.ts`) is driven entirely by
> `scm.acc_acquirer_config`, so this document IS the configuration — nothing
> below is hardcoded anywhere.
>
> **The formats are not the same between acquirers.** Three files, three shapes.
> That is exactly why the config is per-acquirer and taught ONCE, then shared by
> every company (the owner's standing principle).

## What is set up

| Acquirer | Format | Headings on | Date written as | Fee given as | Unique ref |
|---|---|---|---|---|---|
| HLB (Hong Leong terminal) | CSV | **searched for** — merchant + SUMMARY blocks above, and repeated per terminal | `16-Aug` — **no year** | `MDR` column, an amount | `INVOICE/AUTHO` ✓ |
| GHL | CSV | line 1 | `2026-06-02 18:38:24.0` | fee column, printed **negative** | `gateway_tx_id` — present but **unusable**, see below |
| PBB (2990 HOME) | CSV | line 1, every field quoted | `17062026` — DDMMYYYY, no separators | **gross − net** (see the trap below) | `Approval_code` ✓ |
| AEON (instalment) | XLSX → CSV in the page | searched for | `14/08/2026` | fee column printed **negative**, PLUS a statement-level subvention fee (handled) | `APP. CODE` ✓ |
| MBB (Maybank terminal) | **encrypted PDF** — reader built, not yet wired | searched for | `14/06/26` | none per line; MDR stated once in TOTAL | `Auth Code` ✓ |
| CIMB | — | — | — | — | not in use (owner, 2026-08-17) |

### ⚠️ The file labelled "MBB (1).CSV" is a HONG LEONG statement

Three things say so, and nothing says otherwise:

1. It is byte-for-byte the same layout as `HLBB Merchant.CSV` — MERCHANT NO /
   SUMMARY / TERMINAL ID / `DATE,BATCH,INVOICE/AUTHO,…` — and parses correctly
   with the identical config.
2. It classifies its sales as **`HLB CARD` vs `NON-HLB CARDS`**, a distinction
   only Hong Leong's own acquiring makes.
3. Its merchant number is `00004879219`. Maybank's own merchant numbers, read
   off the Maybank account report, look like `32410011`, `32259046`, `32409997`
   — a different numbering scheme entirely.

So the Hong Leong layout above is confirmed by two files, and **Maybank's
merchant statement has not actually been seen yet**. MBB is configured with the
same layout provisionally so it is not left blank, but it needs its own file
before it can be trusted. → *Owner to confirm and send a real Maybank merchant
statement.*

Column mappings live in `acc_acquirer_config.column_map` and are editable from
the Acquirer setup tab; the demo rig
(`backend/scripts/settlement-demo-server.ts`) carries the same values.

## The three traps these files contain

**1. PBB's `MDR` column is a RATE, not an amount.** It reads `0.85`, meaning
0.85% — the actual charge on a RM 945.00 sale is RM 8.03. Configured as a
stated fee it books RM 3.05 of merchant charges against a real cost of
RM 95.56 per statement: the understated-profit disease this whole layer exists
to cure, walked back in through a config field. The parser now checks its own
arithmetic whenever the file also prints its net, and refuses the upload with
both numbers named. Use **gross minus net** for PBB.

**2. MBB's dates carry no year at all.** The statement is refused until the
operator picks the month it covers. Nothing guesses which year money belongs to.

**3. GHL has a unique id that cannot be used.** `gateway_tx_id` is right there in
the export — but the owner confirmed (2026-08-17) that the code captured at the
till is NOT that id, so there is nothing shared to match on. GHL therefore
matches on amount + date only and **never auto-confirms**, which is where 系统3
ended up, but now for a reason on the record rather than an assumption.
→ *Open improvement:* capture GHL's gateway id at the point of sale and GHL
becomes auto-matchable. That is a sales-module change and the owner's call.

## AEON — the charge that belongs to no transaction

AEON's report is **XLSX**, which the page flattens to CSV before upload using
the SheetJS the app already ships — no new dependency, no second parser. Its
layout is straightforward: a merchant/address preamble, then
`DATE, TRANSACTION DESCRIPTION, CARD TYPE, IPP PLAN, IF, CARD NUMBER, APP. CODE,
GROSS AMOUNT (RM), MDR %, MDR AMOUNT (RM), NET AMOUNT (RM)`, with a real
approval code and a fee printed negative.

**What matters is the bottom of the file:**

```
sale                gross 6,000.00   MDR 1.2%  −72.00   net 5,928.00
SUBVENTION FEE :                              −254.16
TOTAL NET PAYMENT (RM) :                       5,673.84
```

The subvention fee is charged against the STATEMENT, not against any
transaction. Book the lines and the bank receives 5,673.84 while the books say
5,928.00 — **RM 254.16 stranded in 320-0000 on every AEON statement, for ever.**
It is also 3.5× the fee the transaction line shows: the true cost of that
instalment sale is 326.16 on 6,000.00 = **5.4%**, not 1.2%.

**This is built (migration 0303).** The config carries `total_net_label` — the
row on which a statement states what it is really paying — and the parser
measures the difference instead of spreading it across lines that did not incur
it. The batch records `stated_net_sen` and `adjustment_sen`, and confirming the
batch posts the charge as its own entry, source `SETTLEADJ`, keyed on the batch
so it books once.

**It posts against the BANK, not against settlement-in-transit.** The
transaction lines already clear in-transit by their gross, correctly; what the
statement kept is money that never arrived:

```
   the transaction line     Dr bank 5,928.00  Dr fee    72.00  Cr in-transit 6,000.00
   the statement charge     Dr fee    254.16                   Cr bank         254.16
   ------------------------------------------------------------------------------
   bank ends at 5,673.84 (what AEON paid)    fee ends at 326.16 (the real cost)
```

A negative adjustment — a statement that paid MORE than its lines — books the
other way round. A statement that pays exactly what its lines come to, which is
every other acquirer here, books nothing at all.

Proved on the owner's own AEON export end to end: 1 transaction matched on its
approval code, `JE-…-0014` for the settlement, `JE-…-0015` for the charge, bank
landing on RM 5,673.84 to the sen.

AEON also settles into **Maybank 564418610346** (the file names the bank and
account itself), and its merchant id `000458030215369` is exactly the
`MA458030215369` reference the Maybank account report carries — so its bank-side
rule is already known.

## MBB — the file received is the INSTALMENT report, not the settlement report

`027012896718_EP41_713_20260614.PDF` decodes to:

```
MAYBANK — INTEREST FREE INSTALLMENT SCHEME TRANSACTIONS
REPORT NO: EP41       MERCHANT NO: 027012896718      2990 HOME SDN. BHD.
Card Number | Amount | Tran Date | Auth Code | Reference No | Terminal No | Card Type | EzyPay Term | Interchange Fee
…3631       | 3,240.00 | 14/06/26 | 009069  | 43290646     |             | AMEX CRMAYBANK | 06 | 19.44
TOTAL         3,240.00                                              MDR 97.20   NET 3,142.80   items 1   interchange 19.44
```

It is readable — the PDF is encrypted but opens without a password, and its text
is obfuscated by writing each glyph two bytes wide and shifting the character by
29, which is reversible. So a PDF path is *possible* for Maybank.

But two things say wait:

1. **This is report EP41 — EzyPay instalment transactions only.** It carries one
   transaction. Ordinary card settlement is a different report, and that is the
   one reconciliation needs.
2. **HLB's portal turned out to have a CSV export.** Maybank's very likely does
   too, and a CSV is worth far more than a PDF reader that breaks the first time
   the bank adjusts a column.

**Correction (owner, 2026-08-17): this IS Maybank's card-machine report.** The
earlier reading of it — "instalment only, so MBB reconciles at layer 4" — was
wrong, and decoding the whole document rather than its first page shows why: the
report carries the full daily settlement structure. A transaction table (Card
Number, Amount, Tran Date, Auth Code, Reference No, Terminal No, Card Type,
EzyPay Term, Interchange Fee), then TOTAL DEBIT / CREDIT, ITEMS WITHHELD, ITEMS
REJECTED, then a breakdown across **every** card type Maybank acquires — VISA /
MC / AMEX / MYDEBIT / UPI, each split Maybank-issued vs local vs foreign — and
a TOTAL line carrying gross, MDR and net. On 14/06 that merchant happened to
take one EzyPay transaction, so every other card-type row reads 0.00. The title
is the section heading, not the scope of the report.

**So MBB belongs at layer 3 like the rest, and it matters more than any of
them**: RM 251,840 settled into one Maybank account in the first half of August
across eight merchant numbers, with the fee already deducted before the money
arrives. Without this report those fees are invisible.

`backend/src/acc/settlement-pdf.ts` is the reader. It decrypts (RC4-128 or
AES-128, empty user password, refusing by name a file that genuinely needs one),
inflates, reverses the producer's obfuscation — each glyph written two bytes
wide with the character shifted by a constant, DETECTED rather than hardcoded by
scoring candidate decodings — and lays the positioned text out as a table,
assigning each cell to the column it was PRINTED in. That last part is not
cosmetic: a PDF writes nothing for a blank cell, and Maybank's Terminal No is
blank, so reading cells in sequence slides the card type into the terminal
column and every mapped column after it reads its neighbour.

**It is deliberately NOT wired into upload yet.** The one statement available
carries a single transaction, and this page holds TWO tables side by side — the
address block and card-type summary share y-rows with each other, so a flat
grid interleaves them. One row cannot prove a table extractor. → **Needed: a
busy Maybank statement (a day with a dozen or more transactions).** With that,
the detail table can be isolated properly and MBB joins the others.

Its shape is already clear: gross per line from the detail table, no per-line
fee at all (only `Interchange Fee`), and the MDR stated once in the TOTAL row —
so `prorated-summary` is the fee method, with the statement total read from the
file rather than typed.

**And a real accounting point falls out of this report.** Instalment sales cost
much more than ordinary ones: MDR 97.20 on 3,240.00 is **3%**, against the
0.6–0.9% the same merchants pay on a straight swipe, plus a separately-stated
interchange fee of 19.44. If instalment sales are booked at the ordinary fee
rate the margin on them is overstated. The ERP already distinguishes an
`installment` payment method, so the data to get this right exists — the
acquirer config is what has to carry the different fee, and today it carries one
fee method per acquirer, not one per product type. Worth deciding before phase 5.

## HLB — waiting on the CSV

`1174355096_20260816.pdf` is a **password-protected PDF** (standard security
handler, R3/RC4-128, a user password is required to open it), so that file is a
dead end. The owner confirmed on 2026-08-17 that **HLB's merchant portal does
offer a CSV export** — that is the route. Once one arrives HLB is a config row
like the others: format, headings, fee method, unique-ref flag, and it is taught
once for every company.

The PDF path (password + a PDF table reader, with layouts that break between
statement versions) is therefore not needed and should stay unbuilt.

Until the CSV arrives HLB uploads are refused by name ("configured to send PDF
statements, which this screen cannot read yet"), which is the correct behaviour
— not a silent empty batch.

## Bank-side recognition rules (for layer 4, phase 4)

The brief is explicit that every acquirer's "how do I recognise this money on
the bank statement" rule must be written at the SAME time as the acquirer —
系统3 had four acquirers and only two rules, so two acquirers' money showed as
永远收不到 forever. Recorded now, from the real Hong Leong account statement of
2990 HOME (account 23600602788), 01–23 June 2026:

| Acquirer | Appears in the bank statement as | Seen |
|---|---|---|
| PBB | Sender `PBB-PBCS AC 3`, remark `Cr Adv-Interbank GIRO`, reference `YYYYMMDD########` | 5 credits, RM 31,835.06 |
| HLB | **Blank sender**, remark `CA Credit Advice`, reference `<merchant no> MERCHANT <YYYYMMDD>` | 2 credits, RM 9,049.93 |

**Why HLB's money looks different from PBB's, and why the blank sender is not a
defect.** A *credit advice* is simply the bank telling the account holder money
has been paid in; `CA` is the current account it landed in. PBB's settlement
travels from another bank, so it arrives as an INTERBANK GIRO credit advice and
carries a sender name. HLB's card machine settles from Hong Leong into a Hong
Leong account — the money never leaves the bank, so there is no interbank leg
and no sender to name. What identifies it instead is the reference, which the
statement splits across two fields and which reassembles to
`00005992235  MERCHANT 20260616` — merchant number, the word MERCHANT, and the
TRADING DATE being settled (not the payout date).

That makes HLB's rule: *blank sender + remark `CA Credit Advice` + a reference
containing `MERCHANT` and the merchant number.* Both credits landed together on
18/06 at 14:36, one for each of two trading days:

| Trading day (from the reference) | Credited | Amount |
|---|---|---|
| 2026-06-16 | 18/06 14:36 | RM 7,261.65 |
| 2026-06-17 | 18/06 14:36 | RM 1,788.28 |

→ **The check to run when HLB's CSV arrives:** its net for 16/06 should be
RM 7,261.65 and for 17/06 RM 1,788.28. If they agree, HLB is proven end to end
the same way PBB already is.

### The Maybank current account (Houzs Century, 0000564418610346)

Read off `ACCOUNTACTIVITYREPORT_564418610346.csv`, 01–15 Aug 2026. This file is
**pipe-delimited**, its amounts are integer sen zero-padded to 15 digits, and
CR/DR is its own column — nothing like the Hong Leong statement. Layer 4 will
need a delimiter setting; layer 3 does not, so it is noted, not built.

| Money stream | Recognised by | Shape |
|---|---|---|
| MBB credit card settlement | `CR/CARD SALES MN <merchant> DATED <DDMMYYYY>` | net credited |
| MBB **debit** card settlement | `DR/CARD SALES M/N <merchant> DATED <DDMMYYYY>` | **gross credited, fee taken as a SEPARATE `BCHARGE` debit** |
| PBB settlement | `03999061714  PBB-PBCS AC 3` | net credited |
| AEON instalment financing | `Book Transfer Third AEON CREDIT SERVICE`, ref `MA…` | net credited |
| Cash deposits | `CDM CASH DEPOSIT` | — |
| Own-bank transfers | `MBB TO HLBB BANK`, ref `MPV-…` | — |

Two of these need the owner's answer before layer 4:

- **MBB debit card does not net its fee.** RM 875.00 arrives as a credit and
  RM 3.94 leaves as a separate `BCHARGE` debit on the same reference. An
  acquirer whose fee is charged separately rather than deducted is a fourth fee
  shape, and the current `fee_method` list has no name for it. Whether Maybank's
  own merchant statement presents it netted is unknown until that file arrives.
- **AEON CREDIT SERVICE is a money stream nobody has mentioned.** Instalment
  financing paying in by book transfer, dozens of credits in two weeks. Does the
  ERP record those sales as payments at all? If it does, they need reconciling
  like any acquirer; if it does not, that money reaches the bank with nothing
  behind it in the books.

**The loop closes on real money.** The PBB settlement file for 2990 HOME lists 4
card transactions on 17/06 netting **RM 11,814.44**; the Hong Leong account
shows a credit of **RM 11,814.44** from `PBB-PBCS AC 3` on 18/06. Swipe →
settlement-in-transit → bank, proven end to end on the owner's own documents.

⚠️ And note the naming trap the brief warns about, which happened here in real
life: the file called "HLBB transaction statement" is the **Hong Leong bank
account**, not the HLB card machine. They are two different things and the
master data keeps them apart — `acc_company_acquirers.bank_account_code` is
where they meet, and nowhere else.

## Which bank account each acquirer pays into

| Company | Acquirer | Lands in |
|---|---|---|
| 2990 HOME SDN BHD | PBB | Hong Leong current 23600602788 |
| 2990 HOME SDN BHD | HLB | Hong Leong current 23600602788 |

Both read OFF THE BANK STATEMENT rather than asked — which is the cheap way to
answer this for every other company too: one bank statement per company names
every acquirer paying into it, and the amounts prove the link.

Still open for the other companies. This is the one column of 决定4 that no
acquirer statement can answer, because the acquirer's own file never says where
it sent the money.

## The formats do not vary by company

Owner, 2026-08-17: the other companies' statements are the same shapes as the
ones above. That is the whole point of the config being GLOBAL — adding a
company is not a re-teaching exercise, it is:

1. tick which acquirers that company uses (`acc_company_acquirers`), and
2. name the bank account each one's money lands in.

Nothing about how a statement is READ is ever configured twice.
