// ----------------------------------------------------------------------------
// autocount-photo-attach — put the line photographs on an /edit body at send
// time, without making the body too large for the host to accept.
//
// Moved out of autocount-outbox.ts's drain (at its 2,000-line cap) with one
// rule added, docs/bugs/0899: AcSyncService refuses any request over
// `MaxBody` (2 MiB, AcSyncService.cs) with HTTP 413 "body too large", and the
// drain attached every line photograph as base64, so ONE phone photo was
// enough to refuse the whole edit — price, dates, balance and all. Measured
// 2026-09-14 on the three orders refused that way (HC-SO-2609-063,
// HC-SO-012388, HC-SO-013496): each carries exactly one photograph, of 2.19,
// 2.30 and 4.20 MB, i.e. 2.9 to 5.6 MB once encoded.
//
// THE RULES, both inherited and one new:
//   - per LINE, all of its pictures or none: the host replaces the line's
//     FurtherDescription with what it is given, so a short list would overwrite
//     five pictures with three, and an absent key leaves the book's own;
//   - a picture the bucket cannot answer drops its line's pictures, never the
//     document (a photograph is not the document);
//   - NEW: a line whose pictures would take the body past the host's limit is
//     sent without them, and the send says so, so the rest of the edit lands.
// ----------------------------------------------------------------------------

/** AcSyncService.cs `const int MaxBody = 2 * 1024 * 1024`. */
export const AC_HOST_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Room for the JSON punctuation and anything the drain adds after sizing. */
const BODY_HEADROOM_BYTES = 64 * 1024;

/** The sentence a sent row carries when pictures were left behind. The health
 *  check keys on it to list these apart from line-identity gaps. */
export const PHOTOS_NOT_SENT_PREFIX = 'PHOTOS NOT SENT:';

/**
 * Formats AutoCount's image service CANNOT decode. It reads the bytes with the
 * .NET image decoder (GDI+), which supports JPEG, PNG, GIF, BMP and TIFF but
 * NOT these — a WebP sent under the `Jpeg` key made the host throw the bare
 * "Parameter is not valid." and take the WHOLE edit with it (HC-SO-2609-080,
 * two .webp line photos). We drop only KNOWN-unsupported extensions and attach
 * everything else, so a key with no extension (a test key) or a supported one
 * is unaffected. The remedy for a dropped picture is to re-save it as JPEG.
 */
export const PHOTO_UNDECODABLE_EXT: ReadonlySet<string> = new Set([
  'webp', 'heic', 'heif', 'avif', 'svg', 'jxl',
]);
export const PHOTOS_BAD_FORMAT_PREFIX = 'PHOTOS NOT SENT (format):';

const photoExt = (key: string): string => {
  const base = key.split('/').pop() ?? key;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
};
export const isUndecodablePhoto = (key: string): boolean => PHOTO_UNDECODABLE_EXT.has(photoExt(key));

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;
/* `{"Jpeg":""}` plus a separator, per picture. */
const PER_PICTURE_JSON = 12;

export interface PhotoLineCost {
  dtlKey: number;
  /** Raw byte length of each picture on the line. */
  sizes: number[];
}

/**
 * Which lines' pictures fit, in the order given. Pure.
 *
 * Greedy in payload order, so the answer is stable for a given document: a
 * line that fits is attached, a line that would cross the limit is not, and a
 * later, smaller line may still fit.
 */
export function planPhotoBudget(
  baseBodyBytes: number,
  lines: readonly PhotoLineCost[],
  limit: number = AC_HOST_MAX_BODY_BYTES,
): { attach: number[]; tooLarge: Array<{ dtlKey: number; bytes: number }> } {
  let running = baseBodyBytes + BODY_HEADROOM_BYTES;
  const attach: number[] = [];
  const tooLarge: Array<{ dtlKey: number; bytes: number }> = [];
  for (const l of lines) {
    const cost = l.sizes.reduce((n, s) => n + base64Length(s) + PER_PICTURE_JSON, 0);
    if (running + cost <= limit) {
      attach.push(l.dtlKey);
      running += cost;
    } else {
      tooLarge.push({ dtlKey: l.dtlKey, bytes: l.sizes.reduce((n, s) => n + s, 0) });
    }
  }
  return { attach, tooLarge };
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

type PhotoBucket = { get: (key: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> };

/**
 * Attach `Photos` to the matching lines of `body` in place.
 *
 * @returns a sentence for the row when a line's pictures were left behind for
 *   size, else null. Unreadable pictures are logged and not reported here,
 *   exactly as before this module existed.
 */
export async function attachPhotos(
  env: unknown,
  body: Record<string, unknown>,
  photos: ReadonlyArray<{ dtlKey: number; keys: string[] }>,
  label: string,
): Promise<string | null> {
  const bucket = (env as { SO_ITEM_PHOTOS?: PhotoBucket }).SO_ITEM_PHOTOS;
  const lines = Array.isArray(body.Lines) ? (body.Lines as Array<Record<string, unknown>>) : [];

  const fetched: Array<{ line: Record<string, unknown>; dtlKey: number; bufs: ArrayBuffer[] }> = [];
  /* Pictures in a format AutoCount's image service cannot decode (WebP, HEIC …):
     dropped so the whole edit is not lost to "Parameter is not valid.", noted so
     the row says why. Same shape of decision as a too-large picture below. */
  const badFormat: Array<{ dtlKey: number; exts: string[] }> = [];
  for (const want of photos) {
    const line = lines.find((l) => Number(l.DtlKey) === want.dtlKey);
    if (!line || !want.keys.length) continue;
    const undecodable = want.keys.filter(isUndecodablePhoto);
    if (undecodable.length) badFormat.push({ dtlKey: want.dtlKey, exts: [...new Set(undecodable.map(photoExt))] });
    const usable = want.keys.filter((k) => !isUndecodablePhoto(k));
    if (!usable.length) continue;
    try {
      const bufs: ArrayBuffer[] = [];
      for (const key of usable) {
        const obj = await bucket?.get(key);
        if (!obj) throw new Error(`photo not in the bucket: ${key}`);
        bufs.push(await obj.arrayBuffer());
      }
      fetched.push({ line, dtlKey: want.dtlKey, bufs });
    } catch (e) {
      console.warn(`photos not attached to ${label} line ${want.dtlKey}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const notes: string[] = [];
  if (badFormat.length) {
    const which = badFormat.map((b) => `line ${b.dtlKey} (${b.exts.join('/')})`).join(', ');
    notes.push(`${PHOTOS_BAD_FORMAT_PREFIX} ${badFormat.length} line(s) carry a picture in a format `
      + `AutoCount's image service cannot read: ${which}. The document was sent without them; re-save the picture as JPEG to carry it.`);
  }

  if (fetched.length) {
    const baseBodyBytes = new TextEncoder().encode(JSON.stringify(body)).length;
    const plan = planPhotoBudget(baseBodyBytes, fetched.map((f) => ({ dtlKey: f.dtlKey, sizes: f.bufs.map((b) => b.byteLength) })));
    const fits = new Set(plan.attach);
    for (const f of fetched) {
      if (fits.has(f.dtlKey)) f.line.Photos = f.bufs.map((b) => ({ Jpeg: b64(b) }));
    }
    if (plan.tooLarge.length) {
      const mb = (n: number) => (n / 1024 / 1024).toFixed(2);
      const which = plan.tooLarge.map((t) => `line ${t.dtlKey} (${mb(t.bytes)} MB)`).join(', ');
      notes.push(`${PHOTOS_NOT_SENT_PREFIX} ${plan.tooLarge.length} line(s) carry photographs too large for AutoCount's service to `
        + `accept in one request (${mb(AC_HOST_MAX_BODY_BYTES)} MB): ${which}. The document was sent without them, and the `
        + 'book keeps the pictures it had on those lines.');
    }
  }

  return notes.length ? notes.join(' ') : null;
}
