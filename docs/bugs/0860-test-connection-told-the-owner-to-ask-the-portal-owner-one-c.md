## Test connection told the owner to ask the portal owner, one commit after the queue row was taught to say generate and paste [medium]

**Symptom.** On the Venture Portal Feed page, pressing **Test connection** when the
portal held no key (or a different one) answered *"The portal has no secret of its
own set yet. Ask the portal owner to set it."* — while a failed row three
centimetres below it on the same screen said *"Generate one here, paste it in the
Venture Portal, then re-send."* Two places, same condition, opposite instructions,
and the wrong one is on the button somebody presses FIRST: **Test connection** is
step 3 of turning the feed on, immediately after Generate. The owner would have
generated a key, pressed Test, and been told to go and ask somebody else about a
Vercel environment variable that is no longer required.

Nothing was broken. The probe was correct, the 503 was correct, the queue lost
nothing. Only the sentence was wrong.

**Root cause (traced).** `docs/bugs/0859-…` corrected `vpRowTodo`'s 401 and 503
advice in `frontend/src/lib/venturePortalFeed.ts` after the portal started reading
a key pasted on its own page (its PRs #117 + #118). The SAME two sentences exist a
second time in the same file, inside `useVpActions`' `probe` action, and they were
not touched. The reason they were missed is structural rather than careless:
`vpRowTodo` is an exported pure function with a test, and the probe's verdict was
an inline closure inside a hook — the one operator sentence in this file that no
test could reach. A file-wide sweep for the same class was never done, which is
the omission; CLAUDE.md names this class directly ("fixing a rule on one surface
and not the other").

Observed by verifying PRODUCTION rather than trusting the deploy. After #3773
shipped, the live bundle at `https://erp.houzscentury.com` was fetched and grepped
for the strings the PR was supposed to have removed:

```
curl -s https://erp.houzscentury.com/assets3/venturePortalFeed-C6odiwLs.js
```

"At least 32 characters", "Replace secret" and "Save secret" were gone as
expected — and "Ask the portal owner to set it" was **still present**. That
contradiction is what found it. A green deploy and 48 passing tests both said the
change was complete.

**Fix.** The probe's verdict is extracted as an exported pure function
`vpProbeNote(res: VpProbeResult): VpNote`, so it is testable like every other
sentence in that layer, and both refusals now give the action that is available on
the screen: 401 is "the portal is holding a different key", 503 is "the portal has
no key of its own yet", and both end "Generate one here and paste it in the Venture
Portal, then test again."

The durable half is a DRIFT GUARD, not the corrected string: a test in
`frontend/src/lib/venturePortalFeed.test.ts` ("gives a queue row and the connection
test the same next step") asserts `vpRowTodo` and `vpProbeNote` produce the same
diagnosis and the same action for 401 and for 503, so correcting either alone fails
instead of shipping. Four more tests cover the probe's other answers, which had
none at all.

Proved RED on the unfixed tree: the desktop render test's existing assertion
`/refused the secret/i` failed against the new sentence
(`TestingLibraryElementError: Unable to find an element with the text: /refused the
secret/i`) before it was updated, and the updated assertion had to be narrowed to
`/different key.*then test again/i` because the failed row on the same screen now
matches `/different key/` too — which is the guard working.

**Lesson.** A sentence that lives inside a hook is a sentence no test can read.
The 0859 fix and this one are the same defect, and the second half survived
because only one of the two homes was reachable by a test. When correcting
operator copy, grep the file for the condition, not for the string you remember.

**Ref.** fix/vp-feed-probe-says-ask-someone-else, 2026-09-13. Follows
`docs/bugs/0859-the-feed-page-told-operators-to-ask-the-portal-owner-for-a-s.md`,
shipped in #3773.
