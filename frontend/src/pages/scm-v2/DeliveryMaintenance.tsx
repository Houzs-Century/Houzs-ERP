// ----------------------------------------------------------------------------
// Coverage & Fleet — regions, residence rules and the fleet registry, as ONE
// page instead of three nav destinations.
//
// Owner, 2026-08-01: "Regions、Residentials 和 Fleet 其实是一个整体 — 这三个一个".
// Those three, and ONLY those three. Delivery Zones and Carriers & Rates are
// their own sidebar rows pointing at their own original pages: 2026-08-02, on
// seeing all three parts stacked behind one nav row — "我要原本的UI" and
// "delivery zones和carriers 根本都不需要dropdown啊 就那么少的info". A part that
// holds one screen is a fold that folds nothing, and wrapping the original page
// in it only hides the page.
//
// The sections fold because THIS page holds three full screens — the shape the
// owner pointed at (screenshot, 2026-08-02) and the one Sales Order Maintenance
// uses: chevron sections plus a jump row. Regions opens on arrival so the page
// shows its content, not a table of contents.
//
// EACH SECTION IS THE EXISTING PAGE, EMBEDDED. Every one renders the same
// component its standalone route renders, passing `embedded` so the page drops
// its own PageHeader and nothing else changes. There is deliberately no second
// copy: the old routes still work (deep links, anything bookmarked), and a fix
// lands in both places at once. Duplicating them is how the two would drift.
//
// Route /scm/delivery-maintenance, nav "Maintenance > Coverage & Fleet" under
// Transportation (Sidebar.tsx). Which sections are open lives in ?open=.
// ----------------------------------------------------------------------------

import { type ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/Layout';
import { cn } from '../../lib/utils';
import { DeliveryPlanningRegions } from './DeliveryPlanningRegions';
import { DeliveryResidenceRules } from './DeliveryResidenceRules';
import { DriversSection, HelpersSection, LorriesSection } from './Fleet';
import { LorryLiveMap } from './LorryLiveMap';
import { SavedLocations } from './SavedLocations';

type Tab = { key: string; title: string; path: string; render: () => ReactElement };

/* Owner 2026-11-07 (the Coverage & Fleet design): one tab per screen instead of stacked
   folds, Lorries first. The tab lives in ?tab= so a link opens the same screen. */
const TABS: Tab[] = [
  { key: 'lorries', title: 'Lorries', path: '/scm/fleet', render: () => <LorriesSection /> },
  { key: 'drivers', title: 'Drivers', path: '/scm/fleet', render: () => <DriversSection /> },
  { key: 'helpers', title: 'Helpers', path: '/scm/fleet', render: () => <HelpersSection /> },
  /* Owner 2026-11-08: the Lorry Live Map left the sidebar for a tab here and in Fleet Health. */
  { key: 'live-map', title: 'Live map', path: '/scm/lorry-live-map', render: () => <LorryLiveMap embedded /> },
  { key: 'residence-rules', title: 'Residence rules', path: '/scm/delivery-residence-rules', render: () => <DeliveryResidenceRules embedded /> },
  { key: 'regions', title: 'Regions', path: '/scm/delivery-planning-regions', render: () => <DeliveryPlanningRegions embedded /> },
  { key: 'saved-locations', title: 'Places', path: '/scm/saved-locations', render: () => <SavedLocations embedded /> },
];
/* Old ?open= links (the folds) land on the tab they named. */
const LEGACY: Partial<Record<string, string>> = { fleet: 'lorries', regions: 'regions', 'residence-rules': 'residence-rules', 'saved-locations': 'saved-locations' };

/** The tab a link asks for: ?tab=, else the fold an old ?open= named, else Lorries. */
export const tabKeyOf = (tab: string | null, open: string | null): string => tab ?? LEGACY[open?.split(',')[0] ?? ''] ?? 'lorries';

export const DeliveryMaintenance = () => {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === tabKeyOf(params.get('tab'), params.get('open'))) ?? TABS[0]!;
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Reference data"
        title="Coverage & Fleet"
        description="Lorries, crews, where each lorry is now, building rules, regions and places."
      />
      <div role="tablist" aria-label="Coverage and fleet" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={t.key === tab.key}
            onClick={() => setParams((p) => { p.set('tab', t.key); p.delete('open'); return p; }, { replace: true })}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-[13px] font-semibold',
              t.key === tab.key ? 'border-primary text-primary' : 'border-transparent text-ink-muted hover:text-ink')}>
            {t.title}
          </button>
        ))}
      </div>
      <div role="tabpanel">{tab.render()}</div>
    </div>
  );
};

export default DeliveryMaintenance;
