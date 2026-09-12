## The payment advice had two doors and took one file at a time [low]

<!-- area: Accounting + GL -->

**Symptom.** Public Bank's IBG payment advice could be uploaded from a
"Payment advice" tab on BOTH the Merchant reconciliation screen and the Bank
statement reconciliation screen — the same tab, the same table, but to the
person holding the PDF it read as two uploads and a question of which one is
right (owner 2026-09-12: merchant recon 有，bank recon 也有). And the picker
took one PDF at a time, so a month of advices was a month of round trips
(好像一次只能 upload 一个). Owner: merchant reconciliation 那边上传就好，bank
statement reconciliation 的 payment advice 拿掉，然后要支持上传多份.

**Root cause.** Two mounts of one component (`PayoutAdviceTab`) after the
2026-08-24 decision that the advice belongs with the card merchants; a
single-file input by design because one advice covers several days.

**Fix.** The tab now lives on the Merchant reconciliation screen only —
`frontend/src/pages/scm-v2/BankRecon.tsx` drops its "Payment advice" tab (the
bank credit still matches itself there once every day of the advice agrees).
`frontend/src/pages/scm-v2/PayoutAdviceTab.tsx` takes several PDFs in one
pick: each is read as base64 and sent on its own, in the order picked, and
answered on its own line — a refused file says so under its own name and the
others still say what was read.

Pinned by `frontend/src/pages/scm-v2/PayoutAdviceTab.test.tsx` (three picked
together go up one by one, in order; the refused one on its own line; the
input is `multiple`) and `frontend/src/pages/scm-v2/BankRecon.test.tsx` (no
"Payment advice" on the bank screen).

**Ref.** fix/advice-merchant-only-multi, 2026-09-12.
