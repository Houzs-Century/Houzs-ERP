export type PoEmailPhotos = 'full' | 'reduced' | 'omitted';

/* Appended to the "Sent to supplier" notice. The PDF the supplier got differs
   from the one the operator printed, so the operator must be told. */
export function poEmailPhotosNote(photos: PoEmailPhotos): string {
  if (photos === 'reduced') return ' The photos were sent at a smaller size to stay under the 5 MB email limit.';
  if (photos === 'omitted') return ' The PO was too large to email with its photos, so it was sent WITHOUT them. Send the photos to the supplier separately.';
  return '';
}
