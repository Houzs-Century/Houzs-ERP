import { Avatar } from "autocount-sync-frontend";

// User initials / profile-photo circle. Previews pass userId={null} so
// the component stays on the initials fallback (no blob fetch).

export const Sizes = () => (
  <div className="flex items-end gap-3">
    <Avatar userId={null} name="Farra Aziz" size={24} />
    <Avatar userId={null} name="Farra Aziz" size={32} />
    <Avatar userId={null} name="Farra Aziz" size={44} />
    <Avatar userId={null} name="Farra Aziz" size={64} />
  </div>
);

export const Fallbacks = () => (
  <div className="flex items-center gap-3">
    <Avatar userId={null} name="Hafiz Rahman" size={36} />
    <Avatar userId={null} email="dispatch@houzscentury.com" size={36} />
    <Avatar userId={null} name={null} email={null} size={36} />
  </div>
);

export const RingAndSquare = () => (
  <div className="flex items-center gap-5 p-1">
    <Avatar userId={null} name="Farra Aziz" size={40} ring />
    <Avatar userId={null} name="Wei Jian Tan" size={48} shape="square" />
    <Avatar userId={null} name="Hafiz Rahman" size={48} shape="square" ring />
  </div>
);

export const InContext = () => (
  <div className="w-72 rounded-lg border border-border bg-surface p-3 shadow-stone">
    <div className="flex items-center gap-3">
      <Avatar userId={null} name="Hafiz Rahman" size={36} />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-ink">Hafiz Rahman</div>
        <div className="text-[11px] text-ink-secondary">Technician — assigned ASSR-0231</div>
      </div>
    </div>
    <div className="mt-3 flex items-center gap-1.5 border-t border-border-subtle pt-3">
      <span className="text-[11px] text-ink-muted">Install crew:</span>
      <div className="flex -space-x-1.5">
        <Avatar userId={null} name="Wei Jian Tan" size={24} className="ring-2 ring-surface" />
        <Avatar userId={null} name="Arun Kumar" size={24} className="ring-2 ring-surface" />
        <Avatar userId={null} name="Syafiq Zulkifli" size={24} className="ring-2 ring-surface" />
      </div>
    </div>
  </div>
);
