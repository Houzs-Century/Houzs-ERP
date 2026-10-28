import { Breadcrumbs, MemoryRouter } from "autocount-sync-frontend";

// Breadcrumb trail above the PageHeader on detail pages. Ancestor items link
// (react-router <Link>), the trailing item renders as plain bold text — so
// every story wraps in MemoryRouter. BreadcrumbsProvider is not needed: this
// component takes `items` directly.

export const SalesOrderTrail = () => (
  <MemoryRouter>
    <Breadcrumbs
      items={[
        { label: "Supply Chain", to: "/scm" },
        { label: "Sales Orders", to: "/scm/sales-orders" },
        { label: "SO-2990-0417" },
      ]}
    />
  </MemoryRouter>
);

export const DeepProcurementTrail = () => (
  <MemoryRouter>
    <Breadcrumbs
      items={[
        { label: "Supply Chain", to: "/scm" },
        { label: "Procurement", to: "/scm/procurement" },
        { label: "Purchase Orders", to: "/scm/purchase-orders" },
        { label: "Best Aircond Supplies Sdn Bhd", to: "/scm/suppliers/sup-018" },
        { label: "PO-2990-00847" },
      ]}
    />
  </MemoryRouter>
);

export const InContext = () => (
  <MemoryRouter>
    <div className="w-[30rem] rounded-lg border border-border bg-surface p-4 shadow-stone">
      <Breadcrumbs
        items={[
          { label: "Warehouse", to: "/scm/warehouse" },
          { label: "Stock Levels", to: "/scm/warehouse/stock" },
          { label: "PAN-CSPU24XKH" },
        ]}
      />
      <div className="font-display text-[16px] font-extrabold text-ink">
        Panasonic 2.5HP X-Premium Inverter
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink-muted">
        On hand 34 · Reserved 12 · Shah Alam DC
      </div>
    </div>
  </MemoryRouter>
);
