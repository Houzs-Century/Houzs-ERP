// ----------------------------------------------------------------------------
// Delivery Maintenance — the reference data behind Transportation, as ONE page
// of open/closable sub-modules instead of six separate nav destinations.
//
// Owner, 2026-08-01: "我的 regions、我的 resident rules，还有我的 fleets，我都要把它
// 变成一个模块，就好像我的 sales order 的 maintenance 那样子。然后你确保每一块
// sub-module 它都是可以 drop 到可以关、可以开的" — the Sales Order Maintenance
// shape, but collapsible.
//
// EACH SECTION IS THE EXISTING PAGE, EMBEDDED. Every sub-module here renders the
// same component its standalone route renders, passing `embedded` so the page
// drops its own PageHeader and nothing else changes. There is deliberately no
// second copy of Regions or Fleet: the old routes still work (deep links, the
// nav, anything bookmarked), and a fix to a sub-module lands in both places at
// once. Duplicating them is how the two surfaces would drift.
//
// Route /scm/delivery-maintenance, nav "Maintenance" under Transportation.
// Which sections are open lives in ?open= (see CollapsibleSection).
// ----------------------------------------------------------------------------

import { type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { CollapsibleSection, useOpenSections } from '../../components/CollapsibleSection';
import { DeliveryPlanningRegions } from './DeliveryPlanningRegions';
import { DeliveryResidenceRules } from './DeliveryResidenceRules';
import { Fleet } from './Fleet';
import { DeliveryZones } from './DeliveryZones';
import { ThreePLCompanies } from './ThreePLCompanies';
import { DeliveryRateCards } from './DeliveryRateCards';

type SubModule = {
  key: string;
  title: string;
  hint: string;
  /** The standalone route, so a section can still be opened on its own. */
  path: string;
  render: () => ReactElement;
};

const SUB_MODULES: SubModule[] = [
  {
    key: 'regions', title: 'Regions', path: '/scm/delivery-planning-regions',
    hint: 'Warehouse = region. Which depot serves which postcodes.',
    render: () => <DeliveryPlanningRegions embedded />,
  },
  {
    key: 'residence-rules', title: 'Residence Rules', path: '/scm/delivery-residence-rules',
    hint: 'Building type -> handling time and access constraints.',
    render: () => <DeliveryResidenceRules embedded />,
  },
  {
    key: 'fleet', title: 'Fleet', path: '/scm/fleet',
    hint: 'Drivers, helpers and lorries — in-house and outsourced.',
    render: () => <Fleet embedded />,
  },
  {
    key: 'zones', title: 'Delivery Zones', path: '/scm/delivery-zones',
    hint: 'Postcode zones the packer groups a day around.',
    render: () => <DeliveryZones embedded />,
  },
  {
    key: 'threepl', title: '3PL Companies', path: '/scm/threepl-companies',
    hint: 'Outsourced carriers, their particulars and their fleet.',
    render: () => <ThreePLCompanies embedded />,
  },
  {
    key: 'rate-cards', title: 'Rate Cards', path: '/scm/delivery-rate-cards',
    hint: 'What each carrier charges, and the reconciliation against it.',
    render: () => <DeliveryRateCards embedded />,
  },
];

const ALL_KEYS = SUB_MODULES.map((m) => m.key);

export const DeliveryMaintenance = () => {
  /* Nothing is open on a cold visit: six config surfaces expanded at once is the
     scroll-tower this page exists to replace. */
  const { isOpen, toggle, setAll } = useOpenSections([]);
  const openCount = SUB_MODULES.filter((m) => isOpen(m.key)).length;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Reference data"
        title="Delivery Maintenance"
        description="The reference data behind Transportation — regions, residence rules, the fleet, delivery zones, 3PL carriers and their rate cards. Open a section to edit it; each one is the same screen as its own page."
        actions={
          <Link
            to="/scm/delivery-planning"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary"
          >
            <ArrowLeft size={14} /> Delivery Planning
          </Link>
        }
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setAll(openCount === SUB_MODULES.length ? [] : ALL_KEYS)}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary"
        >
          {openCount === SUB_MODULES.length ? 'Collapse all' : 'Expand all'}
        </button>
        <span className="text-[11.5px] text-ink-muted">
          {openCount === 0 ? 'All sections closed' : `${openCount} of ${SUB_MODULES.length} open`}
        </span>
      </div>

      <div className="space-y-2.5">
        {SUB_MODULES.map((m) => (
          <CollapsibleSection
            key={m.key}
            id={m.key}
            title={m.title}
            hint={m.hint}
            open={isOpen(m.key)}
            onToggle={() => toggle(m.key)}
            count={
              <Link
                to={m.path}
                className="text-[11px] uppercase tracking-wider text-ink-muted underline-offset-2 hover:text-primary hover:underline"
              >
                Open on its own
              </Link>
            }
          >
            {m.render()}
          </CollapsibleSection>
        ))}
      </div>
    </div>
  );
};

export default DeliveryMaintenance;
