
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface AssistantPanelState {
  open: boolean;
  openPanel: () => void;
  closePanel: () => void;
  toggle: () => void;
}

const Ctx = createContext<AssistantPanelState | null>(null);

export function AssistantPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openPanel = useCallback(() => setOpen(true), []);
  const closePanel = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const value = useMemo(
    () => ({ open, openPanel, closePanel, toggle }),
    [open, openPanel, closePanel, toggle],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistantPanel(): AssistantPanelState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAssistantPanel must be used within AssistantPanelProvider");
  return ctx;
}
