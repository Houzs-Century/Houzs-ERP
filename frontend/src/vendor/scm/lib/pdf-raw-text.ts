import { inflateSync } from 'node:zlib';

/* TEST-ONLY. The PDF as latin1 text with every Flate-compressed stream
   inflated in place, so a test can search the drawn text and operators. Since
   PDF_COMPRESS the content streams are compressed and a plain latin1 read of
   the bytes no longer contains them. A stream that does not inflate (a JPEG)
   is kept as it is. */
export function pdfRawText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  /* jsPDF writes exactly "stream\n<data>\nendstream". An optional \r in the
     pattern ate a compressed stream whose last byte was 0x0D, so it failed to
     inflate and a test missed its text — only for some timestamps. */
  return raw.replace(/stream\n([\s\S]*?)\nendstream/g, (whole, body: string) => {
    try {
      return `stream\n${inflateSync(Buffer.from(body, 'latin1')).toString('latin1')}\nendstream`;
    } catch {
      return whole;
    }
  });
}
