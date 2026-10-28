import {
  DetailAside,
  Section,
  DefinitionList,
  Badge,
  HeaderButton,
} from "autocount-sync-frontend";

// Aside (4/12) metadata rail of the detail body grid — small Section cards
// for sync state, assignments and reference data.

export const MetadataRail = () => (
  <div className="w-96 bg-bg p-3">
    <DetailAside>
      <Section title="AutoCount">
        <DefinitionList
          items={[
            { label: "Sync", value: <Badge tone="success">Synced</Badge>, full: true },
            { label: "Pushed", value: "2026-06-13 09:41", mono: true, full: true },
          ]}
        />
      </Section>
      <Section title="Customer">
        <DefinitionList
          items={[
            { label: "Name", value: "Tan Wei Ming", full: true },
            { label: "Phone", value: "+60 12-338 4471", mono: true, full: true },
          ]}
        />
      </Section>
    </DetailAside>
  </div>
);

export const AssignmentCard = () => (
  <div className="w-80 bg-bg p-3">
    <DetailAside>
      <Section
        title="Technician"
        actions={<HeaderButton onClick={() => {}}>Reassign</HeaderButton>}
      >
        <div className="text-[12.5px] text-ink">Hafiz Rahman</div>
        <div className="mt-0.5 text-[11px] text-ink-muted">
          Klang Valley team · 4 open cases
        </div>
      </Section>
    </DetailAside>
  </div>
);
