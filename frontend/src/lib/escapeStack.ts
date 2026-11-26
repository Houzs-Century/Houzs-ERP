import { useEffect, useRef } from "react";


type Layer = { close: () => void };

const layers: Layer[] = [];
let listening = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  const top = layers.at(-1);
  if (!top) return;
  e.preventDefault();
  top.close();
}

export function pushEscapeLayer(close: () => void): () => void {
  const layer: Layer = { close };
  layers.push(layer);
  if (!listening && typeof window !== "undefined") {
    window.addEventListener("keydown", onKeyDown);
    listening = true;
  }
  return () => {
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    if (layers.length === 0 && listening) {
      window.removeEventListener("keydown", onKeyDown);
      listening = false;
    }
  };
}

export function escapeLayerCount(): number {
  return layers.length;
}

export function useEscapeLayer(onEscape: () => void, active: boolean): void {
  const ref = useRef(onEscape);
  useEffect(() => {
    ref.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    return pushEscapeLayer(() => ref.current());
  }, [active]);
}
