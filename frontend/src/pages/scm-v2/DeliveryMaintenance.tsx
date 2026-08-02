// ----------------------------------------------------------------------------
// Delivery Maintenance — the reference data behind Transportation, as ONE module
// instead of six nav destinations.
//
// Owner, 2026-08-01: "Regions、Residentials 和 Fleet 其实是一个整体 — 这三个一个"
// and "Rate Card 与 3PL Company 的联动：这两个一个". So the six surfaces are THREE
// parts, not six sections: the two groupings the owner named are each one part,
// and Delivery Zones stands alone.
//
// EVERY LEVEL FOLDS, because length is the problem being solved. Owner: "可以
// 折叠、可以开关、可以点一下就打开? 要不然页面拉得太长了". A grouped part holds
// up to three FULL screens, so if only the part folded, opening it would produce
// exactly the scroll-tower this page exists to replace. The part folds, and each
// screen inside it folds.
//
// Matches Sales Order Maintenance, verified live 2026-08-01: collapsible
// sections with chevrons, plus a jump row of section names above them. The one
// difference is the default — SO Maintenance opens its three because that is how
// that page always behaved; here nothing is open on a cold visit, because six
// config surfaces expanded at once is the thing being fixed.
//
// EACH SURFACE IS THE EXISTING PAGE, EMBEDDED. Every one renders the same
// component its standalone route renders, passing `embedded` so the page drops
// its own PageHeader and nothing else changes. There is deliberately no second
// copy: the old routes still work (deep links, anything bookmarked), and a fix
// lands in both places at once. Duplicating them is how the two would drift.
//
// Route /scm/delivery-maintenance, nav "Maintenance" under Transportation — now
// the ONLY Transportation reference-data entry in the sidebar (Sidebar.tsx).
// Which parts are open lives in ?open= (see CollapsibleSection).
// ----------------------------------------------------------------------------

import { useCallback, type ReactElement } from 'react';
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

/** One surface inside a part. `path` keeps its standalone route reachable. */
type Surface = { key: string; title: string; hint: string; path: string; render: () => ReactElement };
type Part = { key: string; title: string; hint: string; surfaces: Surface[] };

/** Anchor id for a surface, so a part can link to one of its own blocks. */
const anchorOf = (key: string) => `dm-${key}`;

export const DeliveryMaintenance = () => {
  const { isOpen, toggle, setAll, ensureOpen } = useOpenSections([]);

  /* Open a key that may be closed, THEN scroll to it. Scrolling first lands on
     a collapsed header and reads as a link that did nothing. */
  const reveal = useCallback((key: string, anchor: string) => {
    ensureOpen(key);
    requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [ensureOpen]);

  /* What the Rate Cards "New 3PL company" control does. The two screens are one
     part precisely so this never leaves the page: it opens the 3PL block that is
     already a few hundred pixels up. */
  const jumpTo3PL = useCallback(() => {
    ensureOpen('carriers');
    ensureOpen('threepl');
    requestAnimationFrame(() => {
      document.getElementById(anchorOf('threepl'))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [ensureOpen]);

  const PARTS: Part[] = [
    {
      key: 'coverage-fleet',
      title: 'Regions, Residence Rules & Fleet',
      hint: 'Who covers which postcodes, how each building type is handled, and the crew and lorries that go.',
      surfaces: [
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
      ],
    },
    {
      key: 'zones',
      title: 'Delivery Zones',
      hint: 'Postcode zones the packer groups a day around.',
      surfaces: [
        {
          key: 'delivery-zones', title: 'Delivery Zones', path: '/scm/delivery-zones',
          hint: '', render: () => <DeliveryZones embedded />,
        },
      ],
    },
    {
      key: 'carriers',
      title: '3PL Companies & Rate Cards',
      hint: 'Register a carrier, then price it. A rate card is priced per company, so the two belong together.',
      surfaces: [
        {
          key: 'threepl', title: '3PL Companies', path: '/scm/threepl-companies',
          hint: 'Outsourced carriers, their particulars and their fleet.',
          render: () => <ThreePLCompanies embedded />,
        },
        {
          key: 'rate-cards', title: 'Rate Cards', path: '/scm/delivery-rate-cards',
          hint: 'What each carrier charges, and the reconciliation against it.',
          /* onCreateCompany is why these two are one part: the rate card's
             carrier list IS the 3PL master, so "there is no carrier to price"
             is answered in place instead of by sending the user to another
             screen and back. */
          render: () => <DeliveryRateCards embedded onCreateCompany={jumpTo3PL} />,
        },
      ],
    },
  ];

  /* Parts and the screens inside them share ONE ?open= set — a surface key is
     as linkable as a part key, so ?open=carriers,threepl is "the Carriers part,
     3PL block showing". */
  const ALL_KEYS = PARTS.flatMap((p) => [p.key, ...p.surfaces.map((s) => s.key)]);
  const openCount = PARTS.filter((p) => isOpen(p.key)).length;
  const allOpen = openCount === PARTS.length;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Reference data"
        title="Delivery Maintenance"
        description="Everything Transportation reads but nobody edits daily — coverage and fleet, delivery zones, and the carriers with their rate cards. Open a part to edit it; every screen here is the same one as its own page."
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
          part before scrolling, so it works from a fully collapsed page. */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface p-1.5">
        {PARTS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => reveal(p.key, p.key)}
            className={`rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
              isOpen(p.key)
                ? 'bg-primary-soft text-primary'
                : 'text-ink-secondary hover:bg-primary-soft hover:text-primary'
            }`}
          >
            {p.title}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2 pr-1">
          <span className="text-[11.5px] text-ink-muted">
            {openCount === 0 ? 'All parts closed' : `${openCount} of ${PARTS.length} open`}
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
        {PARTS.map((part) => (
          <CollapsibleSection
            key={part.key}
            id={part.key}
            title={part.title}
            hint={part.hint}
            open={isOpen(part.key)}
            onToggle={() => toggle(part.key)}
            count={
              part.surfaces.length > 1
                ? <span>{part.surfaces.length} screens</span>
                : <Link
                    to={part.surfaces[0]!.path}
                    className="text-[11px] uppercase tracking-wider text-ink-muted underline-offset-2 hover:text-primary hover:underline"
                  >
                    Open on its own
                  </Link>
            }
          >
            {/* A single-surface part IS the surface — a second chevron wrapping
                one thing is a fold that folds nothing. */}
            {part.surfaces.length === 1
              ? part.surfaces[0]!.render()
              : (
                <div className="space-y-2.5">
                  {part.surfaces.map((s) => (
                    <CollapsibleSection
                      key={s.key}
                      id={anchorOf(s.key)}
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
              )}
          </CollapsibleSection>
        ))}
      </div>
    </div>
  );
};


export default DeliveryMaintenance;
