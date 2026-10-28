import { useRef, useState, type CSSProperties } from 'react';
import { Camera, Check, ImagePlus, Loader2, X } from 'lucide-react';
import {
  ALLOWED_SLIP_MIMES, MAX_SLIP_SIZE_BYTES,
  uploadSlipFull, type SlipUploadPhase,
} from '../lib/slip';
import paymentsStyles from '../../../pages/scm-v2/Payments.module.css';

const IMAGE_SLIP_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type Phase = 'idle' | SlipUploadPhase | 'done' | 'error';

/* Spec D4 (2026-06-06) — per-payment slip uploader for PaymentsTable draft
   rows. Backend twin of the POS SlipUploadStep (file input only, no camera).
   Reuses the Payments table's addBtn / trashBtn classes so it sits flush with
   the inline-edited row controls. */
export function SlipUploadField({
  required = false,
  disabled = false,
  onConfirmed,
  onCleared,
  onImageScan,
}: {
  /** Renders the "*" marker on the trigger. NO CALLER SETS THIS ANY MORE and
   *  none should: a payment slip is optional on every Sales-Order path (Owner
   *  2026-08-13, after SAVED mode dropped the requirement on 2026-07-13). Kept
   *  only because the marker is the honest way to say "required" if some other
   *  document type ever mounts this field under a rule of its own — an
   *  asterisk on an SO payment row is a bug, not a style choice. */
  required?: boolean;
  disabled?: boolean;
  onConfirmed: (uploadSessionId: string) => void;
  onCleared: () => void;
  /** Optional. When an IMAGE (jpg/png/webp) is uploaded, the same file is also
   *  handed here so the caller can OCR-scan it (card-terminal / EPP receipt)
   *  and fill-blanks the payment row. Returns a promise that resolves when the
   *  scan settles — while it is pending the upload button shows a spinner in
   *  place of its icon (no extra element). PDFs are NOT passed (skipped). */
  onImageScan?: (file: File) => Promise<void>;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  /* Two hidden inputs — one for the OS photo picker / file browser, one
     that uses `capture="environment"` to open the device's rear camera
     directly. Mobile browsers honour capture; on desktop the second one
     falls back to a file picker so the operator still has an escape. */
  const libInputRef = useRef<HTMLInputElement | null>(null);
  const camInputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setPhase('idle'); setErrorMsg(null); setFileName(null); setScanning(false);
    if (libInputRef.current) libInputRef.current.value = '';
    if (camInputRef.current) camInputRef.current.value = '';
    onCleared();
  };

  const handleFile = async (f: File | null) => {
    if (!f) { reset(); return; }
    if (!(ALLOWED_SLIP_MIMES as readonly string[]).includes(f.type)) {
      setErrorMsg('Only JPG / PNG / WebP / PDF supported.'); setPhase('error'); return;
    }
    /* WO-7 — the 5 MB pre-check now applies to PDFs only. Images are
       compressed inside uploadSlipFull, so a raw 8 MB phone photo is valid
       input; if one somehow still exceeds the ceiling after compression the
       pipeline throws its own plain-language error. */
    if (!IMAGE_SLIP_MIMES.has(f.type) && f.size > MAX_SLIP_SIZE_BYTES) {
      setErrorMsg('File too large (max 5 MB).'); setPhase('error'); return;
    }
    setFileName(f.name); setErrorMsg(null);

    /* Receipt OCR — fire IN PARALLEL with the slip upload when the file is an
       image (the receipt IS the slip). The scan never blocks or fails the
       upload; the caller reports its own outcome via a toast. The only UI
       effect here is the spinner-in-place-of-icon while it's pending. */
    if (onImageScan && IMAGE_SLIP_MIMES.has(f.type)) {
      setScanning(true);
      void onImageScan(f).finally(() => setScanning(false));
    }

    try {
      const result = await uploadSlipFull({ file: f, onProgress: (p) => setPhase(p) });
      setPhase('done');
      onConfirmed(result.uploadSessionId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Upload failed.');
      setPhase('error'); onCleared();
    }
  };

  const busy = phase === 'init' || phase === 'put' || phase === 'confirm';

  /* Compact icon-button style shared by both triggers. Grid track for the
     Slip cell is 52 px so both fit: 22 + 22 + 3 gap = 47 px. */
  const iconBtnStyle: CSSProperties = {
    position: 'relative',
    margin: 0,
    width: 22,
    height: 22,
    padding: 0,
    fontSize: 0,
    gap: 0,
    justifyContent: 'center',
    flexShrink: 0,
    borderRadius: 6,
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 0, position: 'relative' }}>
      {/* Photo library / file browser — no capture, so mobile shows the
          picker sheet (Camera / Photo library / Files) and desktop shows
          a plain file dialog. Accepts PDF for card-terminal e-slips. */}
      <input
        ref={libInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        style={{ display: 'none' }}
        disabled={disabled}
        onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
      />
      {/* Camera capture — capture="environment" hints the rear camera on
          mobile; desktop browsers ignore it and fall back to a file
          dialog. Only image mimes (no PDF) since it's a live shot. */}
      <input
        ref={camInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        style={{ display: 'none' }}
        disabled={disabled}
        onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
      />
      {phase !== 'done' ? (
        <>
          <button
            type="button"
            className={paymentsStyles.addBtn}
            title={
              busy ? 'Uploading slip…'
                : scanning ? 'Scanning receipt…'
                : (required ? 'Upload photo (required)' : 'Upload photo')
            }
            style={iconBtnStyle}
            onClick={() => libInputRef.current?.click()}
            disabled={busy || disabled}
          >
            {busy || scanning
              ? <Loader2 size={13} strokeWidth={1.75} className={paymentsStyles.slipScanSpin} />
              : <ImagePlus size={13} strokeWidth={1.75} />}
          </button>
          <button
            type="button"
            className={paymentsStyles.addBtn}
            title={busy ? 'Uploading slip…' : 'Take photo with camera'}
            style={iconBtnStyle}
            onClick={() => camInputRef.current?.click()}
            disabled={busy || disabled}
          >
            <Camera size={13} strokeWidth={1.75} />
          </button>
          {required && !busy && (
            <span
              aria-hidden
              style={{
                position: 'absolute',
                top: -4,
                right: -4,
                fontSize: 10,
                lineHeight: 1,
                color: 'var(--c-festive-b, #B8331F)',
                fontWeight: 700,
                pointerEvents: 'none',
              }}
            >*</span>
          )}
        </>
      ) : (
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 'var(--fs-11)', color: 'var(--c-secondary-a, #2F5D4F)', fontWeight: 600,
          }}
          title={fileName ?? undefined}
        >
          <Check size={14} strokeWidth={2} />
          {fileName && fileName.length > 14 ? `${fileName.slice(0, 12)}…` : fileName}
          <button
            type="button"
            className={paymentsStyles.trashBtn}
            onClick={reset}
            title="Remove slip"
            disabled={disabled}
          >
            <X size={12} strokeWidth={2} />
          </button>
        </span>
      )}
      {errorMsg && (
        <span style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-11)' }}>
          {errorMsg}
        </span>
      )}
    </span>
  );
}
