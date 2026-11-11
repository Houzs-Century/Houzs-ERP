import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "../lib/utils";
import { useThemePreference, type ThemePreference } from "../lib/theme";

const THEME_OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "Auto", Icon: Monitor },
];

export default function ThemeChoice() {
  const [pref, setPref] = useThemePreference();
  return (
    <div className="mt-0.5 px-2.5 py-2">
      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted">
        Appearance
      </div>
      <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-3 gap-1 rounded-md bg-surface-2 p-0.5">
        {THEME_OPTIONS.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={pref === value}
            onClick={() => setPref(value)}
            title={value === "system" ? "Follow this device's setting" : `${label} theme`}
            className={cn(
              "flex items-center justify-center gap-1 rounded px-1.5 py-1 text-[11.5px] font-medium transition-colors",
              pref === value ? "bg-surface text-primary shadow-stone" : "text-ink-muted hover:text-ink",
            )}
          >
            <Icon size={12} className="shrink-0" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
