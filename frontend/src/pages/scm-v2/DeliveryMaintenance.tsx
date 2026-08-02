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
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { CollapsibleSection, useOpenSections } from '../../components/CollapsibleSection';
import { DeliveryPlanningRegions } from './DeliveryPlanningRegions';
import { DeliveryResidenceRules } from './DeliveryResidenceRules';
import { Fleet } from './Fleet';

type Section = { key: string; title: string; hint: string; path: string; render: () => ReactElement };

const SECTIONS: Section[] = [
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
];

const ALL_KEYS = SECTIONS.map((s) => s.key);

export const DeliveryMaintenance = () => {
  /* Regions open by default: landing on three closed chevrons is the "table of
     contents instead of the page" the owner rejected. */
  const { isOpen, toggle, setAll, ensureOpen } = useOpenSections(['regions']);

  /* Open a key that may be closed, THEN scroll to it. Scrolling first lands on
     a collapsed header and reads as a link that did nothing. */
  const reveal = (key: string) => {
    ensureOpen(key);
    requestAnimationFrame(() => {
      document.getElementById(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const openCount = SECTIONS.filter((s) => isOpen(s.key)).length;
  const allOpen = openCount === SECTIONS.length;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Reference data"
        title="Coverage & Fleet"
        description="Who covers which postcodes, how each building type is handled, and the crew and lorries that go. Every screen here is the same one as its own page."
        actions={
          <Link
            to="/scm/delivery-planning"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary"
          >
            <ArrowLeft size={14} /> Delivery Planning
          </Link>
        }
      />

      {/* Jump row, the shape Sales Order Maintenance uses. Each entry OPENS its
          section before scrolling, so it works from a fully collapsed page. */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface p-1.5">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => reveal(s.key)}
            className={`rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
              isOpen(s.key)
                ? 'bg-primary-soft text-primary'
                : 'text-ink-secondary hover:bg-primary-soft hover:text-primary'
            }`}
          >
            {s.title}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2 pr-1">
          <span className="text-[11.5px] text-ink-muted">
            {openCount === 0 ? 'All closed' : `${openCount} of ${SECTIONS.length} open`}
          </span>
          <button
            type="button"
            onClick={() => setAll(allOpen ? [] : ALL_KEYS)}
            className="rounded-md border border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary"
          >
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        </span>
      </div>

      <div className="space-y-2.5">
        {SECTIONS.map((s) => (
          <CollapsibleSection
            key={s.key}
            id={s.key}
            title={s.title}
            hint={s.hint}
            open={isOpen(s.key)}
            onToggle={() => toggle(s.key)}
            count={
              <Link
                to={s.path}
                className="text-[11px] uppercase tracking-wider text-ink-muted underline-offset-2 hover:text-primary hover:underline"
              >
                Open on its own
              </Link>
            }
          >
            {s.render()}
          </CollapsibleSection>
        ))}
      </div>
    </div>
  );
};


export default DeliveryMaintenance;
