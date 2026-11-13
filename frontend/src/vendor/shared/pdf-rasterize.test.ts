import { describe, it, expect } from 'vitest';
import { hasUnreadableImageCodec } from './pdf-rasterize';

const pdf = (body: string) => new TextEncoder().encode(`%PDF-1.4\n${body}\n%%EOF`);

describe('hasUnreadableImageCodec', () => {
  it('flags a scanner PDF with fax-coded pages (Hookka DO-2611-037)', () => {
    expect(hasUnreadableImageCodec(pdf('5 0 obj << /Type /XObject /Subtype /Image /Filter /CCITTFaxDecode /DecodeParms << /K -1 >> >>'))).toBe(true);
  });

  it('flags JBIG2 pages', () => {
    expect(hasUnreadableImageCodec(pdf('<< /Subtype /Image /Filter /JBIG2Decode >>'))).toBe(true);
  });

  it('leaves a PDF of JPEG or Flate images alone', () => {
    expect(hasUnreadableImageCodec(pdf('<< /Subtype /Image /Filter /DCTDecode >> << /Filter /FlateDecode >>'))).toBe(false);
  });
});
