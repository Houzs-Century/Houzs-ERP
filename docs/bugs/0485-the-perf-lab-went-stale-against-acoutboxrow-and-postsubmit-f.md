## The perf lab went stale against AcOutboxRow and postsubmit failed 14 times without blocking anything [medium]

**Symptom.** Every `postsubmit.yml` run on `main` from 2026-08-20T16:08Z onward
concluded `failure` — 14 consecutive runs (32390289786 first, 32402643812 last
at the time of writing). The failing job was `frontend-perf`, on its first step,
`npm run typecheck:perf-local`. Nobody was blocked and nothing was reverted,
because the required contexts on `main` are `backend-typecheck` and `frontend`
(plus `company-scope-ratchet` and `completeness-claim`) — postsubmit is not one
of them. The last green run was 32387813291 at 15:43:15Z.

**Root cause (traced).** `80f4f9756` (#2568) added one field to `AcOutboxRow`
in `frontend/src/lib/autocountOutbox.ts`:

    +  can_send_now: boolean;

`frontend/perf-lab/main.tsx` imports that type and builds two fixture shapes
against it (`AC_REPEATED_SENDS`, and the `base` object inside `acRows`). #2568
updated the six `frontend/src/**` fixtures that use the type and did not touch
perf-lab — `git show --stat 80f4f9756 -- frontend/perf-lab` is empty. perf-lab
is deliberately outside `tsconfig.app.json` and outside lint scope, so both
`npm run typecheck` (`tsc -b`) and the required `frontend` check stayed green
while the only gate that compiles perf-lab is a POSTSUBMIT job. The type error
therefore could not be caught before the merge, by construction.

Observed, not inferred — `npm run typecheck:perf-local` on `origin/main`:

    perf-lab/main.tsx(180,7): error TS2322: ...
      Property 'can_send_now' is missing in type '{ ... }' but required in type 'AcOutboxRow'.
    perf-lab/main.tsx(206,3): error TS2322: ...

**Fix.** `can_send_now: false` added to both fixture shapes. `false` is what the
route would actually publish for every row in this fixture, not a value chosen
to compile: `acRowCanSendNow` (`backend/src/scm/lib/autocount-outbox-status.ts`)
returns true only for a row whose state is `pending` and whose `attempts` are
under the cap, and all six shapes in the lab are sent, failed, skipped or
requeued. The production type was NOT widened and the step was not skipped,
excluded or `any`-ed. Proved RED on the unfixed tree (exit 2, both errors above)
and green after (exit 0).

The second step of that job, `npm run test:perf-local`, had not run at all since
15:43Z — a step that fails first hides every step behind it. It is green on this
branch.

**Not fixed here, deliberately.** perf-lab compiles only after merge, so this
class recurs whenever a type it imports changes. That is a CI-shape decision the
owner makes, not an agent; `postsubmit.yml`'s own header already states the
policy ("If either job starts failing on main, that is the signal to move it
back to presubmit"). Options were put to him with the PR.

**Ref.** fix/perf-lab-typecheck, 2026-08-21.
