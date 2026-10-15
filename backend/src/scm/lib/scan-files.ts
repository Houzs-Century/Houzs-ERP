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
  /* The hash and the put are independent: run them together. */
  const shaP = f.companyId ? sha256Hex(f.buf) : Promise.resolve('');
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
      sha256: await shaP,
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

/** Fill scan_files.document_id for the document just created (HC-0006 T7):
 *  match by storage key (SO, workshop) or by the bytes' sha256 (a PV file,
 *  a payment slip). Company- and kind-scoped, and only where unlinked, so a
 *  file already shown on one document never moves to another. Best-effort. */
export async function linkScanFiles(
  sb: Sb,
  f: { companyId: number | null; kind: ScanFileKind; documentId: string; keys: string[]; sha256: string | null },
): Promise<void> {
  if (!f.companyId || !f.documentId || (f.keys.length === 0 && !f.sha256)) return;
  try {
    let q = sb.from('scan_files').update({ document_id: f.documentId })
      .eq('company_id', f.companyId).eq('kind', f.kind).is('document_id', null);
    if (f.keys.length > 0) {
      q = q.in('storage_key', f.keys);
    } else {
      /* The same photo scanned twice leaves two unlinked rows with one sha256:
         link the newest only, so the second document still finds its own. */
      const { data: row, error: pickErr } = await sb.from('scan_files').select('id')
        .eq('company_id', f.companyId).eq('kind', f.kind).is('document_id', null).eq('sha256', f.sha256)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (pickErr) {
        console.warn(`[scan-files ${f.kind}] link lookup failed:`, f.documentId, pickErr.message);
        return;
      }
      if (!row) return;
      q = q.eq('id', (row as { id: string }).id);
    }
    const { error } = await q;
    if (error) console.warn(`[scan-files ${f.kind}] link failed:`, f.documentId, error.message);
  } catch (e) {
    console.warn(`[scan-files ${f.kind}] link failed:`, f.documentId, (e as Error).message);
  }
}

/** A scanned receipt reaches its payment row as a slip (scan-payment's
 *  persistReceiptAsSlip): same bytes, so the slip's content_hash is the scan's
 *  sha256. */
export async function linkPaymentScan(
  sb: Sb,
  f: { companyId: number | null; slipKey: string | null; paymentId: string },
): Promise<void> {
  if (!f.companyId || !f.slipKey || !f.paymentId) return;
  try {
    const { data, error } = await sb.from('pending_slip_uploads').select('content_hash')
      .eq('company_id', f.companyId).eq('r2_key', f.slipKey).limit(1).maybeSingle();
    if (error) {
      console.warn('[scan-files payment] slip lookup failed — scan not linked:', f.paymentId, error.message);
      return;
    }
    const sha256 = (data as { content_hash?: string } | null)?.content_hash ?? null;
    if (sha256) await linkScanFiles(sb, { companyId: f.companyId, kind: 'payment', documentId: f.paymentId, keys: [], sha256 });
  } catch (e) {
    console.warn('[scan-files payment] link failed:', f.paymentId, (e as Error).message);
  }
}
