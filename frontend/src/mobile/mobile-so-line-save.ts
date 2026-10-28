export type MobileLineAddIntent = { addIdempotencyKey: string };

/** Headers for one mobile ADD intent. The key lives on the line draft, so the
 * same draft/retry sends the same key while another draft stays distinct. */
export function mobileLineAddHeaders(
  line: MobileLineAddIntent,
  leaseToken: string,
): Record<string, string> {
  return {
    'X-SO-Edit-Lease': leaseToken,
    'Idempotency-Key': line.addIdempotencyKey,
  };
}
