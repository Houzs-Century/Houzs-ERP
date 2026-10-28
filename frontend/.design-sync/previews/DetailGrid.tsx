import {
  DetailGrid,
  DetailMain,
  DetailAside,
  Section,
  DefinitionList,
  Badge,
} from "autocount-sync-frontend";

// 8/12 + 4/12 body grid for detail pages — heavy content in Main, metadata
// in Aside. Stacks to one column below lg.

export const MainPlusAside = () => (
  <div className="min-w-[720px] bg-bg p-3">
    <DetailGrid>
      <DetailMain>
        <Section title="Case timeline">
          <ul className="space-y-1.5 text-[12px] text-ink-secondary">
            <li><span className="font-mono text-ink-muted">02 Jul</span> — ASSR-0231 opened by Tan Wei Ming</li>
            <li><span className="font-mono text-ink-muted">03 Jul</span> — Hafiz Rahman assigned, parts ordered</li>
            <li><span className="font-mono text-ink-muted">05 Jul</span> — Visit scheduled, PM slot</li>
          </ul>
        </Section>
      </DetailMain>
      <DetailAside>
        <Section title="Case info">
          <DefinitionList
            items={[
              { label: "Case no", value: "ASSR-0231", mono: true },
              { label: "SLA", value: <Badge tone="error">2 days over</Badge> },
            ]}
          />
        </Section>
      </DetailAside>
    </DetailGrid>
  </div>
);

export const FullWidthChild = () => (
  <div className="min-w-[720px] bg-bg p-3">
    <DetailGrid>
      <div className="lg:col-span-12">
        <Section title="Payments">
          <div className="text-[12px] text-ink-secondary">
            RM 9,270.00 deposit received 12 Jun 2026 · balance RM 9,270.00 due on delivery.
          </div>
        </Section>
      </div>
    </DetailGrid>
  </div>
);
