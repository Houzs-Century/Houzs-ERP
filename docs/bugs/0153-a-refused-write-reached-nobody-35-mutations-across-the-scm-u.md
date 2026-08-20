## A refused write reached nobody — 35 mutations across the SCM UI [high]

**Symptom (owner).** "我点了 deactivate 它也是没反应." Press Deactivate on a
fabric: the row does not change, no message appears, nothing in the console. The
button reads as broken.

**Root cause (traced).** `vendor/scm/lib/fabric-queries.ts` had EIGHT mutations,
eight `onSuccess`, and ZERO `onError`. The server's refusal — the SCM area guard
wanting `edit` where the grid's GET only needs `view`
(`scm/middleware/area-guard.ts:16`), a 409 while the active company has not
resolved, a 404 on the other company's row — arrived, was correct, and was
dropped on the floor. `serviceNotify` was ALREADY imported in that file, used for
one SUCCESS toast on the tier update; only the failure half was missing.

This is the worst shape a defect can take here: the USER cannot report it
usefully, and the DEVELOPER cannot see it either.

**Fix.** Shared `writeFailed` (`vendor/scm/lib/mutation-error.ts`) showing the
SERVER's own sentence — `authedFetch` throws Errors carrying it, and a generic
"something went wrong" would only send the next person hunting again.

**Correction 2026-08-13 (audit).** Two details in this entry were wrong about the
file it names. (1) The count is EIGHT, not nine — `fabric-queries.ts` has eight
`useMutation` calls (`useUpdateFabricTier`, `…SupplierCode`, `…Series`,
`…Active`, `…Description`, `useCreateFabric`, `useBulkUpsertFabrics`,
`useDeleteFabric`), and had eight before the fix too (`git show e1fb493b^` — 8
`useMutation`, 0 `onError`). The file's own header comment at
`fabric-queries.ts:17` still says "all nine"; it is wrong the same way.
(2) Fabric does NOT use the shared `writeFailed`: it defines a local
`fabricWriteFailed` (`fabric-queries.ts:31`) with its own title, "That change was
not saved". Same shape — it surfaces `err.message`, the server's own sentence —
but the shared helper is what the OTHER 33 files import (31 `*-queries.ts`, plus
`Categories.tsx` and `PhotoGallery.tsx`), not this one.

**System-wide.** New `frontend/scripts/check-silent-mutations.mjs`: 297
`useMutation` sites, 270 with no `onError`. It does a SECOND pass over each
hook's consumers, because "no onError" is not "nobody catches it" — 182 are
CAUGHT (`mutateAsync`, `.isError`, or per-call `.mutate(vars, { onError })`), 53
UNRESOLVED and listed for a human, **35 genuinely SILENT**. All 35 fixed.

**The checker's own first answer was 104, and it was wrong** — it could not see
the per-call `.mutate(vars, { onError })` form, which `ConsignmentNoteNew` uses.
Reading the source of a case it had flagged is what found it. 104 → 35. The raw
270 was never the bug count.

**Ref** - `fix/company-scope-sweep`, 2026-08-13. See `docs/one-sided-rules-coe.md`.
