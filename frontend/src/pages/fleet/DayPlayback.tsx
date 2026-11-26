// Play a lorry's day back fix by fix (lorry page history). The playhead is null until
// the user plays or drags; a new day (resetKey) starts over.
import { useEffect, useState } from "react";
import { fmtTime } from "../../vendor/shared/format";
import { BTN_SEC } from "./FleetUi";

type PlayFix = { lat: number; lng: number; recorded_at: string; speed_kmh: number | null };

const STEP_MS = 400;

export function useDayPlayback<F extends PlayFix>(fixes: F[], resetKey: string) {
  const [idx, setIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const last = fixes.length - 1;
  useEffect(() => { setIdx(null); setPlaying(false); }, [resetKey]);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setIdx((i) => {
      const next = Math.min((i ?? -1) + 1, last);
      if (next >= last) setPlaying(false);
      return next;
    }), STEP_MS);
    return () => clearInterval(t);
  }, [playing, last]);
  const at = idx == null ? null : Math.min(idx, last);
  return {
    playhead: at != null && at >= 0 ? fixes[at]! : null,
    position: at ?? 0,
    last,
    playing,
    toggle: () => {
      if (playing) return setPlaying(false);
      if (at == null || at >= last) setIdx(0);
      setPlaying(true);
    },
    seek: (i: number) => { setPlaying(false); setIdx(i); },
  };
}

export function PlaybackBar({ p, count }: { p: ReturnType<typeof useDayPlayback>; count: number }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[#d9d3c6] bg-surface px-3 py-2">
      <button type="button" className={BTN_SEC} aria-label={p.playing ? "Pause playback" : "Play the day"} onClick={p.toggle}>
        {p.playing ? "Pause" : "Play"}
      </button>
      <input type="range" min={0} max={p.last} value={p.position} aria-label="Playback position"
        onChange={(e) => p.seek(Number(e.target.value))} className="min-w-[160px] flex-1" />
      <span className="text-[12.5px] tabular-nums text-ink-muted">
        {p.playhead ? `${fmtTime(p.playhead.recorded_at)} MYT${p.playhead.speed_kmh != null ? ` · ${Math.round(p.playhead.speed_kmh)} km/h` : ""}` : `${count} fixes`}
      </span>
    </div>
  );
}
