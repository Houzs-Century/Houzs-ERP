import {
  DetailMain,
  DetailGrid,
  DetailAside,
  Section,
  HeaderButton,
} from "autocount-sync-frontend";

// Main (8/12) column of the detail body grid — stacks its Section cards
// with space-y-3. Only spans 8 columns when placed inside DetailGrid.

export const StackedSections = () => (
  <div className="w-96 bg-bg p-3">
    <DetailMain>
      <Section title="Order lines">
        <div className="text-[12px] text-ink-secondary">
          Osaka 3-seater ×1 · Kyoto recliner ×2 — RM 18,540.00
        </div>
      </Section>
      <Section title="Remarks" actions={<HeaderButton onClick={() => {}}>Edit</HeaderButton>}>
        <p className="text-[12px] leading-relaxed text-ink-secondary">
          Customer requests delivery before Hari Raya Haji; call one day ahead.
        </p>
      </Section>
    </DetailMain>
  </div>
);

export const InsideGrid = () => (
  <div className="min-w-[720px] bg-bg p-3">
    <DetailGrid>
      <DetailMain>
        <Section title="Delivery items">
          <div className="text-[12px] text-ink-secondary">
            DO-01842 — 3 items, Bandar Puteri install crew, AM slot.
          </div>
        </Section>
      </DetailMain>
      <DetailAside>
        <Section title="Driver">
          <div className="text-[12.5px] text-ink">Azlan Musa · WXB 8127</div>
        </Section>
      </DetailAside>
    </DetailGrid>
  </div>
);
