import { afterEach, describe, expect, test, vi } from 'vitest';
import { scanTimer } from './scan-timing';

// HC-0006 slice 1: a scan's time is split into stages so the slow one can be
// found. These pin what lands in the log line and the metrics point.

afterEach(() => vi.restoreAllMocks());

describe('scanTimer', () => {
  test('each mark gets the time since the previous mark, and done reports them', () => {
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(1000);
    const t = scanTimer('payment');
    clock.mockReturnValue(1200); t.mark('upload');
    clock.mockReturnValue(4200); t.mark('model');
    clock.mockReturnValue(4250); t.mark('parse');
    clock.mockReturnValue(4400); t.mark('save');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const writeDataPoint = vi.fn();
    t.done({ ERP_METRICS: { writeDataPoint } }, 'abc', 'ok');

    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      event: 'scan_timing', kind: 'payment', id: 'abc', outcome: 'ok',
      total_ms: 3400, upload_ms: 200, model_ms: 3000, parse_ms: 50, save_ms: 150, prep_ms: 0,
      save_sample_ms: 0, save_dup_ms: 0, save_create_ms: 0, save_tail_ms: 0,
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['scan|payment'],
      blobs: ['scan', 'payment', 'ok', 'abc'],
      doubles: [3400, 200, 3000, 50, 150, 0, 0, 0, 0, 0],
    });
  });

  test('a save part is charged on top of save, so save_ms keeps its old meaning', () => {
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    const t = scanTimer('so');
    clock.mockReturnValue(100); t.mark('save', 'sample');
    clock.mockReturnValue(400); t.mark('save', 'create');
    clock.mockReturnValue(1400); t.mark('save', 'create');
    clock.mockReturnValue(1450); t.mark('save', 'tail');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const writeDataPoint = vi.fn();
    t.done({ ERP_METRICS: { writeDataPoint } }, 'j', 'ok');

    const line = JSON.parse(String(log.mock.calls[0][0]));
    expect(line.save_ms).toBe(1450);
    expect([line.save_sample_ms, line.save_dup_ms, line.save_create_ms, line.save_tail_ms]).toEqual([100, 0, 1300, 50]);
    expect(writeDataPoint.mock.calls[0][0].doubles).toEqual([1450, 0, 0, 0, 1450, 0, 100, 0, 1300, 50]);
  });

  test('an unmarked stage reads 0, a null id reads empty, the outcome passes through', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    scanTimer('so').done({}, null, 'error');
    const line = JSON.parse(String(log.mock.calls[0][0]));
    expect(line.outcome).toBe('error');
    expect(line.id).toBe('');
    expect(line.model_ms).toBe(0);
  });

  test('a broken metrics binding never throws into the scan', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = { ERP_METRICS: { writeDataPoint: () => { throw new Error('boom'); } } };
    expect(() => scanTimer('pv').done(env, null, 'ok')).not.toThrow();
  });
});
