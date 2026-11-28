import { z } from 'zod';

export const ALLOWED_SLIP_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const MAX_SLIP_SIZE_BYTES = 5 * 1024 * 1024;

const HEX64 = /^[a-f0-9]{64}$/;

export const SlipInitRequestSchema = z.object({
  fileSize: z.number().int().positive().max(MAX_SLIP_SIZE_BYTES),
  contentType: z.enum(ALLOWED_SLIP_MIMES),
  contentHash: z.string().regex(HEX64, 'must be 64 lowercase hex chars (sha256)'),
  orderDraftId: z.string().min(1).max(64).optional(),
});

export const SlipInitResponseSchema = z.object({
  uploadSessionId: z.string().uuid(),
  r2Key: z.string(),
});

export const SlipConfirmRequestSchema = z.object({}).strict();

export const SlipConfirmResponseSchema = z.object({
  status: z.literal('uploaded'),
  r2Key: z.string(),
});

export const SlipUrlResponseSchema = z.object({
  url: z.string(),
  contentType: z.string(),
});

export type SlipInitRequest = z.infer<typeof SlipInitRequestSchema>;
export type SlipInitResponse = z.infer<typeof SlipInitResponseSchema>;
export type SlipConfirmResponse = z.infer<typeof SlipConfirmResponseSchema>;
export type SlipUrlResponse = z.infer<typeof SlipUrlResponseSchema>;
