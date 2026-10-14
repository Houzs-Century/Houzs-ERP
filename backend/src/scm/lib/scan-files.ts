// scan-files — keep every original scan file (HC-0006 T6). One scm.scan_files
// row per file, written BEFORE the model read starts, so a failed read still
// leaves the bytes and the row. The bytes go to SO_ITEM_PHOTOS, the bucket the
// SO scanner's scan-jobs/{jobId}/{n} copies already live in.
//
// Best-effort by design: no bucket, a failed put, no active company or a
// failed insert is LOGGED and the scan carries on — keeping the original must
// never cost the operator the reading.

import { sha256Hex } from './scan-ocr';

export type ScanFileKind = 'so' | 'payment' | 'pv' | 'workshop';

type Bucket = { put(key: string, value: ArrayBuffer, opts?: unknown): Promise<unknown> };
type Sb = { from(table: string): any };

/** Puts the file and writes its row. Returns the storage key when the bytes
 *  were stored (even if the row then failed), else null. `key` defaults to
 *  scan-files/{kind}/{rowId}; the SO scanner passes its own scan-jobs key. */
export async function keepScanFile(
  env: { SO_ITEM_PHOTOS?: Bucket },
  sb: Sb,
  f: {
    kind: ScanFileKind;
    companyId: number | null | undefined;
    buf: ArrayBuffer;
    mime: string;
    uploadedBy: string | null | undefined;
    key: string | null;
  },
): Promise<string | null> {
  const id = crypto.randomUUID();
  const key = f.key ?? `scan-files/${f.kind}/${id}`;
  const bucket = env.SO_ITEM_PHOTOS;
  if (!bucket) {
    console.warn(`[scan-files ${f.kind}] no file store bound — original not kept`);
    return null;
  }
  try {
    await bucket.put(key, f.buf, { httpMetadata: { contentType: f.mime } });
  } catch (e) {
    console.warn(`[scan-files ${f.kind}] R2 put failed:`, key, (e as Error).message);
    return null;
  }
  if (!f.companyId) {
    console.warn(`[scan-files ${f.kind}] no active company — file kept at ${key}, no row`);
    return key;
  }
  try {
    const { error } = await sb.from('scan_files').insert({
      id,
      company_id: f.companyId,
      kind: f.kind,
      storage_key: key,
      sha256: await sha256Hex(f.buf),
      mime: f.mime || 'application/octet-stream',
      size_bytes: f.buf.byteLength,
      uploaded_by: f.uploadedBy ?? null,
    });
    if (error) console.warn(`[scan-files ${f.kind}] row insert failed:`, key, error.message);
  } catch (e) {
    console.warn(`[scan-files ${f.kind}] row insert failed:`, key, (e as Error).message);
  }
  return key;
}
