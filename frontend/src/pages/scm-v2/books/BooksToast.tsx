// The Books pages' toast (the owner's redesign, batch 6 §1.4): dark, with a
// brass check, top centre, gone after a few seconds. It confirms what a
// person just did; a refusal keeps the shared error dialog of the mutation.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import s from './Books.module.css';

const SHOWN_MS = 3200;

export function useBooksToast(): { node: ReactNode; say: (text: string) => void } {
  const [text, setText] = useState('');
  const timer = useRef<number | null>(null);
  const say = useCallback((t: string) => {
    setText(t);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setText(''), SHOWN_MS);
  }, []);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);
  const node = text
    ? <div className={s.toast} role="status"><CheckCircle2 size={16} aria-hidden /><span>{text}</span></div>
    : null;
  return { node, say };
}
