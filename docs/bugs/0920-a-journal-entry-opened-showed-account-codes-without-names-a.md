## A journal entry opened showed account codes without names, a manual journal could not be copied, and its account could not be typed to [low]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15, opening his June salary journal
(2990-JE-2606-0163, ten lines): 「manual journal 数字，account name 都没有，然后
没有办法 copy」— the lines read `900-S100`, `410-0010`, code alone; the July
salary journal meant keying the ten lines again; and, drafting one, 「无法快速
打关键字眼找 account」— a dropdown of 361 accounts, scrolled through. On the
names: 「code 一行，name 一行，接下来有显示资料的都是这样的」.

**Root cause (traced).** `JeDetailCard` in `Accounting.tsx` printed
`l.account_code` and nothing else; nothing on the page could seed the draft
form from an entry; `NewJournalForm` picked the account with a native
`<select>` over every postable account. (The header also printed the entry
date twice.)

**Fix.** The two cards move into
`frontend/src/pages/scm-v2/JournalEntryCards.tsx`, with the styles and the
small helpers they share.

- `AccountCell`: the code on one line, the name on the next — the way an
  account reads on every screen from now on; the names come off the chart
  the page already loads (`useAccounts`).
- **Copy** on a manual journal's card: `seedFromEntry` carries the
  narration, and every line's account, debit, credit and note (`senToRm`
  turns sen back into the form's RM), never the date — the form opens as a
  new draft dated today, marked "copied — check the date, the figures and the
  notes before saving"; Save draft is the same call as always. Copy never
  posts. A second Copy starts a fresh form (the form is keyed by the seed).
- The account box is `SearchCombo` (the voucher and bill forms' own): every
  word typed must match the code or the name.

Proved RED on main's source (the module absent): `JournalEntryCards.test.tsx`
could not import. Green after.

**Ref.** acc/je-names-and-copy, 2026-09-15.
