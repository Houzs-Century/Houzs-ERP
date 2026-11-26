import { cn } from "../lib/utils";


export function NextStepNote({
  id,
  reason,
  className,
}: {
  id: string;
  reason: string | null | undefined;
  className?: string;
}) {
  if (!reason) return null;
  return (
    <p
      id={id}
      className={cn(
        "text-[11.5px] leading-snug text-ink-muted",
        className
      )}
    >
      {reason}
    </p>
  );
}
