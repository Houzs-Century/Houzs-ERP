# docs/ — index

What is left after the 2026-09-15 cut. Everything removed — plans, ledgers, audits, handoffs, COEs, `archive/` — is kept
under the git tag `archive/docs-2026-09-15` (`git show archive/docs-2026-09-15:docs/<file>`).
When a document disagrees with the code, the code wins: fix the document in the same PR.

## Start here
- `../CLAUDE.md` — the working rules. `CODEBASE-MAP.md` — what each area is for and the traps (read before exploring).
- `ARCHITECTURE.md` — the June system map and data model; where it disagrees with `CODEBASE-MAP.md`, the map wins.
- `LESSONS.md` — one short entry per serious incident. `bugs/README.md` — recurring bug classes and the check that catches each.
- `modules/` — one guide per module; read it before changing that module. `generated/` — computed from the tree, never hand-edited.
- `../tasks/TODO.md` — everything still open: owner decisions, office/accountant items, dev work, active plans.

## Operate
- Deploy: `STAGING-RELEASES.md` (prod/staging topology, promote, rollback) · `emergency-deploy.md` (the only deploy outside Actions)
- Repo: `repo-hygiene.md` (branches, file-size ceilings) · `TESTING-RATCHET.md` (coverage per area; rewritten by scripts/coverage-ratchet.mjs) · `EXPLAIN.md` (ask the repo a question; read by a CI test)
- Database: `DB-REPOINT-RUNBOOK.md` (read its warning banner first) · `server-snapshot-playbook.md` (server snapshots: build only at a trigger)
- AutoCount: `autocount-integration-map.md` (start here — the four channels) · `ac-resync-runbook.md` (re-sync from the book, step by step)
- AutoCount: `autocount-remigration-runbook.md` (what each importer reads and writes) · `autocount-service-deploy.md` (build and swap AcSyncService on the host)

## How the system is built
- `MULTI-COMPANY-SCOPE-MODEL.md` — per-company vs centralised modules; the company predicate is the only tenant isolation.
- `PERMISSION-MATRIX.md` — position × page access (the seed script transcribes it).
- `THREAT-MODEL.md` — how the system could still be destroyed or taken, and who owns each remaining action.
- `agents/operating-spec.md` — the owner's operating model for the agents (the agent code cites its sections).
- `2990-live-sync/` — the live 2990 → Houzs mirror: its design and the sender-side SQL the mirror receivers cite.

## Specs still being built
- `line-export-columns.md` — one row per line item in every document list export.
- `新ERP会计模块需求书.md` — accounting module requirements; read with `modules/accounting.md`.

## Design
- `mobile-build-spec.html` — the canonical mobile tokens and components (cited by the mobile code).
- `mobile-prototype.html` — the approved phone prototype. `mockups/` — owner-approved mobile and PDF mockups.
- `mobile-react-design/` — presentational TSX port of the prototype.
