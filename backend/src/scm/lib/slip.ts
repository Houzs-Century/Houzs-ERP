import type { R2Bucket } from '@cloudflare/workers-types';

export interface SlipEnv {
  SLIPS?: R2Bucket;
}

export interface SlipBindings {
  bucket: R2Bucket;
}

export function slipBindings(env: SlipEnv): SlipBindings {
  if (!env.SLIPS) throw new Error('R2 binding SLIPS not configured');
  return { bucket: env.SLIPS };
}

export function hashesMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function isExpired(isoTimestamp: string): boolean {
  return new Date(isoTimestamp).getTime() < Date.now();
}

export function expiresInOneHour(now = new Date()): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
}

export const FIELD_PHOTO_HOLD_HOURS = 24;

export type SlipPurpose = 'field_photo';

export function parseSlipPurpose(raw: unknown): SlipPurpose | null {
  return raw === 'field_photo' ? 'field_photo' : null;
}

export function slipSessionExpiry(purpose: SlipPurpose | null, now = new Date()): string {
  if (purpose === 'field_photo') return new Date(now.getTime() + FIELD_PHOTO_HOLD_HOURS * 60 * 60 * 1000).toISOString();
  return expiresInOneHour(now);
}

export const FIELD_PHOTO_CONTEXT_MAX = 200;

export function parseFieldPhotoContext(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > FIELD_PHOTO_CONTEXT_MAX) return null;
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

export function fieldPhotoOwnerPrefix(houzsUserId: number): string {
  return `field:u${houzsUserId}:`;
}

export function fieldPhotoDraftId(houzsUserId: number, context: string): string {
  return `${fieldPhotoOwnerPrefix(houzsUserId)}${context}`;
}

export function parseFieldPhotoDraftId(draftId: string | null | undefined): { uploaderId: number; context: string } | null {
  const m = /^field:u(\d+):(.*)$/s.exec(draftId ?? '');
  if (!m) return null;
  const uploaderId = Number(m[1]);
  return Number.isSafeInteger(uploaderId) ? { uploaderId, context: m[2]! } : null;
}
