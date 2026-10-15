/* The PIN card (layout P1): dots, a three-column keypad, Clear / Enter, a
 * shake on a wrong PIN. 4 to 6 digits; Enter also fires on the 6th digit. */
import { useEffect, useState } from "react";

export function PinPad({ title, onSubmit, disabled, error, lockedSeconds, shakeKey, allowKeyboard = true }: {
  title: string;
  onSubmit: (pin: string) => void;
  disabled?: boolean;
  error?: string | null;
  lockedSeconds?: number;
  /** Bump to trigger the shake animation and clear the digits. */
  shakeKey: number;
  allowKeyboard?: boolean;
}) {
  const [pin, setPin] = useState("");
  const [shaking, setShaking] = useState(false);
  useEffect(() => {
    if (shakeKey === 0) return;
    setPin("");
    setShaking(true);
    const t = setTimeout(() => setShaking(false), 400);
    return () => clearTimeout(t);
  }, [shakeKey]);
  const locked = (lockedSeconds ?? 0) > 0;
  const push = (d: string) => {
    if (disabled || locked) return;
    setPin((p) => {
      const n = (p + d).slice(0, 6);
      if (n.length === 6) setTimeout(() => onSubmit(n), 0);
      return n;
    });
  };
  const submit = () => {
    if (disabled || locked || pin.length < 4) return;
    onSubmit(pin);
  };
  useEffect(() => {
    if (!allowKeyboard) return;
    const h = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") push(e.key);
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter") submit();
      else if (e.key === "Escape") setPin("");
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });
  return (
    <div className={`card pincard${shaking ? " shake" : ""}`}>
      <div className="who">{title}</div>
      <div className="dots">{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} className={i < pin.length ? "on" : i >= 4 && pin.length <= i ? "" : ""} style={i >= 4 && pin.length <= i ? { opacity: 0.35 } : undefined} />)}</div>
      <div className="err">{locked ? `Locked. Try again in ${lockedSeconds} s` : error ?? ""}</div>
      <div className="keypad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => <button key={d} type="button" onClick={() => push(d)} disabled={disabled || locked}>{d}</button>)}
        <button type="button" className="wide" onClick={() => setPin("")} disabled={disabled}>Clear</button>
        <button type="button" onClick={() => push("0")} disabled={disabled || locked}>0</button>
        <button type="button" className="wide enter" onClick={submit} disabled={disabled || locked || pin.length < 4}>Enter</button>
      </div>
    </div>
  );
}
