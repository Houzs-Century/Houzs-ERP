// ----------------------------------------------------------------------------
// pv-file-handoff — carries the scan page's bill bytes to the New voucher page
// WITHOUT riding location.state: history.pushState serializes its state and
// browsers cap an entry around 16MB, so a scanned multi-page PDF could make
// the navigation itself throw. Module memory instead — same SPA session, same
// durability as router state (both die on a refresh), no size cap.
//
// take() CLEARS, so a stale pile can never attach to an unrelated voucher; a
// caller must therefore only setState when it actually took something (which
// also keeps a double-run effect from wiping the first take's result).
// ----------------------------------------------------------------------------

import type { PvFilePayload } from './payment-voucher-queries';

let stash: PvFilePayload[] = [];

export const stashPvFiles = (files: PvFilePayload[]): void => { stash = files; };

export const takePvFiles = (): PvFilePayload[] => {
  const taken = stash;
  stash = [];
  return taken;
};

/** Upload taken pages onto the document that now exists, in order, stopping at
    the first refusal. Never throws: the document is already saved, so the
    caller only reports what still needs adding by hand. */
export async function attachTakenFiles(
  files: PvFilePayload[],
  upload: (file: PvFilePayload) => Promise<unknown>,
): Promise<{ attached: number; failed: number; error: string | null }> {
  let attached = 0;
  for (const f of files) {
    try { await upload(f); attached += 1; } catch (e) {
      return { attached, failed: files.length - attached, error: e instanceof Error ? e.message : 'The file could not be uploaded.' };
    }
  }
  return { attached, failed: 0, error: null };
}
