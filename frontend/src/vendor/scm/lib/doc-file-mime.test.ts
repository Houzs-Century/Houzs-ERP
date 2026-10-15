/* The MIME a picked file is sent as (owner 2026-10-15: attach 不到 pdf) — the
   extension decides when the browser gives no type or one the server refuses. */
import { describe, expect, test } from 'vitest';
import { DOC_FILE_ACCEPT, docFileMime } from './doc-file-mime';

describe('docFileMime', () => {
  test('a type the server takes is kept', () => {
    for (const t of DOC_FILE_ACCEPT.split(',')) expect(docFileMime({ name: 'x.bin', type: t })).toBe(t);
  });
  test('no type: the extension decides', () => {
    expect(docFileMime({ name: 'Quotation OCT.PDF', type: '' })).toBe('application/pdf');
    expect(docFileMime({ name: 'IMG_0012.JPG', type: '' })).toBe('image/jpeg');
    expect(docFileMime({ name: 'sketch.jpeg', type: '' })).toBe('image/jpeg');
    expect(docFileMime({ name: 'plan.png', type: '' })).toBe('image/png');
    expect(docFileMime({ name: 'swatch.webp', type: '' })).toBe('image/webp');
  });
  test('a stray spelling with a known extension reads as the real one', () => {
    expect(docFileMime({ name: 'scan.pdf', type: 'application/x-pdf' })).toBe('application/pdf');
    expect(docFileMime({ name: 'scan.jpg', type: 'image/jpg' })).toBe('image/jpeg');
    expect(docFileMime({ name: 'scan', type: 'application/x-pdf' })).toBe('application/pdf');
  });
  test('an unknown type with no known extension is sent as given, so the server can refuse it by name', () => {
    expect(docFileMime({ name: 'notes.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(docFileMime({ name: 'noext', type: '' })).toBe('application/pdf');
  });
});
