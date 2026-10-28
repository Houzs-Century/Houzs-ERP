import type { ReactNode } from "react";
import { MemoryRouter, PageHeader, Button, Badge } from "autocount-sync-frontend";
import { Download, Printer } from "lucide-react";

// Sticky page title strip — title + optional eyebrow/description, an
// always-visible primary CTA and collapsible secondary actions.
//
// PageHeader now calls useNavigate() for its opt-in `back` affordance
// (top-chrome 2b, #1128) — every story mounts inside the bundle's
// MemoryRouter, same single-instance rule as the other context helpers.

const Frame = ({ children }: { children?: ReactNode }) => (
  <MemoryRouter initialEntries={["/scm/sales-orders"]}>{children}</MemoryRouter>
);

export const TitleOnly = () => (
  <Frame>
    <PageHeader title="Sales Orders" />
  </Frame>
);

export const WithDescriptionAndCta = () => (
  <Frame>
    <PageHeader
      eyebrow="Supply Chain"
      eyebrowMeta="128 orders"
      title="Delivery Orders"
      description="Outbound deliveries synced from AutoCount, newest first."
      primaryAction={<Button variant="primary">New DO</Button>}
    />
  </Frame>
);

export const WithSecondaryActions = () => (
  <Frame>
    <PageHeader
      title="Service Cases"
      description="After-sales service requests across all outlets."
      actions={<Badge tone="warning">Sync paused</Badge>}
      primaryAction={<Button variant="primary">New Case</Button>}
      secondaryActions={[
        { icon: Download, label: "Export CSV", onClick: () => {} },
        { icon: Printer, label: "Print list", onClick: () => {} },
      ]}
    />
  </Frame>
);

export const DetailWithBack = () => (
  <Frame>
    <PageHeader
      back
      titleSize="sm"
      eyebrow="Sales Order"
      eyebrowMeta="Confirmed · 12 lines"
      title="SO-2990-0417 — Aurora Marble Dining Set"
      primaryAction={<Button variant="primary">Convert to DO</Button>}
    />
  </Frame>
);

export const Dense = () => (
  <Frame>
    <PageHeader dense title="P&L Calendar" description="Daily gross margin at a glance." />
  </Frame>
);
