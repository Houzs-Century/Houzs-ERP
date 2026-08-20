## The phone re-implemented three Mail Center rules the desktop imports from a shared module [high]

<!-- area: Mail, search, notifications -->

**What staff saw.** Three separate complaints, one cause. "Reply all" on the
phone answered ONE person on a mail that had copied four. Someone holding
`finance@`, `hr@` and their own mailbox composed from `finance@` every time
without noticing. And when the system's invoice email to a customer FAILED,
nobody on the road could see it — they told the customer it had been sent.

**One root cause, three symptoms: mobile re-implemented what desktop imports.**
`frontend/src/mobile/MobileMailCenter.tsx` is the phone twin of
`frontend/src/pages/MailCenter/`. Where desktop calls a shared module, mobile
had written its own version of the same rule — and each copy was missing the
half that had been fixed on desktop after the owner reported it.

| | desktop | mobile, before |
|---|---|---|
| reply-all | posts `{ text, ...(replyAll ? { replyAll: true } : {}) }` (`Thread.tsx`) | posted `{ text, fromAddress }` — no `replyAll` key on any path |
| compose From | `ownAlias \|\| pickDefaultFromAddress(activeAddresses, user)` (`Compose.tsx`, `mail-from-default.ts`) | `addresses[0]?.address` |
| auto-sent log | "Auto-sent" folder over `fetchOutbox` / `fetchOutboxDetail` (`Inbox.tsx`, `mail-actions.ts`) | folder list was a fixed six entries; the folder did not exist |

**Why each one is silent, which is what makes them expensive.**

1. **Reply-all.** `backend/src/routes/mail-center.ts` rebuilds Cc from the
   newest inbound message's To + Cc **only when it sees `replyAll`**. Without
   the key `ccList` stays empty and the reply goes to the last inbound sender
   alone. The button was on screen and did nothing different from "Reply".
   This is the SAME bug the owner reported on 2026-08-03 (*"然后那些人回复我的
   话，我要怎么回复他?"*) — it was fixed on desktop then, and mobile was never
   part of that fix.
2. **From default.** `GET /api/mail-center/addresses` is `ORDER BY address ASC`,
   so `addresses[0]` is the **alphabetically** first mailbox, never a personal
   one. `mail-from-default.ts` exists precisely so both surfaces share the real
   rule (assignedUserId → exact login email → local-part); its own header says
   so. Mobile never imported it.
3. **Alias-only members could not send at all.** Desktop splices
   `users.email_alias` into the From list as "My email". `getMailScope` builds
   `addresses` only from `email_addresses` rows, so a member whose only sending
   identity is their alias gets `[]` — the backend's `canSendFrom` would have
   accepted the alias, but the phone never offered it and dead-ended on "Choose
   a mailbox to send from."

**The fix.** Mobile now imports the same modules desktop does — no logic was
re-derived. `replyAll` is threaded from the thread footer through `MailReply` as
a REQUIRED prop, and `defaultFrom` is a REQUIRED prop on `MailCompose`: an
optional one would let a caller silently fall back to `addresses[0]`, which is
the defect. Backend untouched — all three were client-side payload/UI.

**Why CI never caught any of it.** `MobileMailCenter.test.tsx` covered
pagination and search only. Nothing exercised compose, reply, the From default
or the outbox, so there was no assertion to go red. Eight tests now cover them,
each proven failing against the unfixed tree first: reply-all posted
`undefined` where `true` was expected, the From default resolved
`finance@houzs.test` instead of `zoe@houzs.test`, the alias-only member's picker
held only a blank "No mailbox available" option, and "Auto-sent" was not a
button on the screen.

**Ref.** PR #2556 (2026-08-20), branch `fix/mobile-mail-parity`.
