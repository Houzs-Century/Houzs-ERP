import { useEffect, useRef } from "react";

export function SaveFailedBanner({ message, className }: { message: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [message]);
  return (
    <div ref={ref} role="alert" className={className}>
      <strong>Save failed.</strong>
      <span>{message}</span>
    </div>
  );
}
