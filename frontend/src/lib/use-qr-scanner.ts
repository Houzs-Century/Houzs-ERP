// ----------------------------------------------------------------------------
// use-qr-scanner — an in-page camera that keeps decoding QR codes until it is
// told to stop.
//
// WHY THIS EXISTS AT ALL. Until 2026-08-26 nothing in this repo decoded a QR:
// every "scan" was the phone's OWN camera app opening the URL printed on the
// paper. That works for one document and cannot work for several, because each
// scan navigates away and takes the basket with it. The owner asked for the
// thing that needs a scanner: 「我不能 scan 好几个 DO，然后一起点 load 吗？…它应
// 该可以支持连续扫描的。」
//
// COPIED FROM HOOKKA, deliberately and with its reasons intact (the owner's
// standing instruction: 「源代码能抄的就抄」). Hookka's src/pages/rack-scan.tsx
// runs this loop on a warehouse floor today, and the three things below are the
// ones it learned by being wrong first:
//
//   1. NEVER EARLY-RETURN ON A HIT. The loop reschedules unconditionally at the
//      bottom, hit or no hit. Returning after the first decode is what makes a
//      "continuous" scanner stop after one item, and it is the defect Hookka's
//      comments call PROBLEM 1.
//   2. DE-DUPE BY VALUE, WITH A COOLDOWN. A paper held in front of the lens
//      decodes on EVERY frame — sixteen times a second. Without the window the
//      same document is added, rejected, re-beeped sixteen times a second. With
//      it, one physical scan adds exactly once, and a real gap (the paper
//      leaving the frame for longer than the window) lets the same document be
//      scanned again on purpose.
//   3. RESOLUTION AND FOCUS ARE THE SENSITIVITY. The owner's complaint on
//      2026-07-03 was 「上下左右斜角不敏感」 — it would not read a code that was
//      small, far, or at an angle. The answer was not a decoder setting: it was
//      asking the camera for 1440p instead of whatever it felt like giving, and
//      turning on continuous autofocus. Both are `ideal` constraints, so a lens
//      that cannot do it gives the closest it can rather than failing.
//
// ONE THING IS DELIBERATELY NOT COPIED. Hookka also lazily imports ZXing for
// Code 128 barcodes. Nothing here prints a barcode — the delivery order and the
// packing list both carry a QR — so jsQR alone is the fallback path and the
// bundle stays ~40KB smaller.
// ----------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

/* HOW LONG THE SAME VALUE IS IGNORED FOR. 1500ms is Hookka's, arrived at on a
   real floor: long enough that a paper held steady adds once, short enough that
   a storekeeper who genuinely wants to re-scan the same document only has to
   move it out of frame and back. */
const DEDUP_MS = 1500;

export type QrScannerState = {
  /** True while the camera is open and the loop is decoding. */
  scanning: boolean;
  /** A sentence to show the operator, or null. Never a silent failure. */
  cameraError: string | null;
  /** True only when THIS lens reports a torch — the button hides otherwise. */
  torchSupported: boolean;
  torchOn: boolean;
};

export type QrScanner = QrScannerState & {
  /** Attach to the <video> the preview renders into. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  start: () => Promise<void>;
  stop: () => void;
  toggleTorch: () => Promise<void>;
};

/**
 * @param onDecoded called once per physical scan with the decoded string. It is
 *   held in a ref, so a caller may pass a fresh closure every render without
 *   restarting the camera — restarting the camera mid-pile is a dropped scan.
 */
export function useQrScanner(onDecoded: (value: string) => void): QrScanner {
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastHitRef = useRef<{ value: string; at: number }>({ value: '', at: 0 });
  const onDecodedRef = useRef(onDecoded);
  onDecodedRef.current = onDecoded;

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    setScanning(false);
    setTorchOn(false);
  }, []);

  /* THE CAMERA MUST BE RELEASED WHEN THE PAGE GOES. A left-running track holds
     the lens and shows the recording indicator, and on some Android builds no
     other app can open the camera until the tab is killed. */
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    if (streamRef.current) return;
    setCameraError(null);
    try {
      /* REAR CAMERA, SHARP FEED. The extra pixels are the whole answer to
         「上下左右斜角不敏感」: they let both decode paths resolve a code that is
         small, far or angled instead of missing it. `ideal` rather than `exact`
         so an older lens falls back to what it has instead of failing outright. */
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
        audio: false,
      });
      streamRef.current = stream;

      /* Continuous autofocus where the lens has it — a fixed-focus lens leaves
         a small code blurred at arm's length, which reads to the operator as
         "it does not scan". Best-effort: never block a scan on focus tuning. */
      try {
        /* ANNOTATED `| undefined` rather than inferred, and `getCapabilities`
           reached through a cast: lib.dom types both as always present, and
           neither is. A stream can arrive with no video track, and Safari
           shipped MediaStreamTrack without getCapabilities for years. Letting
           the compiler's optimism stand here would crash the whole start() on
           the phones this exists for. */
        const track: MediaStreamTrack | undefined = stream.getVideoTracks()[0];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- lib.dom types getVideoTracks()[0] as always present; a stream can arrive with no video track and this whole block is best-effort.
        const getCaps = track?.getCapabilities as
          | (() => MediaTrackCapabilities & { focusMode?: string[]; torch?: boolean })
          | undefined;
        const caps = getCaps ? getCaps.call(track) : undefined;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- same optimism: `track` is only always-truthy to the compiler.
        if (track && caps?.focusMode?.includes('continuous')) {
          await track.applyConstraints({
            advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet],
          });
        }
        setTorchSupported(!!caps?.torch);
      } catch {
        /* focus and torch are niceties; the scan proceeds without them */
      }
      setScanning(true);
    } catch (e) {
      /* A HARD BLOCK AND A MISSING CAMERA NEED DIFFERENT SENTENCES. Once the
         browser remembers a denial, asking again shows nothing — only the
         person can undo it at the address bar — so telling them to "try again"
         would send them tapping a button that can never work. */
      const name = e instanceof DOMException ? e.name : '';
      setCameraError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera blocked. Allow camera access for this site (tap the lock icon in the address bar), then tap Scan again.'
          : 'Could not open the camera. Make sure no other app is using it and that this page is on https.',
      );
    }
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as unknown as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      /* Some lenses advertise torch and refuse it while streaming. Leave the
         state alone rather than showing a button that lies about being on. */
    }
  }, [torchOn]);

  // ── The decode loop ───────────────────────────────────────────────────────
  useEffect(() => {
    const stream = streamRef.current;
    const video = videoRef.current;
    if (!scanning || !stream || !video) return;

    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    /* A REFUSED play() IS A BLACK RECTANGLE, and swallowing it is how the
       operator ends up staring at one deciding the scanner is broken. It rejects
       for real reasons — an autoplay policy that wants a user gesture, the
       element detached mid-start — and none of them are visible any other way,
       because the decode loop below simply never sees a frame. So it is said out
       loud, in the same place every other camera failure is said. */
    video.play().catch((e: unknown) => {
      const name = e instanceof DOMException ? e.name : '';
      /* AbortError is the ordinary one: a play() interrupted by the stream being
         torn down, which is what STOPPING the scanner looks like. Not a failure
         and not worth a message. */
      if (name === 'AbortError') return;
      setCameraError('The camera opened but the picture would not start. Close this page and open it again.');
    });

    if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
    const canvas = canvasRef.current;

    let nativeDetector: BarcodeDetectorLike | null = null;
    if (typeof window !== 'undefined' && window.BarcodeDetector) {
      try {
        nativeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch {
        nativeDetector = null;
      }
    }

    /* ANNOTATED, because the compiler narrows `let stopped = false` to the
       LITERAL false and then calls every `if (stopped)` below dead — the writes
       happen in the cleanup closure, across an await it does not follow. The
       checks are real: they are what stops a decode that was already in flight
       from firing after the camera closed. */
    let stopped: boolean = false;
    let lastDecode = 0;
    /* The native decoder is cheap enough to run more often; the canvas path
       costs a full frame copy plus a JS decode, so it is throttled harder to
       keep the preview smooth on an older phone. */
    const THROTTLE_MS = nativeDetector ? 60 : 90;

    const onHit = (value: string) => {
      if (stopped || !value) return;
      const now = performance.now();
      const last = lastHitRef.current;
      /* SEE RULE 2 AT THE TOP. Silent, not a rejection message: a held paper
         re-decoding is not the operator doing anything wrong, and telling them
         so sixteen times a second is worse than saying nothing. */
      if (value === last.value && now - last.at < DEDUP_MS) {
        lastHitRef.current = { value, at: now };
        return;
      }
      lastHitRef.current = { value, at: now };
      onDecodedRef.current(value);
    };

    const tick = async () => {
      if (stopped) return;
      const now = performance.now();
      let hit: string | null = null;

      if (now - lastDecode >= THROTTLE_MS && video.videoWidth > 0 && video.readyState >= 2) {
        lastDecode = now;
        if (nativeDetector) {
          try {
            const codes = await nativeDetector.detect(video);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `stopped` is written by the cleanup closure across this await, which control-flow analysis does not follow; this check is what stops a decode already in flight from firing after the camera closed.
            if (stopped) return;
            const first = codes.find((cd) => cd.rawValue);
            if (first?.rawValue) hit = first.rawValue;
          } catch {
            /* Exposed but flaky on this device — drop to the canvas path for
               the rest of the session rather than throwing every frame. */
            nativeDetector = null;
          }
        } else {
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            /* Work at ~1440px on the long edge. Smaller is faster and loses the
               small/angled codes this was built to catch. */
            const scale = Math.min(1, 1440 / Math.max(vw, vh));
            const cw = Math.max(1, Math.round(vw * scale));
            const ch = Math.max(1, Math.round(vh * scale));
            canvas.width = cw;
            canvas.height = ch;
            ctx.drawImage(video, 0, 0, cw, ch);
            let imageData: ImageData | null = null;
            try {
              imageData = ctx.getImageData(0, 0, cw, ch);
            } catch {
              imageData = null; // tainted canvas — nothing to decode
            }
            if (imageData) {
              /* attemptBoth reads a code printed light-on-dark as well as the
                 usual dark-on-light. It costs a second pass and catches the
                 photocopied sheets. */
              const code = jsQR(imageData.data, cw, ch, { inversionAttempts: 'attemptBoth' });
              if (code?.data) hit = code.data;
            }
          }
        }
      }

      if (hit) onHit(hit);
      /* SEE RULE 1 AT THE TOP. ALWAYS reschedule — never inside an `if`, never
         after an early return. This single line is what makes the scanner
         continuous. */
      rafRef.current = requestAnimationFrame(() => void tick());
    };
    rafRef.current = requestAnimationFrame(() => void tick());

    return () => {
      stopped = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scanning]);

  return { scanning, cameraError, torchSupported, torchOn, videoRef, start, stop, toggleTorch };
}
