import { Section, HeaderButton, DefinitionList, Badge } from "autocount-sync-frontend";

// Detail-page section card — lighter, denser sibling of PanelSection for
// full-page surfaces. Mono uppercase header with a brass tick; `dense`
// removes inner padding for flush tabular content.

export const Canonical = () => (
  <div className="w-96">
    <Section title="Delivery details">
      <DefinitionList
        items={[
          { label: "DO no", value: "DO-01842", mono: true },
          { label: "Scheduled", value: "18 Jun 2026" },
          { label: "Driver", value: "Azlan Musa" },
          { label: "Vehicle", value: "WXB 8127", mono: true },
        ]}
      />
    </Section>
  </div>
);

export const WithActions = () => (
  <div className="w-96">
    <Section
      title="AutoCount sync"
      actions={
        <>
          <Badge tone="warning">Paused</Badge>
          <HeaderButton onClick={() => {}}>Retry</HeaderButton>
        </>
      }
    >
      <p className="text-[12px] leading-relaxed text-ink-secondary">
        Sync disabled on 13 Jun 2026. Local sales order mirror is frozen at
        that date; totals below may lag AutoCount.
      </p>
    </Section>
  </div>
);

export const DenseTable = () => (
  <div className="w-96">
    <Section title="Order lines" dense>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border-subtle bg-surface-2 text-left font-mono text-[9.5px] uppercase tracking-brand text-ink-muted">
            <th className="px-3 py-1.5 font-semibold">Item</th>
            <th className="px-3 py-1.5 font-semibold">Qty</th>
            <th className="px-3 py-1.5 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle text-ink">
          <tr>
            <td className="px-3 py-1.5">Osaka 3-seater, fabric grey</td>
            <td className="px-3 py-1.5">1</td>
            <td className="px-3 py-1.5 text-right font-mono">RM 4,890.00</td>
          </tr>
          <tr>
            <td className="px-3 py-1.5">Kyoto recliner, leather tan</td>
            <td className="px-3 py-1.5">2</td>
            <td className="px-3 py-1.5 text-right font-mono">RM 13,650.00</td>
          </tr>
        </tbody>
      </table>
    </Section>
  </div>
);

export const StackedOnCanvas = () => (
  <div className="w-96 space-y-3 rounded-lg bg-bg p-3">
    <Section title="Case summary">
      <p className="text-[12px] leading-relaxed text-ink-secondary">
        ASSR-0231 — recliner mechanism jams halfway. Customer prefers a
        weekday morning visit.
      </p>
    </Section>
    <Section title="Technician" actions={<HeaderButton onClick={() => {}}>Reassign</HeaderButton>}>
      <div className="text-[12.5px] text-ink">Hafiz Rahman · Klang Valley team</div>
    </Section>
  </div>
);
