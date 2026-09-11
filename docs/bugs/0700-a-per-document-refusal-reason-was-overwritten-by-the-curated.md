## A per-document refusal reason was overwritten by the curated class sentence [medium]

**Symptom.** Latent, and caught by a test written before it could be seen. From
the moment the migrated-sales-order lock started refusing PER DOCUMENT
(`verdict:<companies>`, 2026-09-08), a salesperson saving a migrated order that
still differs from the account book would have been told:

> This order came from AutoCount, so it is view-only until its payments are
> reconciled. A new order saves normally. Ask IT if this one has to change today.

The server had sent something else entirely — *"HC-SO-010789 still differs from
the AutoCount book on: document total. It opens by itself once that is
corrected."* — and it was discarded before anything rendered it. The operator
would have got a shut order, a reason that is no longer even true (payments are
not what shuts it any more), and nothing to act on. That is the
"the button does nothing" failure this repo keeps paying for, one step along: the
button says something, and the something is wrong.

**Root cause (traced).** `humanApiError` in
`frontend/src/vendor/scm/lib/authed-fetch.ts` resolves a refusal in a fixed
order, and step 1 returns unconditionally:

```ts
// 1. Known error code → curated plain message.
if (typeof j.error === 'string') {
  const mapped = ERROR_CODE_MESSAGES[j.error];
  if (mapped) return mapped;              // <- never reaches j.reason
}
```

`so_migrated_readonly` has an entry in `ERROR_CODE_MESSAGES`, so the server's
`reason` and `message` — read at step 2, ~70 lines further down — were
unreachable for that code. Observed by running the assertion against
`origin/main` in a detached worktree, not by reading: `1 failed | 22 passed`,
the failure being *"a PER-DOCUMENT reason wins over the curated class
sentence"*.

The precedence itself was right when it was written and is still right for
almost every code — a curated sentence is hand-written for the operator and
often names the exact box, which a raw server string does not. What changed is
that ONE code stopped being a class: the migrated lock now answers differently
per order, and no sentence written in the frontend can say which order or which
axis.

**Fix.** `SERVER_SENTENCE_WINS` — a deliberately tiny set, one member — lets a
code defer to the server's own sentence when it is renderable, and fall back to
the curated line when it is not, so nothing renders worse than before. Requires
`sayable` to be reachable at step 1, so `isPlain` / `withoutTail` / `sayable`
were HOISTED to just after the JSON parse; nothing about what they do changed.

The 200-character cap matters and is now load-bearing on both sides:
`isPlain` drops any string of 200+ characters, so `migratedSoVerdictMessage`
(backend `scm/lib/migrated-so-lock.ts`) drops AXIS NAMES until the sentence fits
under `OPERATOR_MESSAGE_MAX` rather than truncating one — a half-written axis
name would be dropped whole by this same filter.

Pinned by two tests in
`frontend/src/vendor/scm/lib/so-detail-gates.migrated.test.ts`: the
per-document reason renders, and a server that sends nothing sayable still gets
the curated sentence rather than the 409 catch-all ("refresh and check", which
on a migrated order is advice that loops). **Proved RED on the unfixed tree** —
the first fails on `origin/main`, the second passes there and must keep passing.

**Ref.** `feat/so-lock-by-correctness`, 2026-09-08.
