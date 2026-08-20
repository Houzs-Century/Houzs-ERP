## The frontend deploy has been failing since 12:02 — a union that was never told about two kinds the server emits [high]

**Symptom** — every `deploy.yml` run since 12:02 on 2026-08-14 fails in the
`frontend` job, exit code 2, eight `TS2367` errors in
`frontend/src/pages/Projects.tsx`:

```
error TS2367: This comparison appears to be unintentional because the types
'"note" | "approve" | "reject" | "amend"' and '"upload"' have no overlap.
```

`backend` deployed; `frontend` did not. **The two halves of production have been
on different versions for the better part of an hour**, and nothing said so
except a red run nobody was watching.

**Root cause** — `ChecklistComment.kind` at `Projects.tsx:437` reads
`"note" | "submit" | "reject" | "amend" | "approve"`. #2184 taught the task
history to show file uploads and removals: it added the WRITER
(`backend/src/routes/projects.ts:4235` inserts `kind = 'upload'`, `:4318`
inserts `'remove'` into `project_checklist_comments`) and the READER (four
`c.kind === "upload"` comparisons), and never the union between them.

**Why CI did not catch it** — it did, eventually; it could not catch it *first*.
Both #2183 and #2184 were green against the main they merged onto. The failure
is the pair, not either one: a semantic merge conflict, which a per-PR gate
cannot see by construction because the tree it fails on did not exist when
either PR ran.

**Fix** — `"upload" | "remove"` added to the union, with the reason and both
writer line numbers in a comment beside it. Verified with the deploy's own two
commands, not a proxy: `npm run typecheck` (which is `tsc -b`; `npx tsc
--noEmit` here resolves zero inputs and exits 0) and `npx vite build`. 140 test
files / 1,361 tests pass.

**Class** — *a contract enforced in two places and declared in a third*. Same
family as the SO Processing Date literals: the type is the contract between a
writer and a reader, and it was the only one of the three not updated.

**Worth doing next, not done here:** nothing watches for main being red. The
deploy failed six times before anyone looked. `notify-failed-release` ran and
succeeded on both failures — so the notification path fired and still nobody
saw it, which is its own finding.

**Two gates then charged this fix for the file it had to touch**, and both were
right to, so the fix was made to cost nothing rather than to argue: the union
change is a one-for-one line swap with its pointer as a trailing comment, so
`Projects.tsx` is the same 15,003 lines it was on main and the size ratchet has
nothing to charge. The lint ratchet flagged one NEW floating promise at `:558`
— `addNew()` in an onChange, landed by someone else past a non-required check —
fixed as `void addNew()`, the idiom already used at `:2116` and `:7691`, rather
than re-baselined.

**Ref** - `fix/task-history-kinds`, 2026-08-14
