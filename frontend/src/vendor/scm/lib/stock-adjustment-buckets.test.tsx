import { useState } from 'react';
import { describe, expect, test } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { bucketKey, NO_BUCKET_PICKED, type AdjustBucket } from './stock-adjustment-buckets';

/* The DECREASE picker used to identify the chosen bucket by "variant_key ||
 * batch_no". The no-variant, no-batch bucket has both empty, so picking it was
 * indistinguishable from picking nothing — the <select> reverted to its
 * placeholder and the save gate kept blocking, leaving that lot un-decreasable
 * (owner report 2026-09-17: AMN-SOFA PILLOW no-batch stock at KL warehouse). */
describe('bucketKey — the DECREASE picker identity', () => {
  test('the no-variant, no-batch bucket has a non-empty key, distinct from "nothing picked"', () => {
    const key = bucketKey({ variant_key: '', batch_no: null });
    expect(key).not.toBe(NO_BUCKET_PICKED);
    expect(key.length).toBeGreaterThan(0);
  });

  test('a no-batch bucket and a batched bucket of the same SKU get different keys', () => {
    const plain = bucketKey({ variant_key: '', batch_no: null });
    const batched = bucketKey({ variant_key: '', batch_no: 'HC-PO-009981' });
    expect(plain).not.toBe(batched);
  });

  test('a variant-only bucket and a batch-only bucket do not collide', () => {
    // A space-joined key blurred these ("A " vs " A"); the JSON key keeps them apart.
    expect(bucketKey({ variant_key: 'A', batch_no: null }))
      .not.toBe(bucketKey({ variant_key: '', batch_no: 'A' }));
  });

  test('round-trips: every bucket is found again by its own key', () => {
    const buckets: AdjustBucket[] = [
      { variant_key: '', batch_no: null },
      { variant_key: '', batch_no: 'HC-PO-009981' },
      { variant_key: 'FABRIC-BLUE', batch_no: null },
    ];
    for (const b of buckets) {
      const found = buckets.find((x) => bucketKey(x) === bucketKey(b));
      expect(found).toBe(b);
    }
    expect(buckets.map(bucketKey)).not.toContain(NO_BUCKET_PICKED);
  });
});

/* Exercises the real <select> mechanism the fix relies on: a controlled select
 * whose value is the picked bucket key and whose options are keyed by bucketKey.
 * The no-batch bucket must select and STICK — the exact interaction the page's
 * "Take from" picker rebuilds it around. */
function TakeFromPicker({ buckets, onPicked }: { buckets: AdjustBucket[]; onPicked: (k: string) => void }) {
  const [pickedKey, setPickedKey] = useState<string>(NO_BUCKET_PICKED);
  return (
    <select
      aria-label="take-from"
      value={pickedKey}
      onChange={(e) => { setPickedKey(e.target.value); onPicked(e.target.value); }}
    >
      <option value={NO_BUCKET_PICKED}>— Pick which batch / variant —</option>
      {buckets.map((b) => (
        <option key={bucketKey(b)} value={bucketKey(b)}>
          {(b.batch_no || 'No batch')} · {(b.variant_key || 'plain')}
        </option>
      ))}
    </select>
  );
}

describe('the "Take from" select round-trips the no-batch bucket', () => {
  test('picking the no-batch lot reports its key and the select keeps it selected', () => {
    const picks: string[] = [];
    const buckets: AdjustBucket[] = [
      { variant_key: '', batch_no: null },            // 190 pcs, no batch — the one that was stuck
      { variant_key: '', batch_no: 'HC-PO-009981' },  // 10 pcs, batched
    ];
    render(<TakeFromPicker buckets={buckets} onPicked={(k) => picks.push(k)} />);
    const select = screen.getByLabelText('take-from') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: bucketKey(buckets[0]) } });

    // the change reported the no-batch bucket's key, not the empty placeholder
    expect(picks.at(-1)).toBe(bucketKey(buckets[0]));
    expect(picks.at(-1)).not.toBe(NO_BUCKET_PICKED);
    // controlled select shows the picked option, so save is no longer blocked
    expect(select.value).toBe(bucketKey(buckets[0]));
  });
});
