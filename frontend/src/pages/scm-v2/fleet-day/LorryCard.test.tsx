/* Render smoke test for the lorry card — the office board's centrepiece. It is
   pure presentational (props in, no network/context), so a jsdom render verifies
   it mounts and shows the plate, crew, progress, an undelivered row with its LATE
   pill and the delivered fold without crashing. */
import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LorryCard, StopNo } from './LorryCard';
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
  lateReason: null, hasPod: false, deliveredAt: null, departedAt: null, arrivedAt: null, latestLiveDoId: 'do-1',
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
        routeColor="#2563eb"
        run={run}
        visibleDocs={run.docs}
        filtersActive={false}
        searchActive={false}
        actionable
        focused={false}
        selectedKey={null}
        remarkKeys={new Set()}
        road={null}
        legByRef={new Map()}
        mapNoByRef={new Map()}
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
        routeColor="#2563eb"
        run={jobRun} visibleDocs={jobRun.docs} filtersActive={false} searchActive={false}
        actionable focused={false} selectedKey={null} remarkKeys={new Set()} road={null} legByRef={new Map()} mapNoByRef={new Map()}
        onFocus={() => {}} onOpenDoc={() => {}} onCrew={() => {}} onRunSheet={() => {}} onQr={() => {}}
      />,
    );
    expect(screen.getByText('Transfer item')).toBeTruthy();
    expect(screen.getByText('DP-261102-VRH02')).toBeTruthy();
    expect(screen.getByText('KL → Penang')).toBeTruthy();
  });
});

describe('a finished stop shows its road and site time', () => {
  test('on the road from setting off to arrived, on site from arrived to completed', () => {
    const timed = { ...run, docs: [doc({ soDocNo: 'B', status: 'done', departedAt: '2026-11-01T02:00:00Z', arrivedAt: '2026-11-01T02:30:00Z', deliveredAt: '2026-11-01T03:10:00Z' })] };
    render(
      <LorryCard routeColor="#2563eb" run={timed} visibleDocs={timed.docs} filtersActive={false} searchActive actionable focused={false} selectedKey={null}
        remarkKeys={new Set()} road={null} legByRef={new Map()} mapNoByRef={new Map()} onFocus={() => {}} onOpenDoc={() => {}} onCrew={() => {}} onRunSheet={() => {}} onQr={() => {}} />,
    );
    expect(screen.getByText(/^Drive time 30 min · Arrived .+ · On-site time 40 min$/)).toBeTruthy();
  });
});

describe('the run by road', () => {
  test('shows the road distance and driving time on the card', () => {
    render(
      <LorryCard routeColor="#2563eb" run={run} visibleDocs={run.docs} filtersActive={false} searchActive={false} actionable focused={false} selectedKey={null}
        remarkKeys={new Set()} road="86.4 km · 3 h 10 min" legByRef={new Map()} mapNoByRef={new Map()} onFocus={() => {}} onOpenDoc={() => {}} onCrew={() => {}} onRunSheet={() => {}} onQr={() => {}} />,
    );
    expect(screen.getByText('86.4 km · 3 h 10 min')).toBeTruthy();
  });
});

describe('each order by road from the stop before', () => {
  test('an order on the run shows how far the lorry drives to reach it', () => {
    render(
      <LorryCard routeColor="#2563eb" run={run} visibleDocs={run.docs} filtersActive={false} searchActive={false} actionable focused={false} selectedKey={null}
        remarkKeys={new Set()} road={null} legByRef={new Map([['A', '12.0 km · 18 min']])} mapNoByRef={new Map()}
        onFocus={() => {}} onOpenDoc={() => {}} onCrew={() => {}} onRunSheet={() => {}} onQr={() => {}} />,
    );
    expect(screen.getByText('12.0 km · 18 min')).toBeTruthy();
  });
});

describe('each row carries its map pin number', () => {
  test('a delivered stop shows the number its pin has on the map', () => {
    render(
      <LorryCard routeColor="#2563eb" run={run} visibleDocs={run.docs} filtersActive={false} searchActive actionable focused={false} selectedKey={null}
        remarkKeys={new Set()} road={null} legByRef={new Map()} mapNoByRef={new Map([['A', 4], ['B', 7]])}
        onFocus={() => {}} onOpenDoc={() => {}} onCrew={() => {}} onRunSheet={() => {}} onQr={() => {}} />,
    );
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  test('a done stop number is solid in the lorry colour, a stop still to deliver is a light tint of it', () => {
    const { container } = render(<><StopNo no={1} color="#2563eb" done /><StopNo no={2} color="#2563eb" done={false} /></>);
    const [done, open] = Array.from(container.querySelectorAll<HTMLElement>('[data-done]'));
    expect(done!.dataset.done).toBe('true');
    expect(done!.style.backgroundColor).toBe('rgb(37, 99, 235)');
    expect(done!.style.color).toBe('rgb(255, 255, 255)');
    expect(open!.dataset.done).toBe('false');
    expect(open!.style.color).toBe('rgb(37, 99, 235)');
    expect(open!.style.backgroundColor).not.toBe('rgb(37, 99, 235)');
  });
});
