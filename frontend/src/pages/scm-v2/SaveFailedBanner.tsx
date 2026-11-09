import { useEffect, useRef } from "react";

/* Conts #518: the Sales Order page's Save sits in a sticky header, and this
   banner renders above the form. A save that failed while the operator was
   scrolled down left the banner off-screen and the failure unnoticed. It now
   brings itself into view each time a new message lands; `block: "center"`
   keeps it clear of the sticky header, which a top-aligned scroll would put
   it under. */
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
