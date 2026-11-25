---
name: verify-houzs
description: Use to prove a Houzs ERP UI or API change works in the real running app (not just tests), or to debug a runtime error (console error, failed request, blank page, uncaught exception). Launches the local backend and frontend, drives the page with a headless browser probe, and returns VERIFIED / NOT VERIFIED / INCONCLUSIVE with evidence.
---

# Verify Houzs

Adapted from cursor/plugins (read for the full originals):
- https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/verify-this/SKILL.md
- https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/control-ui/SKILL.md
- https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md
- https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/runtime-forensics.md

Verification is not a recap. It proves or disproves one claim with evidence you captured now.

## 1. Claim

Restate the claim so it can fail: condition, observable, threshold.
- Bad: "the Projects page is fixed".
- Good: "opening /projects with no filter shows 0 console errors and 0 responses >= 400; before the fix it showed 1 TypeError".
If the claim cannot be made falsifiable, ask for one before driving anything.

## 2. Launch

From the repo root, two terminals:
- `npm run dev:backend` (wrangler dev, http://localhost:8787)
- `npm run dev:frontend` (vite, http://localhost:5173)

TRAP: production by default. Both of these point at the DEPLOYED worker unless overridden:
- `frontend/vite.config.ts`: the `/api` proxy target is `VITE_DEV_API_PROXY_TARGET`, else `https://autocount-sync-api.houzs-erp.workers.dev`.
- `frontend/src/api/client.ts`: dev builds call `VITE_API_URL`, else the same workers.dev URL.

Start the frontend with both set to the local worker (PowerShell):
`$env:VITE_DEV_API_PROXY_TARGET='http://localhost:8787'; $env:VITE_API_URL='http://localhost:8787'; npm run dev:frontend`

TRAP 2: the local worker reads `backend/.dev.vars`, which has held the LIVE production DB string before (docs/LESSONS.md). A local backend is not automatically a safe backend.

Until the Doctor passes, never click anything that writes (save, submit, approve, delete, post). Read-only page loads only.

## 3. Doctor

Run before driving, and again whenever results look odd. Read-only, prints no secret:
- Port is ours: `netstat -ano | findstr :5173` and `:8787`; the PIDs must be the processes you started.
- Proxy target: the frontend terminal was started with both env vars above (echo `$env:VITE_API_URL`).
- DB target, without printing the credential:
  `node -e "const s=require('fs').readFileSync('backend/.dev.vars','utf8');for(const id of ['anogrigyjbduyzclzjgn','minnapsemfzjmtvnnvdd','ctbaifabbzghtsrmpirm'])if(s.includes(id))console.log(id)"`
  `anogrigyjbduyzclzjgn` = PRODUCTION: read-only pages only. `minnapsemfzjmtvnnvdd` = staging: writes allowed. No match or no file = unknown: treat as production.
If any check fails, stop and report INCONCLUSIVE with which check failed.

## 4. Drive

Headless probe (Playwright from `frontend/node_modules`; falls back to installed Chrome or Edge):
`node scripts/verify-probe.mjs <url> [--out <dir>] [--click <selector>]... [--wait-ms n]`
- Writes `console.json` (errors and warnings with location), `network.json` (failed requests and responses >= 400, query string stripped), `page-errors.json` (uncaught exceptions), `screenshot.png`, `summary.txt` to `--out`, default `.verify/<timestamp>/`.
- Prints `PROBE OK` (exit 0) or `PROBE ERRORS n` (exit 1, n = page errors + console errors). Exit 2 = probe itself failed (bad args, selector not found, no browser: it prints `npx --prefix frontend playwright install chromium`).
- `--click` takes Playwright selectors: prefer `role=button[name="Save"]`, `text=...`, `[data-testid=...]` over CSS position. Clicks run in order, `--wait-ms` after each.
- Pages behind login: the probe has no session, so it sees the login screen. Use it for public pages, login itself, and crash checks; for logged-in flows use the suite below.
Unit tests for the probe: `node --test scripts/verify-probe.test.mjs`.

Existing suites (read their README/config first):
- `e2e/` service-case lifecycle (`cd e2e; npm test -- smoke`). WRITES DATA and its `ERP_API_URL` defaults to PRODUCTION (`e2e/README.md`): point it at staging or do not run it.
- `npm --prefix frontend run test:return-e2e` and `npm --prefix frontend run test:perf-local` (Playwright configs under `frontend/`).

## 5. Evidence

1. Baseline: run the same probe on the old state (main, or the commit before the fix) with the same URL, clicks and data.
2. Treatment: run it on the changed state.
3. Compare the raw files (counts, messages, statuses, screenshots), not your memory of them.
4. Give exactly one verdict:
   - `VERIFIED`: baseline and treatment differ in the predicted direction, by the threshold, no obvious confound.
   - `NOT VERIFIED`: unchanged, wrong direction, or short of the threshold. Say it plainly.
   - `INCONCLUSIVE`: no valid baseline, Doctor failed, flaky signal, or the environments differ.

Report shape:
```
VERIFIED | NOT VERIFIED | INCONCLUSIVE
Claim: <falsifiable claim>
Evidence: <metric>: baseline=<...>, treatment=<...>, threshold=<...>
Reasoning: <one paragraph, naming confounds>
```

The repo is PUBLIC. Evidence lives in `.verify/` (gitignored) and never gets committed, pasted into a PR, or attached anywhere: screenshots and responses contain real customer and supplier data. Quote counts and error messages, not screenshots.

## 6. Debug (runtime forensics)

You own the diagnosis; instrument the running app instead of theorising from source.
1. Capture the signal: run the probe on the failing URL and steps. The artifact is the stack in `page-errors.json`, the message and location in `console.json`, or the status in `network.json`.
2. Reduce it: the first error in time, its top frame in our code (not React or vendor frames), and the request that preceded it.
3. Prove the mechanism cheaply before believing it: change one input (another record, one less click, the API call alone with curl against localhost) and predict the result before running it.
4. Map to source: grep the message or route, open only the line range, name file, function and line.
Deliver the signal, the reduced finding, how you proved it, and the source location. No fix unless asked; then a regression test per CLAUDE.md.

## 7. Cleanup

- Stop only the dev servers you started (Ctrl+C in their terminal, or `taskkill /PID <pid>` with the PID from the Doctor). Never kill by process name: the owner may have his own node or wrangler running.
- Delete `.verify/` folders you no longer need; keep the ones backing a verdict until the task is closed. Never `git add` them.
