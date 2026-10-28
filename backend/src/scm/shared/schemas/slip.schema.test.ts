import { describe, it, expect } from 'vitest';
import {
  SlipInitRequestSchema,
  SlipConfirmRequestSchema,
  ALLOWED_SLIP_MIMES,
  MAX_SLIP_SIZE_BYTES,
} from './slip.schema';

describe('SlipInitRequestSchema', () => {
  const valid = {
    fileSize: 1024,
    contentType: 'image/jpeg' as const,
    contentHash: 'a'.repeat(64),
  };

  it('accepts a valid request', () => {
    expect(SlipInitRequestSchema.parse(valid)).toMatchObject(valid);
  });

  it('rejects fileSize > 5 MB', () => {
    expect(() => SlipInitRequestSchema.parse({ ...valid, fileSize: MAX_SLIP_SIZE_BYTES + 1 })).toThrow();
  });

  it('rejects fileSize <= 0', () => {
    expect(() => SlipInitRequestSchema.parse({ ...valid, fileSize: 0 })).toThrow();
  });

  it('rejects contentType not in whitelist', () => {
    expect(() => SlipInitRequestSchema.parse({ ...valid, contentType: 'text/plain' })).toThrow();
  });

  it('rejects contentHash not 64 hex chars', () => {
    expect(() => SlipInitRequestSchema.parse({ ...valid, contentHash: 'a'.repeat(63) })).toThrow();
    expect(() => SlipInitRequestSchema.parse({ ...valid, contentHash: 'g'.repeat(64) })).toThrow();
  });

  it('accepts optional orderDraftId', () => {
    expect(SlipInitRequestSchema.parse({ ...valid, orderDraftId: 'draft-abc' }))
      .toMatchObject({ orderDraftId: 'draft-abc' });
  });

  it('lists 4 allowed MIMEs', () => {
    expect(ALLOWED_SLIP_MIMES).toEqual(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
  });
});

describe('SlipConfirmRequestSchema', () => {
  it('accepts empty body', () => {
    expect(SlipConfirmRequestSchema.parse({})).toEqual({});
  });
});
