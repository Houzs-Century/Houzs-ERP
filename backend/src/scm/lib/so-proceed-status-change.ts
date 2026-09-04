/* ---------------------------------------------------------------------------
   ONE QUESTION THE SAVE ASKS ONCE: does this Processing Date change move the
   status, and which way?

   The two rules are pure and live in `shared/so-proceeded-status.ts` — forward
   (a date appears, CONFIRMED -> IN_PRODUCTION) and back (the date is cleared,
   IN_PRODUCTION -> CONFIRMED). This is the thin layer that supplies the one
   fact neither of them can compute for itself: whether anything downstream
   exists. It sits here rather than in `shared/` because it reads the database,
   and `shared/` is the half the frontend mirrors.

   THE DOWNSTREAM READ IS ONLY ISSUED WHEN A DATE WAS ACTUALLY CLEARED. Every
   other save — the overwhelming majority — pays nothing.

   Owner, 2026-09-03, choosing the guarded symmetric rule of three offered:
   「B 其实就看有没有 date 就知道了」.
   -------------------------------------------------------------------------- */
import {
  statusAfterProcessingDateCleared,
  statusAfterProcessingDateSet,
} from '../shared/so-proceeded-status';
import { soHasDownstream } from './downstream-lock';

type Sb = { from: (t: string) => any };

export async function soStatusAfterProcessingDateChange(
  sb: Sb,
  docNo: string,
  input: {
    currentStatus: string | null | undefined;
    storedProcessingDate: string | null;
    effectiveProcessingDate: string | null;
  },
): Promise<string | null> {
  const proceeded = statusAfterProcessingDateSet(input);
  if (proceeded) return proceeded;

  const had = !!(input.storedProcessingDate ?? '').trim();
  const has = !!(input.effectiveProcessingDate ?? '').trim();
  /* Not a clearing — and therefore not worth a database round trip. */
  if (!had || has) return null;

  return statusAfterProcessingDateCleared({
    ...input,
    hasDownstream: Boolean(await soHasDownstream(sb as never, docNo)),
  });
}
