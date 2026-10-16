/* What a document file may be — the server's DOC_FILE_MIMES (doc-files.ts) as
   an <input accept> — and the MIME a picked file is sent as. Its own module
   with no imports: every page test that mocks payment-voucher-queries whole
   would otherwise lose this helper and the upload would throw (CI 2026-10-15). */
export const DOC_FILE_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
/** The MIME a picked file is sent as. The browser's `File.type` is empty for a
    file a scanner or a chat app saved without one, and a few tools write
    `application/x-pdf` or `image/jpg` — all refused by the server's allowlist
    as "not an image or a PDF" (owner 2026-10-15: attach 不到 pdf). The
    extension decides when the type is missing or not one the server takes;
    a type the server takes is kept as is. One home for every upload site. */
export const docFileMime = (f: Pick<File, 'name' | 'type'>): string => {
  const given = (f.type || '').toLowerCase();
  if (DOC_FILE_ACCEPT.split(',').includes(given)) return given;
  const ext = (f.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]) ?? '';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (given === 'application/x-pdf') return 'application/pdf';
  if (given === 'image/jpg') return 'image/jpeg';
  return given || 'application/pdf';
};
