// readExportWindow — the `?offset=&limit=` of a windowed list export. A window
// larger than EXPORT_WINDOW would put one request back over the Worker
// subrequest cap, so no query string can ask for one.
import { describe, expect, it } from 'vitest';
import { EXPORT_WINDOW, readExportWindow } from './document-line-export';

const q = (params: Record<string, string>) => (key: string) => params[key];

describe('readExportWindow', () => {
  it('defaults to the first window of EXPORT_WINDOW documents', () => {
    expect(EXPORT_WINDOW).toBe(500);
    expect(readExportWindow(q({}))).toEqual({ offset: 0, limit: 500 });
  });

  it('reads a whole-number offset and a smaller limit', () => {
    expect(readExportWindow(q({ offset: '1000', limit: '200' }))).toEqual({ offset: 1000, limit: 200 });
  });

  it('never serves more than one window, and never an empty one', () => {
    expect(readExportWindow(q({ limit: '9999' })).limit).toBe(500);
    expect(readExportWindow(q({ limit: '0' })).limit).toBe(1);
  });

  it('reads anything that is not a whole number as the default', () => {
    for (const bad of ['-5', '1.5', 'abc', '', ' 10', '1e3']) {
      expect(readExportWindow(q({ offset: bad, limit: bad })), bad).toEqual({ offset: 0, limit: 500 });
    }
  });
});
