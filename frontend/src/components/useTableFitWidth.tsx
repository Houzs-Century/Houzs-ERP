import { useLayoutEffect, useRef, useState } from "react";
import { Shrink } from "lucide-react";
import { cn } from "../lib/utils";
import { useLocalStorage } from "../hooks/useLocalStorage";

/* DataTable's Fit switch: zoom the table down until its fixed width fits the
   scroll box, so a wide board reads without scrolling sideways. A personal
   preference per table, like Wrap. `scaleRef` converts screen px (a column
   drag, the row window) back to table px. */
export function useTableFitWidth(
  idKey: string,
  enabled: boolean,
  getWrap: () => HTMLElement | null,
  tableWidth: number | undefined,
) {
  const [fitWidth, setFitWidth] = useLocalStorage<boolean>(`dt:fit:${idKey}`, false, undefined, (v) => v === true);
  const fitOn = enabled && fitWidth && !!tableWidth;
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  scaleRef.current = fitOn ? scale : 1;
  useLayoutEffect(() => {
    const wrap = getWrap();
    if (!fitOn || !wrap || !tableWidth) return;
    const fit = () => setScale(Math.min(1, Math.floor((wrap.clientWidth / tableWidth) * 1000) / 1000));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getWrap reads a ref
  }, [fitOn, tableWidth]);
  return { fitWidth, setFitWidth, fitOn, fitScale: fitOn ? scale : 1, scaleRef };
}

export function FitWidthButton({ fit, className }: { fit: ReturnType<typeof useTableFitWidth>; className: string }) {
  return (
    <button
      type="button"
      onClick={() => fit.setFitWidth(!fit.fitWidth)}
      aria-pressed={fit.fitWidth}
      title={fit.fitWidth ? "Show columns at full size" : "Shrink the table so every column fits the screen"}
      className={cn(className, "hidden sm:inline-flex", fit.fitWidth && "border-primary/40 bg-primary-soft text-primary")}
    >
      <Shrink size={13} />
      {fit.fitScale < 1 ? `Fit ${Math.round(fit.fitScale * 100)}%` : "Fit"}
    </button>
  );
}
