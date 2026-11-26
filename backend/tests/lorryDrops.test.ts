import { describe, expect, it } from 'vitest';
import { shapeDrops } from '../src/scm/lib/lorry-drops';

describe('shapeDrops', () => {
  it('skips rows with no coordinates, labels, and orders by time', () => {
    const out = shapeDrops(
      [
        { id: 'd1', do_number: 'DO-1', debtor_name: 'Ali', pod_lat: 3.1, pod_lng: 101.6, pod_located_at: '2026-11-20T04:00:00Z', delivered_at: null },
        { id: 'd2', do_number: 'DO-2', debtor_name: null, pod_lat: null, pod_lng: null, pod_located_at: null, delivered_at: '2026-11-20T05:00:00Z' },
      ],
      [{ source_type: 'project', source_id: '9', leg: 'SETUP', pod_lat: 3.2, pod_lng: 101.7, pod_located_at: null, completed_at: '2026-11-20T02:00:00Z' }],
    );
    expect(out.map((d) => [d.kind, d.label])).toEqual([['job', 'SETUP 9'], ['do', 'DO-1 - Ali']]);
  });
});
