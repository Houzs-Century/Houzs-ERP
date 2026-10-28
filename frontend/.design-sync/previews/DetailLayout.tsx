import type { ReactNode } from "react";
import {
  DetailLayout,
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
  StatStrip,
  DefinitionList,
  HeaderButton,
  Badge,
  MemoryRouter,
} from "autocount-sync-frontend";

// Shared chrome for every detail page — sticky back/actions bar, brass
// eyebrow + serif title, then the body (usually a DetailGrid split).
// Needs a Router for the back button; the sticky bar bleeds to the canvas
// edges with negative margins, so the frame below re-pads like Layout.tsx.

const Frame = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <div className="min-h-[320px] bg-bg px-4 pt-6 pb-6 sm:px-6 sm:pt-8 lg:px-10 lg:pt-10 xl:px-12 2xl:px-16">
      {children}
    </div>
  </MemoryRouter>
);

export const SalesOrderDetail = () => (
  <Frame>
    <DetailLayout
      breadcrumbs={[{ label: "Sales Orders", to: "/orders" }, { label: "SO-2990-0417" }]}
      eyebrow="Sales Order · SO-2990-0417"
      title="Akemi Furniture Sdn Bhd"
      description="Confirmed 12 Jun 2026 · Setia Alam Showroom · Farra Aziz"
      actions={
        <>
          <HeaderButton onClick={() => {}}>Print</HeaderButton>
          <HeaderButton variant="primary" onClick={() => {}}>Create DO</HeaderButton>
        </>
      }
    >
      <div className="space-y-3">
        <StatStrip
          items={[
            { label: "Total", value: "RM 18,540.00" },
            { label: "Paid", value: "RM 9,270.00", hint: "50% deposit", tone: "ok" },
            { label: "Balance", value: "RM 9,270.00", tone: "warn" },
            { label: "Sync", value: "Synced", hint: "13 Jun 09:41", tone: "ok" },
          ]}
        />
        <DetailGrid>
          <DetailMain>
            <Section title="Order lines">
              <div className="text-[12px] text-ink-secondary">
                Osaka 3-seater ×1 · Kyoto recliner ×2 — RM 18,540.00
              </div>
            </Section>
          </DetailMain>
          <DetailAside>
            <Section title="Delivery">
              <DefinitionList
                items={[
                  { label: "DO ref", value: "DO-01842", mono: true },
                  { label: "Scheduled", value: "18 Jun 2026" },
                ]}
              />
            </Section>
          </DetailAside>
        </DetailGrid>
      </div>
    </DetailLayout>
  </Frame>
);

export const LoadingState = () => (
  <Frame>
    <DetailLayout
      breadcrumbs={[{ label: "Service Cases", to: "/assr" }, { label: "ASSR-0231" }]}
      eyebrow="Service Case · ASSR-0231"
      title="Recliner mechanism jam"
      loading
    >
      {null}
    </DetailLayout>
  </Frame>
);

export const ErrorState = () => (
  <Frame>
    <DetailLayout
      breadcrumbs={[{ label: "Delivery Orders", to: "/do" }, { label: "DO-01842" }]}
      eyebrow="Delivery Order · DO-01842"
      title="Bandar Puteri install"
      actions={<Badge tone="warning">Sync paused</Badge>}
      error="Failed to load delivery order — AutoCount mirror unavailable."
    >
      {null}
    </DetailLayout>
  </Frame>
);
