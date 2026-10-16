/* The popups' frame: Esc closes, the first input gets focus, the sell
 * screen's shortcuts stay quiet while one is open. */
import { useEffect, useRef, type ReactNode } from "react";

export function Modal({ title, onClose, children, width = 520, footer }: { title: string; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    const first = ref.current?.querySelector<HTMLElement>("input, button.focus-first");
    first?.focus();
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width }} ref={ref} role="dialog" aria-label={title}>
        <div className="modal-head"><span>{title}</span><button type="button" className="btn link" onClick={onClose} aria-label="Close">x</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** A numeric keypad shared by Qty, Price and Discount (P4 / P5). */
export function NumKeys({ value, onChange, onEnter, decimals = true, allowKeyboard = true }: { value: string; onChange: (v: string) => void; onEnter: () => void; decimals?: boolean; allowKeyboard?: boolean }) {
  const push = (k: string) => {
    if (k === "<") onChange(value.slice(0, -1));
    else if (k === "C") onChange("");
    else if (k === ".") { if (decimals && !value.includes(".")) onChange(value ? `${value}.` : "0."); }
    else onChange((value + k).replace(/^0+(?=\d)/, ""));
  };
  useEffect(() => {
    if (!allowKeyboard) return;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
      if (e.key >= "0" && e.key <= "9") push(e.key);
      else if (e.key === ".") push(".");
      else if (e.key === "Backspace") push("<");
      else if (e.key === "Enter") onEnter();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
  return (
    <div className="keypad">
      {["7", "8", "9", "4", "5", "6", "1", "2", "3"].map((k) => <button key={k} type="button" onClick={() => push(k)}>{k}</button>)}
      <button type="button" className="wide" onClick={() => push("C")}>Clear</button>
      <button type="button" onClick={() => push("0")}>0</button>
      {decimals ? <button type="button" onClick={() => push(".")}>.</button> : <button type="button" className="wide" onClick={() => push("<")}>Del</button>}
    </div>
  );
}
