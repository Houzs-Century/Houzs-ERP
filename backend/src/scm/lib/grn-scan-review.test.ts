// Unit tests for the GR OCR learning writer — fired on a GRN DRAFT -> POSTED.
// A scanned GRN's extraction is promoted EXTRACTED -> ACCEPTED (feeding the GR
// few-shot pool); a GRN that never came from a scan, or an already-reviewed
// sample, is left untouched. Driven through the same hand-rolled PostgREST
// stand-in the SO review tests use.
import { describe, expect, test } from 'vitest';
import { noteGrnScanAccepted } from './grn-scan-review';

type Row = Record<string, any>;

function fakeSvc(tables: Record<string, Row[]>, opts?: { throwOn?: string }) {
  const updates: Array<{ table: string; patch: Row; rows: Row[] }> = [];
  class Q {
    private preds: Array<(r: Row) => boolean> = [];
    private op: 'select' | 'update' = 'select';
    private patch: Row = {};
    private cap: number | null = null;
    constructor(private rows: Row[], private table: string) {}
    select() { return this; }
    order() { return this; }
    limit(n: number) { this.cap = n; return this; }
    update(p: Row) { this.op = 'update'; this.patch = p; return this; }
    eq(c: string, v: unknown) { this.preds.push((r) => String(r[c]) === String(v)); return this; }
    not(c: string, op: string, v: unknown) {
      if (op === 'is' && v === null) this.preds.push((r) => r[c] != null);
      return this;
    }
    private run(): Row[] {
      if (opts?.throwOn === this.table) throw new Error(`boom: ${this.table}`);
      let hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
      if (this.cap != null) hit = hit.slice(0, this.cap);
      if (this.op === 'update') {
        updates.push({ table: this.table, patch: this.patch, rows: [...hit] });
        for (const r of hit) Object.assign(r, this.patch);
      }
      return hit;
    }
    maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
    then(res: (v: any) => any, rej?: (e: any) => any) {
      let out: { data: Row[]; error: null };
      try { out = { data: this.run(), error: null }; } catch (e) { return Promise.reject(e).then(res, rej); }
      return Promise.resolve(out).then(res, rej);
    }
  }
  return { svc: { from: (t: string) => new Q((tables[t] ||= []), t) } as never, updates, tables };
}

const GRN = 'HC-GRN-2609-011';

describe('noteGrnScanAccepted', () => {
  test('promotes a scanned GRN sample EXTRACTED -> ACCEPTED', async () => {
    const extracted = { poNo: 'PO-010070', lines: [{ itemCode: 'A', qty: 1 }] };
    const h = fakeSvc({
      scan_jobs: [{ id: 'j1', linked_doc_no: GRN, document_type: 'GR', sample_id: 's1', created_at: '2026-09-18' }],
      so_scan_samples: [{ id: 's1', status: 'EXTRACTED', extracted }],
    });
    await noteGrnScanAccepted(h.svc, GRN);
    const sample = h.tables.so_scan_samples[0];
    expect(sample.status).toBe('ACCEPTED');
    expect(sample.corrected).toEqual(extracted);
  });

  test('no scan job for this GRN -> no update', async () => {
    const h = fakeSvc({
      scan_jobs: [{ id: 'j1', linked_doc_no: 'OTHER', document_type: 'GR', sample_id: 's1', created_at: '2026-09-18' }],
      so_scan_samples: [{ id: 's1', status: 'EXTRACTED', extracted: {} }],
    });
    await noteGrnScanAccepted(h.svc, GRN);
    expect(h.updates).toHaveLength(0);
    expect(h.tables.so_scan_samples[0].status).toBe('EXTRACTED');
  });

  test('an already-reviewed (non-EXTRACTED) sample is left alone', async () => {
    const h = fakeSvc({
      scan_jobs: [{ id: 'j1', linked_doc_no: GRN, document_type: 'GR', sample_id: 's1', created_at: '2026-09-18' }],
      so_scan_samples: [{ id: 's1', status: 'ACCEPTED', extracted: {}, corrected: { done: true } }],
    });
    await noteGrnScanAccepted(h.svc, GRN);
    // The update is gated on status='EXTRACTED', so it matches 0 rows.
    const applied = h.updates.filter((u) => u.rows.length > 0);
    expect(applied).toHaveLength(0);
    expect(h.tables.so_scan_samples[0].corrected).toEqual({ done: true });
  });

  test('empty grn number is a no-op', async () => {
    const h = fakeSvc({ scan_jobs: [], so_scan_samples: [] });
    await noteGrnScanAccepted(h.svc, '');
    expect(h.updates).toHaveLength(0);
  });

  test('never throws when the DB blows up', async () => {
    const h = fakeSvc({ scan_jobs: [] }, { throwOn: 'scan_jobs' });
    await expect(noteGrnScanAccepted(h.svc, GRN)).resolves.toBeUndefined();
  });
});
