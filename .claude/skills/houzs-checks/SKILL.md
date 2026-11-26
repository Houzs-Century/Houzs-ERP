---
name: houzs-checks
description: Run the Houzs ERP agent checks. Use before opening or updating a PR, and right after the owner corrects you (turn the correction into a check, not a paragraph).
---

# Houzs checks

## Before a PR

```
node scripts/agent-check.mjs          # all checks + lint for each app you changed
node scripts/agent-check.mjs --fast   # skip lint
```

It prints PASS / FAIL per step and exits non-zero if any step failed. Fix every FAIL before opening the PR. `file size` refuses to answer while source files are uncommitted: commit first, then re-run.

## What each check means

- `layout` (`scripts/check-layout.mjs`): no new repo-root entry and no new top-level folder under `frontend/src` or `backend/src` unless it is on `scripts/layout-allowlist.json`. Put the code in an existing folder, or add the folder to the allowlist and to `docs/CODEBASE-MAP.md` in the same PR. Product code in `frontend/src` and `backend/src` must not import each other.
- `new markdown` (`scripts/check-new-markdown.mjs`): a PR may add `.md` files only as `docs/modules/*.md`, `docs/bugs/README.md`, `tasks/TODO.md`, a `README.md`, `.claude/skills/**/SKILL.md` or `references/`, or under `.github/`. A plan, handoff, findings, report, summary or notes file goes in the PR body or one line in `tasks/TODO.md`. The `docs-requested` label waives it when the owner asked for the file. The Write hook `.claude/hooks/block-unsolicited-md.mjs` blocks the same files as you write them; files outside the repo and gitignored files are allowed.
- `docs size` (`scripts/check-docs-size.mjs`): `CLAUDE.md`, module guides, `docs/bugs/README.md` and `tasks/TODO.md` stay under their line limits.
- `file size` (`scripts/check-file-size.mjs`): no source file grows past 2,000 lines or its recorded ceiling.
- `lint <app>`: `npm --prefix <app> run lint`, the lint ratchet. Never raise a ceiling; fix the code or add `// eslint-disable-next-line <rule> -- <reason>`.

## When the owner corrects you

A correction from the owner becomes a lint rule or a check, with a test, not a new CLAUDE.md paragraph:

1. Lint-shaped (a pattern in code): add a rule to `scripts/eslint/houzs-lint-rules.mjs` with a test case that fails on the old code.
2. Repo-shaped (files, folders, PR contents): add `scripts/check-<name>.mjs` with `scripts/check-<name>.test.mjs` (node:test), and add it as a step in `scripts/agent-check.mjs`.
3. Run `node scripts/agent-check.mjs` and say in the PR body which correction the rule encodes.
