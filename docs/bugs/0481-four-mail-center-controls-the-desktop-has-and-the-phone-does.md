## Four Mail Center controls the desktop has and the phone does not [medium]

<!-- area: Mail, search, notifications -->

**What staff could not do from a phone.** Attach anything — so the site photo
that is the whole point of carrying a camera had to wait until someone was at a
desk. Copy a colleague on a customer reply. Hand a conversation to whoever
should answer it. And find the conversations they had themselves tagged
"Urgent": the phone could PUT the label on and then had no way to list the
threads carrying it.

**Same root cause as entry 0463, four more instances of it.** `MobileMailCenter.tsx`
is the phone twin of `frontend/src/pages/MailCenter/`, and where desktop imports
a shared rule the phone had re-implemented the screen without one. None of the
four is a form-factor decision — a file picker, two text fields, a dropdown and
a chip strip are all ordinary phone controls — and the backend already accepted
every one of the payloads.

| | desktop | the phone, before |
|---|---|---|
| attachments | `attachments: [{ filename, contentBase64 }]` on compose AND reply, validated by `mail-attachments.ts` (10 files / 5 MB / images+PDF) | no key, no picker, no import |
| Cc / Bcc | `...(ccList.length ? { cc: ccList } : {})`, fields behind a "Cc / Bcc" toggle (`Compose.tsx`) | neither field, neither key |
| assign | `patchThreadAssignment(id, assignedToUserId, assignedToName)` behind an Assign-to picker (`Thread.tsx`) | both fields in its `Thread` type; never rendered, never written |
| list by label | `if (labelFilter) p.set("label", labelFilter)` (`Inbox.tsx`), served at `mail-center.ts` `LOWER(labels) LIKE ?` | the query builder only ever set status / starred / sent / mailbox / q |

**And a fifth, small one, in the same code.** Applying a brand-new label posted
`{ name, color: "#16695f" }`. `normalizeColor` on the backend maps anything
outside its nine-entry allow-list to `#6B5C32`, and that teal is not on the
list — so the label came back a different colour than the phone had just shown
while creating it. The phone also kept a private five-name colour table
(`Sales`/`Supplier`/`Finance`/`Urgent`/`Service`) that desktop does not have, so
an uncatalogued label was red on one surface and brown on the other.

**Fixed by importing, never by copying — and one duplicate was removed on the
way.** `humanSize`, `readFileAsBase64` and the whole pick → read → validate
pipeline existed as BYTE-IDENTICAL copies in `Compose.tsx` and `Thread.tsx`;
adding a third copy for the phone is how those two would have drifted next. They
now live in `frontend/src/pages/MailCenter/mail-attach-files.ts` and all three
surfaces call `pickMailAttachments`. `parseRecipients` / `firstInvalid` moved to
`mail-recipients.ts` the same way, so the phone names the bad Cc address in the
same sentence desktop does instead of posting it and waiting for a 400. Labels
now come from `mail-labels.ts` (`labelColorMap`, `colorForLabel`, `chipStyle`,
`LABEL_PALETTE[0]`) on both surfaces. **No backend change** — every route
already accepted what the phone was not sending.

**Why CI never caught any of it.** `MobileMailCenter.test.tsx` covered
pagination and search until entry 0463 added compose and reply. Nothing
exercised an attachment, a copied recipient, an assignment or a label query, so
there was no assertion to go red. Eleven tests now do, and each was proved
failing against the unfixed tree first: three could not find a label with the
text `Attach images or PDF files`, two could not find a `Cc / Bcc` button,
three could not find a label with the text `Assign to`, two could not find a
button named `Urgent`, and the colour one read
`expected '#16695f' to be '#6B5C32'`.

**Ref.** branch `fix/mobile-mail-parity-2`, 2026-08-21.
