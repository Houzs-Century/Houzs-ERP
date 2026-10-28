import { StatStrip, Section } from "autocount-sync-frontend";

// Horizontal hairline-divided stat row for detail pages — 2-up on mobile,
// 4-up from sm. tone colours the mono value; hint is a small caption.

export const SalesOrderStats = () => (
  <div className="min-w-[560px]">
    <StatStrip
      items={[
        { label: "Total", value: "RM 18,540.00" },
        { label: "Paid", value: "RM 9,270.00", hint: "50% deposit", tone: "ok" },
        { label: "Balance", value: "RM 9,270.00", tone: "warn" },
        { label: "Lines", value: "3" },
      ]}
    />
  </div>
);

export const Tones = () => (
  <div className="min-w-[560px]">
    <StatStrip
      items={[
        { label: "Default", value: "DO-01842" },
        { label: "Ok", value: "Synced", hint: "13 Jun 09:41", tone: "ok" },
        { label: "Warn", value: "Awaiting parts", tone: "warn" },
        { label: "Err", value: "2 days over SLA", tone: "err" },
      ]}
    />
  </div>
);

export const AboveSection = () => (
  <div className="min-w-[560px] space-y-3 bg-bg p-3">
    <StatStrip
      items={[
        { label: "Open cases", value: "12" },
        { label: "Over SLA", value: "3", tone: "err" },
        { label: "Avg resolve", value: "4.2 days" },
        { label: "This week", value: "5 closed", tone: "ok" },
      ]}
    />
    <Section title="Service cases">
      <div className="text-[12px] text-ink-secondary">
        ASSR-0231 recliner jam · ASSR-0228 fabric tear · ASSR-0224 frame creak
      </div>
    </Section>
  </div>
);
