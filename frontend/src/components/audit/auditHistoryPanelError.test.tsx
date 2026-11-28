import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { AuditHistoryPanel } from './AuditHistoryPanel';
import type { AuditLabelDictionary, AuditLogEntry } from './audit-labels';

const findSrc = (): string => {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, 'frontend/src');
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`frontend/src not found above ${process.cwd()} — this scan must never pass on an empty read`);
};
const SRC = findSrc();

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });

const LABELS: AuditLabelDictionary = {
  actions: { CREATE: 'Created', UPDATE: 'Updated' },
  fields: { status: 'Status' },
};

const panel = (props: Partial<Parameters<typeof AuditHistoryPanel>[0]>) =>
  render(
    <AuditHistoryPanel
      recordLabel="HC-GRN-2609-067"
      entityName="Goods receipt"
      entries={[]}
      labels={LABELS}
      onClose={() => {}}
      {...props}
    />,
  );

afterEach(cleanup);

describe('a refused history is not an empty history', () => {
  it('says the history could not be loaded, and does NOT say there is none', () => {
    panel({ error: new Error('permission denied for table entity_audit_log') });
    expect(screen.queryByText(/No history yet/i)).toBeNull();
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  });

  it('shows the reason the server gave, so the refusal is diagnosable', () => {
    panel({ error: new Error('permission denied for table entity_audit_log') });
    expect(screen.getByText(/permission denied for table entity_audit_log/i)).toBeTruthy();
  });

  it('an error wins over emptiness even while a retry is in flight', () => {
    panel({ error: new Error('boom'), isLoading: true });
    expect(screen.queryByText(/No history yet/i)).toBeNull();
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  });

  it('a genuinely empty history still says so', () => {
    panel({ entries: [], error: null });
    expect(screen.getByText(/No history yet/i)).toBeTruthy();
  });

  it('entries render whether or not an error prop is passed', () => {
    const entry: AuditLogEntry = {
      id: '1', action: 'CREATE', actor_name_snapshot: 'Wei',
      field_changes: [], created_at: '2026-09-13T00:00:00Z',
      source: null, note: null,
    };
    panel({ entries: [entry] });
    expect(screen.queryByText(/No history yet/i)).toBeNull();
    expect(screen.getByText(/Created/)).toBeTruthy();
  });
});

describe('every binding passes the error through', () => {
  it('no <AuditHistoryPanel ...> is mounted without error=', () => {
    const roots = [resolve(SRC, 'pages'), resolve(SRC, 'mobile'), resolve(SRC, 'components')];
    const files = roots.flatMap((r) => (existsSync(r) ? walk(r) : []));
    const mounts = files.flatMap((path) => {
      const src = readFileSync(path, 'utf8');
      return [...src.matchAll(/<AuditHistoryPanel\b[\s\S]*?\/>/g)]
        .filter((m) => !/\berror=/.test(m[0]))
        .map(() => relative(SRC, path).split(String.fromCharCode(92)).join('/'));
    });
    expect(mounts).toEqual([]);
  });

  it('the scan actually finds the mounts, so an empty result is not a dead matcher', () => {
    const roots = [resolve(SRC, 'pages'), resolve(SRC, 'mobile'), resolve(SRC, 'components')];
    const files = roots.flatMap((r) => (existsSync(r) ? walk(r) : []));
    const total = files.reduce(
      (n, path) => n + [...readFileSync(path, 'utf8').matchAll(/<AuditHistoryPanel\b/g)].length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(3);
  });
});
