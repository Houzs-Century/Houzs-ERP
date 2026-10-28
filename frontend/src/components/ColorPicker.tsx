import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

/**
 * Native HTML5 colour picker behind a chip trigger, plus a hex text
 * input for precise entry and an optional row of preset swatches.
 *
 * Values are 6-char hex WITHOUT the leading '#' — every DB column
 * that stores colour (project_brands.color, departments.color) uses
 * that shape, and the SPA renders them via `style={{backgroundColor:
 * `#${hex}`}}` everywhere.
 *
 * Used by Project Maintenance brand editor and Team department editor.
 */
export function ColorPicker({
  value,
  onChange,
  presets,
  size = 28,
  ariaLabel,
}: {
  /** Current colour, 6-char hex, no '#'. */
  value: string;
  /** Called with the new hex (no '#'). Only fires on a valid 6-char hex. */
  onChange: (hex: string) => void;
  /** Optional quick-pick swatches under the picker. Hex without '#'. */
  presets?: string[];
  /** Trigger chip size in px. Default 28. */
  size?: number;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState(value);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Keep the draft in sync when the source value changes from outside
  // (e.g. preset click, or another edit in the same form).
  useEffect(() => setHexDraft(value), [value]);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  function commit(next: string) {
    const clean = next.replace(/^#/, "").toLowerCase();
    if (/^[0-9a-f]{6}$/.test(clean)) onChange(clean);
  }

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`#${value}`}
        aria-label={ariaLabel || "Pick colour"}
        style={{ backgroundColor: `#${value}`, width: size, height: size }}
        className={cn(
          "rounded-md border-2 transition-all",
          open ? "border-ink scale-105" : "border-border hover:border-ink/40"
        )}
      />
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-60 rounded-md border border-border bg-surface p-3 shadow-slab">
          <div className="mb-2 flex items-center gap-2">
            {/* Native picker — opens the OS / browser colour wheel. */}
            <input
              type="color"
              value={`#${value}`}
              onChange={(e) => commit(e.target.value)}
              className="h-8 w-12 cursor-pointer rounded-md border border-border bg-surface"
              aria-label="Colour wheel"
            />
            <span className="font-mono text-[11px] text-ink-muted">#</span>
            <input
              type="text"
              value={hexDraft}
              onChange={(e) => setHexDraft(e.target.value)}
              onBlur={() => commit(hexDraft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commit(hexDraft);
                  setOpen(false);
                }
              }}
              maxLength={7}
              spellCheck={false}
              className="h-8 flex-1 rounded-md border border-border bg-surface px-2 font-mono text-[11.5px] uppercase tracking-wider text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
              aria-label="Hex value"
            />
          </div>
          {presets && presets.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
                Presets
              </div>
              <div className="flex flex-wrap gap-1.5">
                {presets.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => {
                      onChange(hex);
                      setHexDraft(hex);
                    }}
                    title={`#${hex}`}
                    className={cn(
                      "h-5 w-5 rounded-md border transition-all hover:scale-110",
                      value === hex
                        ? "border-ink shadow-stone"
                        : "border-border opacity-80"
                    )}
                    style={{ backgroundColor: `#${hex}` }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
