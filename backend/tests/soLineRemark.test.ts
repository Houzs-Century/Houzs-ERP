import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { soLineRemark } from '../src/scm/lib/so-line-remark';

describe('soLineRemark (gap review P7: desktop New SO line remark was dropped)', () => {
  it('keeps the remark the desktop form posts as the line field', () => {
    expect(soLineRemark({ remark: '  deliver after 3pm ', variants: {} })).toBe('deliver after 3pm');
  });

  it('keeps the phone / POS remark in variants', () => {
    expect(soLineRemark({ variants: { remark: 'left side to wall' } })).toBe('left side to wall');
  });

  it('prefers the line field when both are present', () => {
    expect(soLineRemark({ remark: 'typed', variants: { remark: 'old' } })).toBe('typed');
  });

  it('falls back to variants when the line field is blank', () => {
    expect(soLineRemark({ remark: '   ', variants: { remark: 'pos note' } })).toBe('pos note');
  });

  it('is null when neither carries text', () => {
    expect(soLineRemark({})).toBeNull();
    expect(soLineRemark({ remark: '', variants: null })).toBeNull();
    expect(soLineRemark({ remark: 5, variants: { remark: 7 } })).toBeNull();
  });

  it('is what the SO create writes into the remark column', () => {
    const src = readFileSync(new URL('../src/scm/routes/mfg-sales-orders.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/remark: soLineRemark\(it\),/);
  });
});
