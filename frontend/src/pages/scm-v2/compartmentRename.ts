export type CompartmentMetaLike = {
  imageKey?: string;
  description?: string;
  defaultPriceSen?: number;
};

const BUNDLED_PREFIX = 'sofa-modules/';

/**
 * Move a compartment's meta entry when its code is edited in the list.
 *
 * A code with no stored imageKey/description shows its SEEDED default, which is
 * derived from the code itself (`sofa-modules/<code>.svg`). Renaming "Console"
 * to "Console Fabric" therefore lost the photo: the new code has no seed
 * (2026-10-02). So when the new code has no seed of its own, the old code's
 * seeded values are pinned into the stored entry. When the new code DOES have a
 * seed, a carried bundled imageKey is dropped so the new code's own art shows;
 * an uploaded photo is always kept.
 *
 * The list calls this on every keystroke, so intermediate codes ("Console F")
 * pin the value and later keystrokes simply carry it on.
 */
export function renameCompartmentMeta<M extends CompartmentMetaLike>(
  meta: Record<string, M>,
  oldCode: string,
  newCode: string,
  seed: (code: string) => CompartmentMetaLike,
): Record<string, M> {
  if (!oldCode || oldCode === newCode || newCode in meta) return meta;
  const next = { ...meta };
  const entry = { ...next[oldCode] } as M;
  delete next[oldCode];

  const oldSeed = seed(oldCode);
  const newSeed = seed(newCode);
  if (newSeed.imageKey) {
    if (entry.imageKey?.startsWith(BUNDLED_PREFIX)) delete entry.imageKey;
  } else if (!entry.imageKey && oldSeed.imageKey) {
    entry.imageKey = oldSeed.imageKey;
  }
  if (!newSeed.description && entry.description === undefined && oldSeed.description) {
    entry.description = oldSeed.description;
  }

  if (Object.keys(entry).length > 0) next[newCode] = entry;
  return next;
}
