import { useState } from "react";

/* A purchase invoice's PO numbers in a header cell: the first `shown`, then a
   "+N more" toggle that expands to the full list. The full list is also the
   hover title, so it can be read without clicking. */
export function PoNumberList({ poNumbers, shown }: { poNumbers: string[]; shown: number }) {
  const [open, setOpen] = useState(false);
  if (poNumbers.length === 0) return <span>—</span>;
  const more = poNumbers.length - shown;
  const visible = open || more <= 0 ? poNumbers : poNumbers.slice(0, shown);
  return (
    <span title={poNumbers.join(", ")}>
      {visible.join(", ")}
      {more > 0 && (
        <>
          {" "}
          <button
            type="button"
            className="font-sans text-[11.5px] font-semibold text-primary-ink underline-offset-2 hover:underline"
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
            aria-expanded={open}
          >
            {open ? "show less" : `+${more} more`}
          </button>
        </>
      )}
    </span>
  );
}
