// ----------------------------------------------------------------------------
// so-version-conflict — the way OUT of a Sales Order version conflict.
//
// THE DEAD END THIS EXISTS TO CLOSE (owner, 2026-08-16, on his own non-POS
// account). Once the SO's `version` moved while he had the editor open, that
// editor could never save again. Not a race — a terminal state:
//
//   1. `advanceSoGeneration` (backend/src/scm/lib/so-generation.ts:44) does
//      `version + 1`, and so-stock-allocation.ts calls it from the 5-minute
//      cron (backend/src/index.ts) flipping CONFIRMED <-> READY_TO_SHIP. It
//      refuses while an edit LEASE is held, but the lease exists only during
//      the save itself — so while the operator types, the version moves freely.
//      That is legitimate background work; the editor has to survive it.
//   2. The Save's first write is the version reservation, which 409s
//      `so_version_conflict` (mfg-sales-orders.ts:6804).
//   3. The catch put the sentence in a banner and never touched
//      `loadedVersionRef`, so the next Save re-sent the same stale number.
//   4. And the refetch effect is forbidden from healing it —
//      `if (!isEditing || loadedVersionRef.current == null)` deliberately
//      refuses to move the CAS baseline under an in-flight edit.
//
//   (4) is CORRECT and stays. A baseline that advances on its own turns CAS
//   into last-writer-wins: the editor would adopt a stranger's version and
//   overwrite their change without anyone seeing it. The bug is not that the
//   baseline holds — it is that there was no OTHER door.
//
// THE RECOVERY DATA WAS ALREADY ARRIVING. `soVersionConflict(currentVersion)`
// (mfg-sales-orders.ts:356) puts the server's real version in the 409 body, and
// authed-fetch preserves that body verbatim on `err.body` (authed-fetch.ts:411)
// — it is NOT discarded. As of this change, nothing in `frontend/src` had ever
// read it. That is the whole gap: the datum was delivered and never opened.
//
// WHAT IS DELIBERATELY *NOT* DONE: silently adopting the server's version and
// saving over whatever moved. That converts a safe refusal into a lost update,
// which is the exact failure CAS exists to prevent. The baseline advances only
// after the operator has been TOLD, given a way to look, and has explicitly
// chosen to proceed. A refetch is likewise not forced: the edit-mode seed
// effect re-seeds every line draft from `items`, so pulling a fresh snapshot
// under an open editor would throw away the line edits the banner is promising
// are still on screen.
// ----------------------------------------------------------------------------

import { AlertTriangle, History, Save } from 'lucide-react';

const ICON = { size: 15, strokeWidth: 1.75 } as const;

/** The server's own account of where the order actually is. `serverVersion` is
 *  null when the body carried no usable number — the banner still appears (the
 *  refusal is real), it just cannot offer the one-press continue. */
export type SoVersionConflict = { serverVersion: number | null };

/** The error codes that mean "your CAS baseline is behind", each of which the
 *  backend answers with a `currentVersion`. `so_version_required` and
 *  `so_version_invalid` are the same dead end reached with a missing or
 *  unparseable token rather than a stale one. */
const VERSION_CONFLICT_CODES = new Set([
  'so_version_conflict',
  'so_version_required',
  'so_version_invalid',
]);

/** Read the recovery datum out of the raw API body authed-fetch stashes on
 *  `err.body`. Returns null for anything that is not a version refusal, so the
 *  caller's ordinary error handling is untouched.
 *
 *  The number is NOT taken from the operator-facing message — that sentence is
 *  held to the house 白话文 rule ("no HTTP codes, no raw JSON, no DB
 *  internals", authed-fetch.ts:406) and `authed-fetch.version-conflict.test.ts`
 *  pins it. Both things are true at once: the sentence must stay clean AND the
 *  machine-readable body must be read. This function is the second half. */
export function readVersionConflict(
  body: string | undefined | null,
): SoVersionConflict | null {
  if (!body) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const j = parsed as { error?: unknown; currentVersion?: unknown };
  if (typeof j.error !== 'string' || !VERSION_CONFLICT_CODES.has(j.error)) return null;
  const v = j.currentVersion;
  const serverVersion = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  return { serverVersion };
}

/** The banner that replaces the dead end. Two doors, and the operator picks:
 *
 *   · LOOK — opens the order's own history panel, which is where "review the
 *     latest order" actually happens. Nothing is written.
 *   · PROCEED — adopts the server's version as the new CAS baseline and saves.
 *     Their drafts are untouched, so nothing has to be retyped, and because
 *     they pressed it knowingly it is a decision rather than a silent
 *     overwrite. Offered only when the server told us a version to adopt.
 *
 *  Doing nothing is also a real option and the copy says so: Cancel still
 *  discards, and the order on the server is not damaged by the refusal. */
export function SoVersionConflictBanner({
  conflict, className, saving, onReview, onProceed,
}: {
  conflict: SoVersionConflict;
  className: string;
  saving: boolean;
  onReview: () => void;
  onProceed: () => void;
}) {
  return (
    <div className={className} role="alert">
      <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <AlertTriangle {...ICON} />
        This order changed while you were editing it.
      </strong>
      <span>
        Someone else saved it, or the system&apos;s own scheduling sweep moved it on.
        Nothing you typed has been lost — it is all still on this screen. Look at
        what changed first; if your version is still the one you want, save it on top.
      </span>
      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 4 }}>
        <button type="button" onClick={onReview} disabled={saving}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, border: '1px solid currentColor', background: 'transparent', color: 'inherit', font: 'inherit', cursor: saving ? 'default' : 'pointer' }}>
          <History {...ICON} />
          See what changed
        </button>
        {conflict.serverVersion != null && (
          <button type="button" onClick={onProceed} disabled={saving}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, border: '1px solid currentColor', background: 'transparent', color: 'inherit', font: 'inherit', cursor: saving ? 'default' : 'pointer' }}>
            <Save {...ICON} />
            Save my changes on top
          </button>
        )}
      </div>
    </div>
  );
}
