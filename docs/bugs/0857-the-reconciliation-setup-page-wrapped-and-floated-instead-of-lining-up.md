## The Reconciliation setup page wrapped and floated instead of lining up [low]

<!-- area: Frontend + mobile -->

**Symptom.** Seven blocks, each laid out its own way: tables whose columns
were never sized (so "310-0010" broke across two lines and "CSV · | ·
integer-sen" folded), a Headings cell holding one long run of text, a
statement edit form of loose label-and-input pairs floating under the table,
and the company's default bank and voucher letters as two flex strips with
their Save buttons wherever the wrap left them. Owner 2026-09-13: setup 的东西
很乱不整齐，就很多都会 wrap text，不然就是没有 column/table，看了很乱 → 做.

**Root cause.** The page grew a block at a time (the merchant matrix, then
the bank matrix, then the default bank, the numbering, the statements, the
rules), each with its own inline layout; nothing set column widths or kept a
code on one line.

**Fix.** `frontend/src/pages/scm-v2/SettlementSetup.tsx` with its module
`SettlementSetup.module.css`, layout only — every hook, label, button and
refusal is as it was:
- the per-company defaults (default bank, voucher numbering) sit in ONE card
  as two aligned rows — a label column and a content column — with the
  letters in a fixed grid, code on one line, name trimmed;
- the Bank statements and Bank recognition rules tables name their column
  widths (`table-layout: fixed`), codes and account numbers never wrap and
  are monospaced, and the headings a file names read as chips (the captions
  themselves on hover and under Edit);
- the statement edit form sits in its own frame: the file's identity on one
  row of seven equal fields, its headings on a row of eight, actions to the
  right; the merchant report-layout form takes the same frame and fixed rows.

Pinned by `frontend/src/pages/scm-v2/SettlementSetup.test.tsx` — unchanged:
every label, text and behaviour it reads is still there.

**Ref.** acc/settlement-setup-layout, 2026-09-13.
