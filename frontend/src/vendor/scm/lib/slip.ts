
import { humanApiError } from './authed-fetch';
import { readAuthToken } from '../../../lib/authToken';
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromError,
  requestIdFromResponse,
} from '../../../lib/requestCorrelation';
import { companyHeader } from '../../../lib/activeCompany';
import { isCompressibleImage, prepareImageForUpload } from '../../../lib/imagePipeline';
import { runOneAiRead } from './ai-read-job';

const API_URL =
  ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_URL
    || (import.meta.env.PROD ? '' : 'https://autocount-sync-api.houzs-erp.workers.dev')) + '/api/scm';

const token = (): string => {
  const t = readAuthToken();
  if (!t) throw new Error('Your session has expired — please sign in again.');
  return t;
};


const SLIP_UPLOAD_TIMEOUT_MS = 120_000;
const SLIP_TIMEOUT_MS = 60_000;

async function slipFetch(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let signal: AbortSignal | undefined;
  try { signal = AbortSignal.timeout(timeoutMs); } catch { signal = undefined; }
  try {
    return await correlatedFetch(input, { ...init, signal });
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw correlateError(
        new Error('The request took too long — please check your connection and try again.'),
        requestIdFromError(e),
      );
    }
    throw e;
  }
}

export type SlipUrlResponse = { url: string; contentType: string };
export type SlipInitRequest = {
  fileSize: number;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  contentHash: string;
  purpose?: SlipPurpose;
  fieldContext?: string;
};
export type SlipPurpose = 'field_photo';
export type SlipInitResponse = { uploadSessionId: string; r2Key: string };
export type SlipConfirmResponse = { ok: boolean };

export const ALLOWED_SLIP_MIMES = [
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
] as const;
export const MAX_SLIP_SIZE_BYTES = 5 * 1024 * 1024;

async function fetchSlipAsObjectUrl(path: string): Promise<SlipUrlResponse> {
  const res = await slipFetch(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${token()}`, ...companyHeader() },
  }, SLIP_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw correlateError(new Error(humanApiError(res.status, text)), requestIdFromResponse(res));
  }
  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  return consumeCorrelated(res, async () => ({
    url: URL.createObjectURL(await res.blob()),
    contentType,
  }));
}

/** A manufacturing Sales Order's payment slip, as a blob object URL. */
export async function fetchSoSlipUrl(docNo: string): Promise<SlipUrlResponse> {
  return fetchSlipAsObjectUrl(`/mfg-sales-orders/${encodeURIComponent(docNo)}/slip-url`);
}

/** A single SO payment row's slip, as a blob object URL. */
export async function fetchPaymentSlipUrl(
  docNo: string,
  paymentId: string,
): Promise<SlipUrlResponse> {
  return fetchSlipAsObjectUrl(
    `/mfg-sales-orders/${encodeURIComponent(docNo)}/payments/${encodeURIComponent(paymentId)}/slip-url`,
  );
}

/** The slip a payment BACKDATE REQUEST carries (GET
 *  /payment-backdate-requests/:id/slip-url) — the admin inbox drawer reads it
 *  before deciding. Admin only on the server, like the inbox. */
export async function fetchBackdateRequestSlipUrl(requestId: string): Promise<SlipUrlResponse> {
  return fetchSlipAsObjectUrl(`/payment-backdate-requests/${encodeURIComponent(requestId)}/slip-url`);
}

/** Authed GET of a scanned "Original Slip" image (GET /scan-so/slip-image?key=…)
 *  as a blob → object URL the SO detail page hands to <img src>. Mirrors the
 *  bearer-token proxy fetch used for payment slips; the caller is responsible
 *  for URL.revokeObjectURL() when the image is unmounted. */
export async function fetchScanSlipImageBlobUrl(key: string): Promise<string> {
  const res = await slipFetch(`${API_URL}/scan-so/slip-image?key=${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${token()}`, ...companyHeader() },
  }, SLIP_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw correlateError(new Error(humanApiError(res.status, text)), requestIdFromResponse(res));
  }
  return consumeCorrelated(res, async () => URL.createObjectURL(await res.blob()));
}

export type ScanPaymentMatch = { value: string; confidence: number; reason: string };
export type ScanPaymentReceipt = {
  paymentMethodMatch:   ScanPaymentMatch | null;
  bankMatch:            ScanPaymentMatch | null;
  onlineTypeMatch:      ScanPaymentMatch | null;
  installmentPlanMatch: ScanPaymentMatch | null;
  approvalCode:         string | null;
  amountRm:             number | null;
  paidAt:               string | null;
};

export async function scanPaymentReceipt(file: File): Promise<ScanPaymentReceipt> {
  const form = new FormData();
  form.append('file', file);
  const json = await runOneAiRead<{ data?: { extracted?: ScanPaymentReceipt } }>('/scan-payment/extract', form, null);
  const extracted = json.data?.extracted;
  if (!extracted) throw new Error("We couldn't read any details from that receipt photo. Please fill the payment in manually.");
  return extracted;
}

export async function sha256Hex(file: File | Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function initSlipUpload(file: File, purpose: SlipPurpose | null, fieldContext: string | null): Promise<SlipInitResponse> {
  const hash = await sha256Hex(file);
  const body: SlipInitRequest = {
    fileSize: file.size,
    contentType: file.type as SlipInitRequest['contentType'],
    contentHash: hash,
    ...(purpose ? { purpose } : {}),
    ...(fieldContext ? { fieldContext } : {}),
  };
  const res = await slipFetch(`${API_URL}/slips/init`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
      ...companyHeader(),
    },
    body: JSON.stringify(body),
  }, SLIP_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw correlateError(new Error(humanApiError(res.status, text)), requestIdFromResponse(res));
  }
  return consumeCorrelated(res, () => res.json() as Promise<SlipInitResponse>);
}

async function uploadSlipBytes(sessionId: string, file: File): Promise<void> {
  const res = await slipFetch(`${API_URL}/slips/${encodeURIComponent(sessionId)}/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': file.type,
      ...companyHeader(),
    },
    body: file,
  }, SLIP_UPLOAD_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw correlateError(new Error(humanApiError(res.status, text)), requestIdFromResponse(res));
  }
}

async function confirmUpload(sessionId: string): Promise<SlipConfirmResponse> {
  const res = await slipFetch(`${API_URL}/slips/${sessionId}/confirm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}`, ...companyHeader() },
  }, SLIP_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw correlateError(new Error(humanApiError(res.status, text)), requestIdFromResponse(res));
  }
  return consumeCorrelated(res, () => res.json() as Promise<SlipConfirmResponse>);
}

export type SlipUploadPhase = 'init' | 'put' | 'confirm';

export interface UploadSlipOptions {
  file: File;
  onProgress?: (phase: SlipUploadPhase) => void;
}

export interface UploadSlipResult {
  uploadSessionId: string;
  r2Key: string;
}

export async function uploadSlipFull(opts: UploadSlipOptions): Promise<UploadSlipResult> {
  return uploadSlipAs(opts, null, null);
}

/** A POD / job-stop photo, uploaded the moment it is taken (FieldPhotos). Same
 *  pipeline and compression as uploadSlipFull; the session is held a day so the
 *  photo is still there when the crew taps Complete. */
export async function uploadFieldPhoto(opts: UploadSlipOptions & {
  context: string | null;
}): Promise<UploadSlipResult> {
  return uploadSlipAs(opts, 'field_photo', opts.context);
}

/** The stop a field photo belongs to, as the server stores it. One home, so the
 *  upload and the re-list after a reload always name the stop the same way. */
export function fieldPhotoContext(stop: { kind: 'do'; doId: string } | { kind: 'job'; key: string }): string {
  return stop.kind === 'do' ? `do:${stop.doId}` : `job:${stop.key}`;
}

export type UploadedFieldPhoto = { uploadSessionId: string; r2Key: string; contentType: string | null; createdAt: string };

/** Field photos the caller already uploaded for this stop and no Complete has
 *  claimed yet - what a reloaded screen shows again. */
export async function listFieldPhotos(context: string): Promise<UploadedFieldPhoto[]> {
  const res = await slipFetch(`${API_URL}/slips/field-photos?context=${encodeURIComponent(context)}`, {
    headers: { authorization: `Bearer ${token()}`, ...companyHeader() },
  }, SLIP_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw correlateError(new Error(humanApiError(res.status, text)), requestIdFromResponse(res));
  }
  const json = await consumeCorrelated(res, () => res.json() as Promise<{ photos?: UploadedFieldPhoto[] }>);
  return json.photos ?? [];
}

/** The API path of one uploaded field photo (auth-protected; fetch as a blob). */
export function fieldPhotoImagePath(uploadSessionId: string): string {
  return `/api/scm/slips/field-photos/${encodeURIComponent(uploadSessionId)}/image`;
}

/** The crew removed an uploaded photo: drop it from the re-list (the server
 *  expires the session and the reaper deletes it). */
export async function discardFieldPhoto(uploadSessionId: string): Promise<void> {
  const res = await slipFetch(`${API_URL}/slips/field-photos/${encodeURIComponent(uploadSessionId)}/discard`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token()}`, ...companyHeader() },
  }, SLIP_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw correlateError(new Error(humanApiError(res.status, text)), requestIdFromResponse(res));
  }
}

async function uploadSlipAs(opts: UploadSlipOptions, purpose: SlipPurpose | null, fieldContext: string | null): Promise<UploadSlipResult> {
  let file = opts.file;
  if (isCompressibleImage(file)) {
    const prepared = await prepareImageForUpload(file, { wantThumb: false });
    file = prepared.file;
    if (file.size > MAX_SLIP_SIZE_BYTES) {
      throw new Error(
        'This photo is still over 5 MB after compression - please retake it at a lower resolution.',
      );
    }
  }

  opts.onProgress?.('init');
  const init = await initSlipUpload(file, purpose, fieldContext);

  opts.onProgress?.('put');
  let putErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await uploadSlipBytes(init.uploadSessionId, file);
      putErr = undefined;
      break;
    } catch (err) {
      putErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (putErr) throw putErr;

  opts.onProgress?.('confirm');
  await confirmUpload(init.uploadSessionId);
  return { uploadSessionId: init.uploadSessionId, r2Key: init.r2Key };
}
