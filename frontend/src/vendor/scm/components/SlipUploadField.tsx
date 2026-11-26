import { useRef, useState, type CSSProperties } from 'react';
import { Camera, Check, ImagePlus, Loader2, X } from 'lucide-react';
import {
  ALLOWED_SLIP_MIMES, MAX_SLIP_SIZE_BYTES,
  uploadSlipFull, type SlipUploadPhase,
} from '../lib/slip';
import paymentsStyles from '../../../pages/scm-v2/Payments.module.css';

const IMAGE_SLIP_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type Phase = 'idle' | SlipUploadPhase | 'done' | 'error';

export function SlipUploadField({
  required = false,
  disabled = false,
  onConfirmed,
  onCleared,
  onImageScan,
}: {
  required?: boolean;
  disabled?: boolean;
  onConfirmed: (uploadSessionId: string) => void;
  onCleared: () => void;
  onImageScan?: (file: File) => Promise<void>;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
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
    if (!IMAGE_SLIP_MIMES.has(f.type) && f.size > MAX_SLIP_SIZE_BYTES) {
      setErrorMsg('File too large (max 5 MB).'); setPhase('error'); return;
    }
    setFileName(f.name); setErrorMsg(null);

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
      <input
        ref={libInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        style={{ display: 'none' }}
        disabled={disabled}
        onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
      />
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
                color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))',
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
            fontSize: 'var(--fs-11)', color: 'var(--c-secondary-a, var(--hz-dk-secondary-a, #2F5D4F))', fontWeight: 600,
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
        <span style={{ color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))', fontSize: 'var(--fs-11)' }}>
          {errorMsg}
        </span>
      )}
    </span>
  );
}
