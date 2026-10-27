import { fmtDate } from "@2990s/shared";

/* Owner 2026-10-26: Service keys the date it wants (a request); the leg waits in
   Delivery Planning's Pending Schedule until Logistics confirms a date there, and
   the confirmed date shows back here. Shared by the desktop and phone case pages. */
export function logisticsConfirmedText(requested: string | null | undefined, confirmed: string | null | undefined): string {
  if (confirmed) return `Logistics confirmed ${fmtDate(confirmed)}.`;
  return requested
    ? "Waiting for Logistics to confirm this date (Delivery Planning, Pending Schedule)."
    : "Set the date you want; Logistics confirms it in Delivery Planning.";
}

export function LogisticsConfirmedNote({ requested, confirmed }: { requested: string | null | undefined; confirmed: string | null | undefined }) {
  return (
    <div className={confirmed ? "rounded-md bg-primary-soft/50 px-3 py-2 text-[11.5px] font-semibold text-primary" : "rounded-md bg-bg/60 px-3 py-2 text-[11.5px] leading-relaxed text-ink-secondary"}>
      {logisticsConfirmedText(requested, confirmed)}
    </div>
  );
}
