
export type MailLabel = {
  id: string;
  name: string;
  color: string;
  createdAt: string;
};

export const LABEL_PALETTE: { value: string; name: string }[] = [
  { value: "#6B5C32", name: "Brown" },
  { value: "#B45309", name: "Amber" },
  { value: "#15803D", name: "Green" },
  { value: "#0E7490", name: "Teal" },
  { value: "#1D4ED8", name: "Blue" },
  { value: "#6D28D9", name: "Violet" },
  { value: "#BE185D", name: "Pink" },
  { value: "#B91C1C", name: "Red" },
  { value: "#475569", name: "Slate" },
];

export const DEFAULT_LABEL_COLOR = LABEL_PALETTE[0].value;

export function labelColorMap(labels: MailLabel[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of labels) {
    const c = (l.color || "").trim();
    m.set(l.name.toLowerCase(), c || DEFAULT_LABEL_COLOR);
  }
  return m;
}

export function colorForLabel(
  name: string,
  map: Map<string, string>,
): string {
  return map.get(name.toLowerCase()) || DEFAULT_LABEL_COLOR;
}

export function chipStyle(color: string): {
  backgroundColor: string;
  color: string;
} {
  const hex = (color || "").trim();
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) {
    return { backgroundColor: "#EFE9DD", color: "#6B5C32" };
  }
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  return {
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.12)`,
    color: `#${m[1]}`,
  };
}
