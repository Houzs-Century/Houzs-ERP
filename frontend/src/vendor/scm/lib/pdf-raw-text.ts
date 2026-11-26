import { inflateSync } from 'node:zlib';

export function pdfRawText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  return raw.replace(/stream\n([\s\S]*?)\nendstream/g, (whole, body: string) => {
    try {
      return `stream\n${inflateSync(Buffer.from(body, 'latin1')).toString('latin1')}\nendstream`;
    } catch {
      return whole;
    }
  });
}
