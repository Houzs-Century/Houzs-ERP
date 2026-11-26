
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
