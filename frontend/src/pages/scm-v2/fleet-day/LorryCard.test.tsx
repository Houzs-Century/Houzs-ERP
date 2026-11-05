/* Render smoke test for the lorry card — the office board's centrepiece. It is
   pure presentational (props in, no network/context), so a jsdom render verifies
   it mounts and shows the plate, crew, progress, an undelivered row with its LATE
   pill and the delivered fold without crashing. */
import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LorryCard } from './LorryCard';
import type { DocRowVM, LorryRunVM } from './vm';
import type { PlanningOrder } from '../../../vendor/scm/lib/delivery-planning-queries';

const doc = (over: Partial<DocRowVM>): DocRowVM => ({
  key: `so:${over.soDocNo ?? 'X'}`,
  order: { departure_at: null } as unknown as PlanningOrder,
  rowType: 'so', jobLabel: null, codeLine: `${over.soDocNo ?? 'HC-SO-1'} · HC-DO-1 · pg01`,
  soDocNo: over.soDocNo ?? 'HC-SO-1', doNumber: 'HC-DO-1', ref: 'pg01',
  customer: 'Ada Wong', phone: '012', address: '12 Jalan Besar', region: 'KL/SEL',
  salespersonId: null, agent: null, branding: null, amountSen: 25000, units: 2,
  slotKind: 'AM', slotLabel: 'AM', stopNo: 1, status: 'scheduled', late: false,
  lateReason: null, hasPod: false, deliveredAt: null, latestLiveDoId: 'do-1',
  ...over,
});

const run: LorryRunVM = {
  trip: { id: 't1', trip_no: 'TRIP-1' } as LorryRunVM['trip'],
  lorryId: 'l1', isInternal: true,
  plate: 'VQE9058', tripNo: 'TRIP-1', color: '#2563eb',
  driverName: 'Shamsul', driverIc: '900101-10-1', driverPhone: '019-9',
  driver2Name: null, helpers: ['Ali'], status: 'ON_THE_WAY',
  rollup: { drops: 2, delivered: 1, onTheWay: 0, late: 1, totalSen: 50000, withPod: 1 },
  docs: [
    doc({ soDocNo: 'A', status: 'overdue', late: true, lateReason: 'Past its 12:00 PM slot', stopNo: 1 }),
    doc({ soDocNo: 'B', status: 'done', deliveredAt: '2026-11-01T03:00:00Z', hasPod: true, stopNo: 2 }),
  ],
};

describe('LorryCard', () => {
  test('renders plate, crew, progress, an undelivered LATE row and the delivered fold', () => {
    render(
      <LorryCard
        run={run}
        visibleDocs={run.docs}
        filtersActive={false}
        searchActive={false}
        actionable
        focused={false}
        selectedKey={null}
        remarkKeys={new Set()}
        onFocus={() => {}}
        onOpenDoc={() => {}}
        onCrew={() => {}}
        onRunSheet={() => {}}
        onQr={() => {}}
      />,
    );
    expect(screen.getByText('VQE9058')).toBeTruthy();
    expect(screen.getByText('Shamsul')).toBeTruthy();
    expect(screen.getByText('1/2 delivered')).toBeTruthy();
    expect(screen.getByText('LATE')).toBeTruthy();
    // The delivered drop is folded away by default, shown as the count toggle.
    expect(screen.getByText('1 delivered')).toBeTruthy();
    // The undelivered (late) drop's customer is visible.
    expect(screen.getAllByText('Ada Wong').length).toBeGreaterThan(0);
  });

  test('a non-SO job on the run shows its job tag + document and no order amount', () => {
    const jobRun: LorryRunVM = {
      ...run,
      rollup: { drops: 1, delivered: 0, onTheWay: 0, late: 0, totalSen: 0, withPod: 0 },
      docs: [doc({
        soDocNo: 'DP:42', rowType: 'dp', jobLabel: 'Transfer item', codeLine: 'DP-261102-VRH02',
        customer: 'KL → Penang', amountSen: 0, units: 0, status: 'scheduled',
      })],
    };
    render(
      <LorryCard
        run={jobRun} visibleDocs={jobRun.docs} filtersActive={false} searchActive={false}
        actionable focused={false} selectedKey={null} remarkKeys={new Set()}
        onFocus={() => {}} onOpenDoc={() => {}} onCrew={() => {}} onRunSheet={() => {}} onQr={() => {}}
      />,
    );
    expect(screen.getByText('Transfer item')).toBeTruthy();
    expect(screen.getByText('DP-261102-VRH02')).toBeTruthy();
    expect(screen.getByText('KL → Penang')).toBeTruthy();
  });
});
