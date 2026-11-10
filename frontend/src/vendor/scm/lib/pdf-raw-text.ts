import { inflateSync } from 'node:zlib';

/* TEST-ONLY. The PDF as latin1 text with every Flate-compressed stream
   inflated in place, so a test can search the drawn text and operators. Since
   PDF_COMPRESS the content streams are compressed and a plain latin1 read of
   the bytes no longer contains them. A stream that does not inflate (a JPEG)
   is kept as it is. */
export function pdfRawText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  return raw.replace(/stream\r?\n([\s\S]*?)\r?\nendstream/g, (whole, body: string) => {
    try {
      return `stream\n${inflateSync(Buffer.from(body, 'latin1')).toString('latin1')}\nendstream`;
    } catch {
      return whole;
    }
  });
}
