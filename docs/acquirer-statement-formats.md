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
| MBB (Maybank terminal) | CSV | **line 16** — merchant + SUMMARY block above it | `05-Jun` — **no year** | `MDR` column, an amount | `INVOICE/AUTHO` ✓ |
| GHL | CSV | line 1 | `2026-06-02 18:38:24.0` | fee column, printed **negative** | `gateway_tx_id` — present but **unusable**, see below |
| PBB (2990 HOME) | CSV | line 1, every field quoted | `17062026` — DDMMYYYY, no separators | **gross − net** (see the trap below) | `Approval_code` ✓ |
| HLB | **encrypted PDF** | — | — | — | — · **cannot be read yet** |
| CIMB | — | — | — | — | not in use (owner, 2026-08-17) |

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
