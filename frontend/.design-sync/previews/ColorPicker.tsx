import { useState } from "react";
import { ColorPicker } from "autocount-sync-frontend";

// Colour chip trigger + hex input popover — brand / department colour
// editors in Project Maintenance and Team settings. Values are 6-char
// hex WITHOUT '#'. Popover opens on click; cards show the closed chip.

const PRESETS = ["16695f", "a16a2e", "1f3a8a", "b23a3a", "2f8a5b"];

export const Chip = () => {
  const [hex, setHex] = useState("16695f");
  return <ColorPicker value={hex} onChange={setHex} presets={PRESETS} ariaLabel="Brand colour" />;
};

export const Sizes = () => {
  const [hex, setHex] = useState("a16a2e");
  return (
    <div className="flex items-center gap-3">
      <ColorPicker value={hex} onChange={setHex} size={22} />
      <ColorPicker value={hex} onChange={setHex} />
      <ColorPicker value={hex} onChange={setHex} size={36} />
    </div>
  );
};

export const InBrandRow = () => {
  const [hex, setHex] = useState("1f3a8a");
  return (
    <div className="flex w-72 items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 shadow-stone">
      <div>
        <div className="text-[12.5px] font-semibold text-ink">Panasonic</div>
        <div className="font-mono text-[10.5px] text-ink-muted">#{hex}</div>
      </div>
      <ColorPicker value={hex} onChange={setHex} presets={PRESETS} />
    </div>
  );
};
