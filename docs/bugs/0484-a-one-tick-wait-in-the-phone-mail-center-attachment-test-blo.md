## A one-tick wait in the phone Mail Center attachment test blocked two frontend deploys [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** `frontend/src/mobile/MobileMailCenter.test.tsx` failed the `frontend`
job on Deploy runs 32398840395 (`ab798cd1`, 17:39) and 32400244624 (`9776d8ac`,
17:54) on 2026-08-20. Both commits changed ZERO files under `frontend/src`
(`git diff --name-only <sha>^1 <sha> | grep -c "^frontend/src"` = 0). Same test
both times — *sends a photo attached to a NEW email* — same line, same message:

```
AssertionError: Target cannot be null or undefined.
 ❯ src/mobile/MobileMailCenter.test.tsx:427:25
     427|     expect(attachments).toHaveLength(1);
```

`expect(body).toBeTruthy()` on the line above PASSED, so the compose POST did
happen — it simply carried no `attachments` key. The next two deploys (17:56,
18:01) were `frontend=success` with no code change, so nothing was missing from
production. The defect is that this file could fail ANY frontend deploy at any
time, unrelated to what changed, which teaches everyone to read red as noise.

**Root cause (traced).** Not the assertion, and not the component — the wait.
The suite's `settle()` helper was one macrotask:

```ts
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
```

and its comment claimed "jsdom's FileReader resolves on a macrotask". It does
not. `_readFile` in
`jsdom/lib/jsdom/living/file-api/FileReader-impl.js` [external] schedules a
`setImmediate`, and fires `load` from a **second `setImmediate` scheduled inside
the first**. Node runs due timers *before* the check phase, and
an immediate scheduled from within the check phase is deferred to the next turn.
`setTimeout(…, 0)` is clamped to 1ms — so whenever the loop turn takes longer
than that clamp, the timer becomes due first and `settle()` returns before the
FileReader has fired. `pickMailAttachments()` has then not resolved, `onFiles()`
has not run, and the click on Send posts with `files.length === 0`, which
`mail-attach-files.ts` renders as no `attachments` key at all.

That is why it failed under CI parallelism and passed on a quiet laptop — and
why the REPLY test, which uses the same helper, failed too once the machine was
loaded enough. Reproduced here on `origin/main` at **3 failures in 14 isolated
runs** (`npx vitest run src/mobile/MobileMailCenter.test.tsx` in a loop), hitting
both the NEW-email and the REPLY case.

**Fix.** Wait for the thing the read actually produces instead of for a number of
ticks. `pickFile()` now awaits the attachment chip's `Remove <name>` control
(`findByRole`), which exists only once the FileReader has resolved and the base64
has landed in state; the rejection case awaits its refusal sentence with
`findByText`. `settle()` is gone. No assertion was loosened, skipped or retried,
and no timeout was raised.

Proved RED on the unfixed tree twice, both deterministic rather than
probabilistic:

* dropping `attachments: attachmentPayload(files)` from the two POST bodies in
  `MobileMailCenter.tsx` fails BOTH attachment tests with the original
  `AssertionError: Target cannot be null or undefined`;
* making the picker's `onFiles(result.files)` a no-op fails both with
  `TestingLibraryElementError: Unable to find role="button" and name "Remove
  sofa.jpg"` — i.e. the new wait is not vacuous.

Green after the fix: 12/12 isolated runs and 3/3 full-suite runs
(`npx vitest run`, 222 files / 2305 tests).

**Ref.** fix/mail-center-attach-flake, 2026-08-21.
