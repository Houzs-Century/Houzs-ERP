/* HC-0129 — the Pickup / Return tracking options the screens offer must be the
 * ones the server's PATCH accepts: this file and the server's copy are the same bytes. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { pickupTrackingError, pickupTrackingOptions, PICKUP_STATUS_OPTIONS } from './assr-pickup-tracking';

const norm = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

describe('one pickup-tracking rule for the server and the screens', () => {
  test('backend/src/scm/shared/assr-pickup-tracking.ts is byte-identical to this one', () => {
    expect(norm('../backend/src/scm/shared/assr-pickup-tracking.ts')).toBe(norm('src/vendor/scm/lib/assr-pickup-tracking.ts'));
  });

  test('every offered option (and the blank) passes the server check', () => {
    for (const o of pickupTrackingOptions(PICKUP_STATUS_OPTIONS)) {
      expect(pickupTrackingError({ pickup_status: o.value === '' ? null : o.value })).toBeNull();
    }
  });
});
