// ---------------------------------------------------------------------------
// The platform barcode detector — Android Chrome exposes a hardware-accelerated
// QR decoder as `window.BarcodeDetector`. iOS Safari does not, which is why
// every use is feature-detected at runtime and why the property below is
// OPTIONAL rather than convenient: declaring it non-optional would let a caller
// compile against a browser API half the phones on the floor do not have.
//
// Copied from Hookka's src/types/barcode-detector.d.ts, which carries the same
// two-path design for the same reason (owner: 「源代码能抄的就抄」).
// ---------------------------------------------------------------------------
interface DetectedBarcodeLike {
  rawValue?: string;
  format?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcodeLike[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

interface Window {
  BarcodeDetector?: BarcodeDetectorConstructor;
}
