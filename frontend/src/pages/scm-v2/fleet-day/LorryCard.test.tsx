import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { LorryCard, StopNo } from './LorryCard';
import { buildLorryRoutes, type DocRowVM, type LorryRunVM } from './vm';
import type { PlanningOrder } from '../../../vendor/scm/lib/delivery-planning-queries';

const order = (over: Partial<PlanningOrder> = {}): PlanningOrder => ({
  row_type: 'so', departure_at: null, job_kind: null, dp_job_type: null, postcode: null, time_range: null,
  delivery_orders: [], ...over,
} as unknown as PlanningOrder);

const doc = (over: Partial<DocRowVM>): DocRowVM => ({
  key: `so:${over.soDocNo ?? 'X'}`,
  order: order(),
  rowType: 'so', jobLabel: null, codeLine: `${over.soDocNo ?? 'HC-SO-1'} · HC-DO-1 · pg01`,
  soDocNo: over.soDocNo ?? 'HC-SO-1', doNumber: 'HC-DO-1', ref: 'pg01',
  customer: 'Ada Wong', phone: '012', address: '12 Jalan Besar', region: 'KL/SEL',
  salespersonId: null, agent: null, branding: null, amountSen: 25000, units: 2,
  slotKind: 'AM', slotLabel: 'AM', stopNo: 1, status: 'scheduled', late: false,
  lateReason: null, hasPod: false, deliveredAt: null, departedAt: null, arrivedAt: null, latestLiveDoId: 'do-1',
  draftDo: false, podPhotoCount: null,
  ...over,
});

const run: LorryRunVM = {
  trip: { id: 't1', trip_no: 'TRIP-1' } as LorryRunVM['trip'],
  lorryId: 'l1', isInternal: true,
  plate: 'VQE9058', tripNo: 'TRIP-1', color: '#2563eb',
  driverName: 'Shamsul', driverIc: '900101-10-1', driverPhone: '019-9',
  driver2Name: null, helpers: ['Ali'], status: 'ON_THE_WAY',
  rollup: { drops: 3, delivered: 1, onTheWay: 0, late: 1, totalSen: 75000, withPod: 1 },
  docs: [
    doc({ soDocNo: 'A', customer: 'First Stop', status: 'overdue', late: true, lateReason: 'Past its 12:00 PM slot', stopNo: 1 }),
    doc({ soDocNo: 'B', customer: 'Second Stop', status: 'done', deliveredAt: '2026-11-01T04:30:00Z', hasPod: true, stopNo: 2 }),
    doc({ soDocNo: 'C', customer: 'Third Stop', status: 'scheduled', stopNo: 3 }),
  ],
};

type Props = ComponentProps<typeof LorryCard>;
const base: Props = {
  run, visibleDocs: run.docs, filtersActive: false, searchActive: false, actionable: true, focused: false,
  selectedKey: null, remarkKeys: new Set(), road: null, legByRef: new Map(), mapNoByRef: new Map(),
  approxRefs: new Set(), unlocatedRefs: new Set(),
  clock: { now: new Date('2026-11-01T06:00:00Z'), day: '2026-11-01', today: '2026-11-01' },
  hideDone: false, onToggleHideDone: () => {},
  onFocus: () => {}, onOpenDoc: () => {}, onCrew: () => {}, onRunSheet: () => {}, onQr: () => {},
};
const renderCard = (over: Partial<Props> = {}) => render(<LorryCard {...base} {...over} />);
const stopOrder = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-stop]')].map((el) => el.dataset.stop);

describe('LorryCard header', () => {
  test('plate + status, driver + phone, helpers, then the progress line', () => {
    renderCard({ road: '86.4 km · 3 h 10 min' });
    expect(screen.getByText('VQE9058')).toBeTruthy();
    expect(screen.getByText('Shamsul')).toBeTruthy();
    expect(screen.getByText('019-9')).toBeTruthy();
    expect(screen.getByText('Helpers: Ali')).toBeTruthy();
    expect(screen.getByText('1/3 done')).toBeTruthy();
    expect(screen.getByText('1 late')).toBeTruthy();
    expect(screen.getByText('86.4 km · 3 h 10 min')).toBeTruthy();
  });
});

describe('stops stay in run order 1..n', () => {
  test('a done stop keeps its place in the run (greyed), it is not moved below the others', () => {
    const { container } = renderCard();
    expect(stopOrder(container)).toEqual(['A', 'B', 'C']);
    const done = container.querySelector<HTMLElement>('[data-stop="B"]')!;
    expect(done.dataset.state).toBe('done');
    expect(done.className).toContain('bg-[#f7f8f5]');
  });

  test('"Hide done" folds the done rows away and keeps the rest in order', () => {
    let toggled = false;
    const { container } = renderCard({ hideDone: true, onToggleHideDone: () => { toggled = true; } });
    expect(stopOrder(container)).toEqual(['A', 'C']);
    fireEvent.click(screen.getByText('Show done (1)'));
    expect(toggled).toBe(true);
  });

  test('the toggle reads "Hide done (N)" while done rows show', () => {
    renderCard();
    expect(screen.getByText('Hide done (1)')).toBeTruthy();
  });

  test('a search still shows done rows even with Hide done on', () => {
    const { container } = renderCard({ hideDone: true, searchActive: true });
    expect(stopOrder(container)).toEqual(['A', 'B', 'C']);
  });
});

describe('exactly one status pill per stop', () => {
  test('Late / Done hh:mm / Not started — and no separate LATE badge', () => {
    const { container } = renderCard();
    const pills = [...container.querySelectorAll('[data-testid="stop-pill"]')].map((el) => el.textContent);
    expect(pills).toEqual(['Late', 'Done 12:30 PM', 'Not started']);
    expect(screen.queryByText('LATE')).toBeNull();
    for (const row of container.querySelectorAll('[data-stop]')) {
      expect(row.querySelectorAll('[data-testid="stop-pill"]')).toHaveLength(1);
    }
  });

  test('an arrived stop reads "Arrived hh:mm"; on the way reads "On the way"', () => {
    const r = { ...run, docs: [
      doc({ soDocNo: 'A', status: 'active', departedAt: '2026-11-01T05:00:00Z', arrivedAt: '2026-11-01T05:41:00Z' }),
      doc({ soDocNo: 'B', status: 'active', departedAt: '2026-11-01T05:50:00Z' }),
    ] };
    const { container } = renderCard({ run: r, visibleDocs: r.docs });
    const pills = [...container.querySelectorAll('[data-testid="stop-pill"]')].map((el) => el.textContent);
    expect(pills).toEqual(['Arrived 1:41 PM', 'On the way']);
    expect(screen.getByText('on site 19 min')).toBeTruthy();
  });

  test('the amount shows only for a delivery', () => {
    const r = { ...run, docs: [
      doc({ soDocNo: 'A', amountSen: 25000 }),
      doc({ soDocNo: 'DP:1', rowType: 'dp', amountSen: 0, order: order({ row_type: 'dp', dp_job_type: 'SETUP' }) }),
    ] };
    renderCard({ run: r, visibleDocs: r.docs });
    expect(screen.getAllByText(/^RM/)).toHaveLength(2);
  });
});

describe('every job type carries its tag', () => {
  test('delivery, service back, setup and transfer tags; a transfer reads From → To', () => {
    const r = { ...run, docs: [
      doc({ soDocNo: 'A' }),
      doc({ soDocNo: 'ASSR/1#delivery', rowType: 'assr', order: order({ row_type: 'assr', job_kind: 'delivery', ref: 'ASSR/1' } as Partial<PlanningOrder>) }),
      doc({ soDocNo: 'PRJ:7#SETUP', rowType: 'project', order: order({ row_type: 'project', dp_job_type: 'SETUP', ref: 'PRJ-7' }) }),
      doc({ soDocNo: 'DP:42', rowType: 'dp', customer: 'Penang Hub', order: order({ row_type: 'dp', dp_job_type: 'TRANSFER', dp_no: 'DP-42', dp_from_name: 'KL Warehouse' }) }),
      doc({ soDocNo: 'D', draftDo: true }),
    ] };
    renderCard({ run: r, visibleDocs: r.docs });
    expect(screen.getAllByText('DELIVERY')).toHaveLength(2);
    expect(screen.getByText('SERVICE BACK')).toBeTruthy();
    expect(screen.getByText('SETUP')).toBeTruthy();
    expect(screen.getByText('TRANSFER')).toBeTruthy();
    expect(screen.getByText('KL Warehouse → Penang Hub')).toBeTruthy();
    expect(screen.getByText('DRAFT DO')).toBeTruthy();
  });
});

describe('the number circle', () => {
  test('carries the run number from the map and its look follows the stop', () => {
    const { container } = renderCard({ mapNoByRef: new Map([['A', 4], ['B', 5], ['C', 6]]), approxRefs: new Set(['C']) });
    const circles = [...container.querySelectorAll<HTMLElement>('[data-look]')];
    expect(circles.map((c) => c.textContent)).toEqual(['4', '5', '6']);
    expect(circles.map((c) => c.dataset.look)).toEqual(['open-red', 'solid-green', 'dashed-grey']);
    expect(screen.getByText('approx. location')).toBeTruthy();
  });

  test('a done stop is filled green, a stop not started is a blue outline', () => {
    const { container } = render(<><StopNo no={1} look="solid-green" /><StopNo no={2} look="open-blue" /></>);
    const [done, open] = [...container.querySelectorAll<HTMLElement>('[data-look]')];
    expect(done!.style.backgroundColor).toBe('rgb(21, 128, 61)');
    expect(open!.style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(open!.style.color).toBe('rgb(37, 99, 235)');
  });

  test('every job type is numbered by its place in the run, matching the map', () => {
    const jobRun: LorryRunVM = {
      ...run,
      docs: [
        doc({ soDocNo: 'HC-SO-010458', stopNo: 1 }),
        doc({ key: 'assr', soDocNo: 'ASSR/2610-054#delivery', rowType: 'assr', stopNo: null, order: order({ row_type: 'assr', job_kind: 'delivery' }) }),
        doc({ key: 'prj', soDocNo: 'PRJ:7#SETUP', rowType: 'project', stopNo: null, order: order({ row_type: 'project', dp_job_type: 'SETUP' }) }),
      ],
    };
    const { noByRef } = buildLorryRoutes([jobRun], new Map(), new Set(), new Map(), null, () => null, (k) => k);
    const { container } = renderCard({ run: jobRun, visibleDocs: jobRun.docs, mapNoByRef: noByRef });
    expect([...container.querySelectorAll('[data-look]')].map((el) => el.textContent)).toEqual(['1', '2', '3']);
  });
});

describe('the meta line', () => {
  test('shows the Google leg and, for a late stop today, when its slot ended (red)', () => {
    const r = { ...run, docs: [doc({ soDocNo: 'A', status: 'overdue', late: true, slotLabel: '10:30AM to 12:30PM', order: order({ time_range: '10:30AM to 12:30PM' }) })] };
    renderCard({ run: r, visibleDocs: r.docs, legByRef: new Map([['A', '12.0 km · 18 min']]) });
    expect(screen.getByText('Google 12.0 km · 18 min')).toBeTruthy();
    expect(screen.getByText('Slot ended 12:30 PM').className).toContain('text-err');
    expect(screen.getByText('10:30–12:30')).toBeTruthy();
  });

  test('a finished job shows its time on site and POD photo count', () => {
    const r = { ...run, docs: [doc({ soDocNo: 'DP:1', rowType: 'dp', status: 'done', podPhotoCount: 3, arrivedAt: '2026-11-01T02:30:00Z', deliveredAt: '2026-11-01T03:10:00Z', order: order({ row_type: 'dp', dp_job_type: 'SETUP' }) })] };
    renderCard({ run: r, visibleDocs: r.docs });
    expect(screen.getByText('on site 40 min')).toBeTruthy();
    expect(screen.getByText('3 POD photos')).toBeTruthy();
  });
});
