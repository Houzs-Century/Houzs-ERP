## A frozen write reads as an outage on every path that is not the vendored SCM client [medium]

**Symptom** - with the go-live write freeze ON, a refused write answered
"The service is briefly unavailable. Please try again in a moment." That is an
outage sentence for a deliberate business decision, and it instructs the person
to do the one thing the freeze exists to stop. The SCM pages did NOT show it -
they showed the operator's real explanation - and that asymmetry is what pointed
at the client rather than the server.

**Scope, measured rather than assumed.** Every SCM document write goes through
`vendor/scm/lib/authed-fetch.ts`, whose `humanApiError` reads `reason` and
therefore already showed the right sentence. The core `api/client.ts` makes
exactly ONE write to `/api/scm/*` today - `pages/Team.tsx:3243`, the
showroom-parking PATCH - so that is the only surface currently mis-reporting the
freeze. The bug is nonetheless worth fixing rather than noting: `api/client.ts`
is the DEFAULT client for anything not vendored from 2990, so every future SCM
write written outside the vendor layer inherits it, and the operator-message cap
below closes a hole that DOES hit the main SCM path.

**Root cause (traced, not guessed)** - `scm/lib/write-freeze.ts` returned the
explanation in a field called `reason` only. `authed-fetch.ts` `humanApiError`
reads `reason`; `api/client.ts` `humanHttpMessage` read only `error` / `message`
/ `detail`, and `write_frozen` is not in its `ERROR_CODE_MESSAGES`, so the
sentence was dropped and the generic 503 line spoke instead.

The second half is worse than the copy, and it is confined to the same client:
`isColdPool503` decides whether a MUTATION may be retried by regex-testing that
humanised message for "briefly unavailable | warming up | try again in a
moment". The generic 503 line contains two of them, so a frozen write on that
path was silently re-sent four more times over about ten seconds before the
operator was told anything - five refusals per press. (`authed-fetch` tests the
raw BODY instead of the humanised message, which is why it never retried a
freeze.)

The hole that DOES reach the SCM floor: both clients discard a server sentence
of 200 characters or more and fall back to their generic 5xx line. The freeze
message is operator-typed in `app_config.description`, so a long one would have
put "The system hit a problem. Please try again" in front of every SCM save.

**Fix** - the backend sends the same sentence in `message` AND `reason`, so
neither client can miss it, and `freezeMessage()` caps an operator-typed
description at the 200 characters both clients will render, falling back to a
default that says saving is paused, that nothing is broken, and that retrying
will not help. `humanHttpMessage` now also reads `reason`. The mutation retry
stops firing on a freeze as a CONSEQUENCE of the copy no longer containing the
cold-pool phrases, not as a second special case. `write_frozen` was deliberately
NOT added to `ERROR_CODE_MESSAGES` in either client: both maps are consulted
BEFORE the server sentence, so an entry there would override the operator's own
`app_config.description`, which is the entire purpose of that column.

**Lesson** - a refusal's wording is part of its contract. When retry logic keys
off humanised copy, a missing message field is not cosmetic: it changes what the
client DOES. And two error humanisers that read different fields will diverge
silently - the one you are not looking at is the one that is wrong.

**Ref** - fix/freeze-message-not-outage, 2026-08-11
