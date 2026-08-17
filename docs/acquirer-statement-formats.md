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

## HLB — not readable yet

`1174355096_20260816.pdf` is a **password-protected PDF** (standard security
handler, R3/RC4-128, a user password is required to open it). Two ways forward,
in order of preference:

1. **Export CSV from HLB's merchant portal** if it offers one — then HLB is a
   config row like the others and costs nothing.
2. If HLB is PDF-only: this needs the password AND a PDF table reader, and PDF
   table layouts break between statement versions. Real work, and the fragile
   path. Worth confirming (1) is impossible first.

Until then HLB uploads are refused by name ("configured to send PDF statements,
which this screen cannot read yet"), which is the correct behaviour — not a
silent empty batch.

## Bank-side recognition rules (for layer 4, phase 4)

The brief is explicit that every acquirer's "how do I recognise this money on
the bank statement" rule must be written at the SAME time as the acquirer —
系统3 had four acquirers and only two rules, so two acquirers' money showed as
永远收不到 forever. Recorded now, from the real Hong Leong account statement of
2990 HOME (account 23600602788), 01–23 June 2026:

| Acquirer | Appears in the bank statement as | Seen |
|---|---|---|
| PBB | Sender `PBB-PBCS AC 3`, remark `Cr Adv-Interbank GIRO` | 5 credits, RM 31,835.06 |
| *(unidentified)* | blank sender, remark `CA Credit Advice` | 2 credits, RM 9,049.93 — **ask the owner whose these are** |

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

For 2990 HOME, PBB settles into the **Hong Leong** current account
(23600602788) — read off the bank statement, not asked. The same question is
still open for the other companies and the other acquirers; it is the one column
of 决定4 that no statement file answers, because only the owner knows it.
