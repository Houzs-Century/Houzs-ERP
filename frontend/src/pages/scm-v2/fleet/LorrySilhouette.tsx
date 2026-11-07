// A lorry drawn to its own box size (owner 2026-11-07): a cab-over cab of fixed size and
// a container box whose length and height follow the lorry's feet, on one scale for
// every lorry, so a 10 ft box reads shorter than a 17 ft one side by side.
import { cn } from "../../../lib/utils";

/** Feet the drawing can hold; a longer box is drawn at this length. */
const MAX_FT = 24;
const MAX_H_FT = 9;

export function LorrySilhouette({ box, labels, className }: {
  box: { length: number; width: number; height: number } | null;
  labels: boolean;
  className?: string;
}) {
  const W = 300, H = 120, ground = 100, px = 10; // 10 px per foot
  const cabW = 46, cabH = 54;
  const len = Math.min(box?.length ?? 14, MAX_FT) * px;
  const ht = Math.min(box?.height ?? 7, MAX_H_FT) * px;
  const boxX = 8, boxY = ground - 14 - ht, cabX = boxX + len + 4;
  const wheel = (cx: number) => <g key={cx}><circle cx={cx} cy={ground - 2} r={9} fill="#26302b" /><circle cx={cx} cy={ground - 2} r={3.5} fill="#c9cfc6" /></g>;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={cn("block w-full", className)} role="img"
      aria-label={box ? `Box ${box.length} by ${box.width} by ${box.height} feet` : "Box size not entered"}>
      <ellipse cx={(boxX + cabX + cabW) / 2} cy={ground + 8} rx={(cabX + cabW - boxX) / 2} ry={4} fill="#000" opacity={0.08} />
      <rect x={boxX} y={ground - 16} width={cabX + cabW - boxX} height={6} rx={2} fill="#3b4540" />
      <rect x={boxX} y={boxY} width={len} height={ht} rx={2}
        fill={box ? "#dcebe5" : "none"} stroke={box ? "#16695f" : "#9aa39b"} strokeWidth={1.5} strokeDasharray={box ? undefined : "5 4"} />
      {box && Array.from({ length: Math.floor(len / 14) }, (_, i) => (
        <line key={i} x1={boxX + 7 + i * 14} x2={boxX + 7 + i * 14} y1={boxY + 4} y2={boxY + ht - 4} stroke="#16695f" strokeOpacity={0.18} />
      ))}
      <path d={`M${cabX} ${ground - 16} V${ground - 16 - cabH} H${cabX + cabW - 10} L${cabX + cabW} ${ground - 16 - cabH + 14} V${ground - 16} Z`} fill="#16695f" />
      <rect x={cabX + 18} y={ground - 16 - cabH + 6} width={20} height={16} rx={2} fill="#bfe0d8" />
      {wheel(boxX + 22)}{wheel(boxX + 42)}{wheel(cabX + cabW - 14)}
      {labels && box && (
        <g fontSize={10} fill="#3b4540">
          <line x1={boxX} x2={boxX + len} y1={boxY - 7} y2={boxY - 7} stroke="#3b4540" strokeWidth={0.8} />
          <text x={boxX + len / 2} y={boxY - 10} textAnchor="middle">{`L ${box.length} ft`}</text>
          <text x={boxX + len / 2} y={boxY + ht / 2 + 4} textAnchor="middle" fill="#16695f">{`H ${box.height} ft · W ${box.width} ft`}</text>
        </g>
      )}
      {labels && !box && <text x={boxX + len / 2} y={boxY + ht / 2 + 4} textAnchor="middle" fontSize={11} fill="#7a8379">Size not entered</text>}
    </svg>
  );
}
