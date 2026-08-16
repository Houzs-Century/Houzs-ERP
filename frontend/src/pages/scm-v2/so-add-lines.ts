// ----------------------------------------------------------------------------
// so-add-lines — the STAGED new lines of the Sales Order editor, and the
// settling rules for the line writes a page-level Save fans out.
//
// WHY THIS IS A MODULE AND NOT MORE STATE IN SalesOrderDetail.tsx.
// SalesOrderDetail.tsx sits under a file-size ceiling that may only fall
// (scripts/file-size-ceilings.json), so the list-shaped replacement for its
// single `addingDraft` had to land somewhere. Everything here is pure — no
// React, no fetch — which is also what makes the behaviour testable without
// mounting a 4,000-line page.
//
// THE KEY PER ROW IS THE DOCUMENTED PATTERN, NOT AN INVENTION.
// lib/idempotency.ts: "Callers whose intent is a DATA row rather than a mount
// (a PaymentsTable draft) should instead mint with newIdempotencyKey() and
// store it on the row, which dies with the row on success." One staged line is
// exactly that — one ADD intent — so its key rides on the row. A single
// page-level key would have been rule (2) inverted: several genuinely distinct
// inserts colliding on one key, and the middleware replaying the first response
// for all of them, i.e. lines silently swallowed.
// ----------------------------------------------------------------------------

import type { SoLineDraft } from '../../vendor/scm/components/SoLineCard';

/** One new line the operator has staged but not yet saved. */
export type StagedAddLine = {
  /** React key, and the handle every patch / remove callback addresses. */
  key: string;
  /** ONE ADD intent. Survives a retry so a timeout replays instead of
   *  inserting the same line twice. Retired with the row, never on success. */
  idempotencyKey: string;
  draft: SoLineDraft;
};

/** What the operator is told to look at. 1-based: it is a position on screen,
 *  not an array index, and it is the only handle a staged line has before it
 *  has a product code. */
export const stagedAddLabel = (position: number): string => `New line ${position}`;

export function patchStagedAdd(
  list: StagedAddLine[],
  key: string,
  patch: Partial<SoLineDraft>,
): StagedAddLine[] {
  let changed = false;
  const out = list.map((row) => {
    if (row.key !== key) return row;
    changed = true;
    return { ...row, draft: { ...row.draft, ...patch } };
  });
  return changed ? out : list;
}

export function dropStagedAdd(list: StagedAddLine[], key: string): StagedAddLine[] {
  const out = list.filter((row) => row.key !== key);
  return out.length === list.length ? list : out;
}

/** Header Delivery Date cascade — same rule the persisted drafts follow: a line
 *  the operator has manually overridden keeps its own date. */
export function cascadeStagedDeliveryDate(
  list: StagedAddLine[],
  next: string | null,
): StagedAddLine[] {
  let changed = false;
  const out = list.map((row) => {
    const d = row.draft;
    if (d.lineDeliveryDateOverridden || (d.lineDeliveryDate ?? null) === next) return row;
    changed = true;
    return { ...row, draft: { ...d, lineDeliveryDate: next } };
  });
  return changed ? out : list;
}

export const stagedAddDrafts = (list: StagedAddLine[]): SoLineDraft[] =>
  list.map((row) => row.draft);

/** Staged lines that actually name a product. The blank guard runs first, so
 *  in practice this is all of them — it exists so a caller that skips the
 *  guard (the amendment builder used to) cannot emit a code-less ADD. */
export const namedStagedAdds = (list: StagedAddLine[]): StagedAddLine[] =>
  list.filter((row) => row.draft.itemCode.trim() !== '');

/** 1-based position of the first staged line with no product picked, or null.
 *  The POSITION is the point: "pick a product for the new line" was actionable
 *  while only one line could be staged and is not once several can. */
export function firstBlankStagedAdd(list: StagedAddLine[]): number | null {
  const i = list.findIndex((row) => row.draft.itemCode.trim() === '');
  return i === -1 ? null : i + 1;
}

/* ── Line-write settling ────────────────────────────────────────────────────
   The page Save used to run every stage under Promise.all and let the FIRST
   rejection reject the chain. Two costs, both paid by the owner: the siblings
   stayed in flight while the catch tore the edit lease down, and the operator
   was shown one message that named nothing — a refused price edit read as
   "failed to save" while the new line it aborted was never mentioned. */

export type LineWriteFailure = { label: string; message: string };

export type SettledLineWrites<T> = { done: T[]; failures: LineWriteFailure[] };

export type LineWriteJob<T> = {
  /** What the operator will read: the item code, or the staged line's label. */
  label: string;
  value: T;
  run: () => Promise<unknown>;
};

const messageOf = (e: unknown): string =>
  e instanceof Error && e.message ? e.message : 'Something went wrong.';

/** Independent rows (existing-line PATCHes, deletes) — still fired together,
 *  but SETTLED, so every one of them has finished before the caller decides
 *  what to do, and every refusal is reported rather than only the first. */
export async function settleParallelLineWrites<T>(
  jobs: LineWriteJob<T>[],
): Promise<SettledLineWrites<T>> {
  const settled = await Promise.allSettled(jobs.map((job) => job.run()));
  const done: T[] = [];
  const failures: LineWriteFailure[] = [];
  settled.forEach((res, i) => {
    const job = jobs[i]!;
    if (res.status === 'fulfilled') done.push(job.value);
    else failures.push({ label: job.label, message: messageOf(res.reason) });
  });
  return { done, failures };
}

/** Staged ADDs — ONE AT A TIME, and deliberately so. POST /:docNo/items is a
 *  read-modify-write against the order twice over:
 *
 *    · `soMainMixIntroduced` (mfg-sales-orders.ts:854) reads the SO's current
 *      lines and returns `mix(after) && !mix(before)`. Two concurrent adds each
 *      see a pre-state without the other, so a sofa and a bedframe posted
 *      together BOTH pass the guard whose whole job is to reject that pair.
 *    · `line_no` is `SELECT max(line_no) ... LIMIT 1` then `+ 1`
 *      (mfg-sales-orders.ts:8032). Concurrent adds read the same max and write
 *      the same number.
 *
 *  It also keeps going past a failure. Aborting at the first refusal is what
 *  loses work invisibly: the operator staged four lines, one is rejected, and
 *  the other three were never attempted and never mentioned. */
export async function settleSequentialLineWrites<T>(
  jobs: LineWriteJob<T>[],
): Promise<SettledLineWrites<T>> {
  const done: T[] = [];
  const failures: LineWriteFailure[] = [];
  for (const job of jobs) {
    try {
      await job.run();
      done.push(job.value);
    } catch (e) {
      failures.push({ label: job.label, message: messageOf(e) });
    }
  }
  return { done, failures };
}

/** The three write stages of a page-level Save, in order, each settled before
 *  the next is allowed to start. Throws the first stage's aggregated failure,
 *  so the caller's existing catch (lease release + banner) is unchanged apart
 *  from the message finally naming the lines.
 *
 *  Stage order is load-bearing and is the OLD chain's: deletes, then existing-
 *  line PATCHes, then the staged ADDs, then (the caller's) header PATCH — the
 *  header's Processing-Date gate has to inspect the now-current variants.
 *
 *  `onAddsLanded` is called with the adds that DID commit, before any throw, so
 *  the editor can stop showing them as unsaved while the refused ones stay
 *  staged. That is what lets the message promise the work is still on screen. */
export async function runSoLineWrites<A>(stages: {
  deletes: LineWriteJob<unknown>[];
  updates: LineWriteJob<unknown>[];
  adds: LineWriteJob<A>[];
  onAddsLanded: (landed: A[]) => void;
}): Promise<void> {
  const staged = stages.adds.length;
  for (const jobs of [stages.deletes, stages.updates]) {
    const { failures } = await settleParallelLineWrites(jobs);
    if (failures.length > 0) throw new Error(lineWriteErrorMessage(failures, staged));
  }
  const { done, failures } = await settleSequentialLineWrites(stages.adds);
  if (done.length > 0) stages.onAddsLanded(done);
  if (failures.length > 0) throw new Error(lineWriteErrorMessage(failures, failures.length));
}

/** The sentence the save banner shows. It names every line that refused, and
 *  it says what happened to the work that did NOT go out — the half the old
 *  bare "failed to save" left the operator to guess at. */
export function lineWriteErrorMessage(
  failures: LineWriteFailure[],
  stillStaged: number,
): string {
  const listed = failures.map((f) => `${f.label}: ${f.message}`).join(' · ');
  const head = failures.length === 1
    ? `Could not save ${listed}`
    : `${failures.length} lines could not be saved — ${listed}`;
  if (stillStaged <= 0) return `${head}.`;
  const noun = stillStaged === 1 ? 'new line is' : 'new lines are';
  return `${head}. Your ${stillStaged} ${noun} still on screen and not saved yet.`;
}

/** What the "Line Items (n)" header must say, and what the staged cards must
 *  number themselves from: the line cards the operator can actually see.
 *
 *  In edit mode that is NOT `items.length`, in both directions — a staged add
 *  is on screen and not in `items`, and a line removed this session lingers in
 *  `items` until the refetch while its card is already gone (the renderer
 *  skips any item with no draft). The owner reported the first direction:
 *  three rows under a header reading "LINE ITEMS (2)".
 *
 *  `persisted` is the saved rows still rendered; `total` is what the header
 *  counts. Outside edit mode nothing is staged and no draft is dropped, so
 *  both are `items.length`. */
export function visibleLineCounts(args: {
  isEditing: boolean;
  itemIds: string[];
  editingDraftIds: string[];
  stagedAdds: number;
}): { persisted: number; total: number } {
  if (!args.isEditing) {
    return { persisted: args.itemIds.length, total: args.itemIds.length };
  }
  const kept = new Set(args.editingDraftIds);
  const persisted = args.itemIds.filter((id) => kept.has(id)).length;
  return { persisted, total: persisted + args.stagedAdds };
}
