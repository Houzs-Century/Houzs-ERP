## The feed page told operators to ask the portal owner for a secret the portal no longer needs [low]

**Symptom.** A Venture Portal delivery refused with `http 503` showed the row
with the instruction *"The portal has no secret configured. Ask the portal owner
to set it; then re-send."* — and a `401` showed *"The two secrets do not match.
Set the same value here and on the portal"*. Both sent the reader looking for
somebody else, or for a second place to type the same string. Neither was the
action that fixes it any more, so a refused delivery had no usable next step on
the one screen that exists to give it one. Nothing was broken in the delivery
path; the row was correctly pending, costing no attempts.

**Root cause (traced).** `vpRowTodo` in `frontend/src/lib/venturePortalFeed.ts`
branches on the error text and returns a sentence per refusal. Its 401 and 503
sentences were written against the portal's ORIGINAL auth: the receiver read
`ERP_SYNC_SECRET` from its Vercel environment, so a 503 genuinely was somebody
else's job and a 401 genuinely meant two hand-invented strings disagreed. The
portal's PRs #117 + #118 (merged 2026-09-13) replaced that with a key pasted on
the portal's own page and made the env var optional. The refusal CODES did not
change and neither did `classifyVpResponse`, so nothing failed, nothing was
logged, and no test covered the wording — the page simply kept giving advice for
a system that had been replaced. This is the class CLAUDE.md records as a stale
fact in an auto-loaded place: the sentence was true when written and nothing made
anybody re-read it.

Observed by reading the two sentences against the portal side's own hand-off
(`docs/HANDOFF-2026-09-13-venture-portal-api-key-and-seconds.md` §1, which states
the receiver now checks a pasted key and that `ERP_SYNC_SECRET` becomes
optional). LIKELY rather than PROVEN on the receiver's behaviour: its source is
in another repository and was not read from here.

**Fix.** Both sentences now name the action that is available on this screen, and
each says which side is empty — 401 is the portal holding a DIFFERENT key, 503 is
it holding NONE, and both end "Generate one here, paste it in the Venture Portal,
then re-send." Pinned in `frontend/src/lib/venturePortalFeed.test.ts` ("names what
to do about each kind of refusal", now asserting `different key` /
`no key of its own` plus `paste it in the Venture Portal`) and in
`frontend/src/mobile/mobileVenturePortalFeed.test.tsx`, which renders the row and
asserts the phrase reaches the phone. Proved RED on the unfixed tree: both
assertions were the old `/do not match/i` and `/Ask the portal owner to set it/i`
and failed against the new sentences before they were updated — the desktop
suite's failure is in this session's log.

`classifyVpResponse`, the taxonomy, the attempt accounting and the outbox are
untouched: what was wrong was the advice, not the handling.

**Ref.** feat/vp-feed-generated-key-and-seconds, 2026-09-13.
