## Every amendment notice went to the owner, through the door the wildcard exclusion had locked [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** Amendment notices shipped 2026-09-03 and were meant to reach the
desk that has to sign. Six days later every single one of the nine notices in
prod had gone to the owner as well:

| notice | audience |
|---|---|
| `PO … /A1 needs confirmation` (×4) | `[1, 4, 5, 83]` |
| `SO-2606-011/A1 needs approval` | `[1, 4, 5, 87, 88, 142]` |
| `SO-2608-020/A3 needs approval` | `[1, 4, 5, 83, 84]` |

`1` = HOUZS CENTURY (Owner), `4` = Lim, `5` = Nico — on all of them, whether or
not the work was theirs.

**Root cause (traced).** `permissionHolders.ts` excludes the `*` wildcard on
purpose, precisely so the owner does not appear on every amendment ever raised.
That exclusion was real and it worked. It was then undone one function later:
`withUpline` in `services/amendmentNotify.ts` expanded each approver UP their
`manager_id` chain to the root, and in this org every purchasing and logistics
desk chains through the same two people to the Owner account — `Purchaser -> Nico
-> Lim -> HOUZS CENTURY`. So the front door was locked and the audience walked in
the back. Confirmed against prod: `SELECT target_user_ids FROM announcements
WHERE source IN ('so_amendment','po_amendment')` returned `[1, 4, 5, …]` for
every approver row, and the `users.manager_id` chain for ids 83/84/87/88/142
resolves to exactly that trio.

What makes this worth an entry rather than a tweak: the failure mode was named
in the module's own header before it happened — *"a channel that pings you about
work that is not yours is a channel you turn off, and then the real notice is
lost too."* The guard was written, and a second mechanism in the same file
routed around it. A rule enforced in one place and undone in the next is not a
rule.

**Fix.** `withUpline` now drops the top `UPLINE_TOP_LEVELS_EXCLUDED` (2) levels
of each chain (owner ruling 2026-09-09): the desk keeps it, their manager keeps
it, the two above do not. Trimmed by DEPTH, never by naming ids, so it survives
the org chart moving; the seed is never trimmed, so an approver reporting
straight to the top still hears about the thing only they can sign.

Proved RED on the unfixed tree: reverting the trim alone fails three tests in
`amendmentNotify.test.ts`, with the prod shape in the assertion output —
`expected [ 38, 39, 40, 41 ] to deeply equal [ 40, 41 ]`, and
`expected [ 41, 39, 38 ] to deeply equal [ 41 ]` for the case where the
requester is excluded but the chain top still rides along. Green after. The
mock chain was deepened to prod's real four-link shape so the assertions mean
something.

**Ref.** fix/amendment-notice-upline-trim-0909, 2026-09-09.
