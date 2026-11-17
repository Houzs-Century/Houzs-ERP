import { useLayoutEffect, useState, type CSSProperties, type ReactElement, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export interface AnchoredMenuProps {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  menuStyle: CSSProperties;
  children: ReactNode;
}

export interface AnchoredMenuPosition {
  top: number;
  right: number;
}

const GAP_BELOW_ANCHOR_PIXELS = 4;

function measureBelowAnchor(anchor: HTMLElement): AnchoredMenuPosition {
  const { bottom, right } = anchor.getBoundingClientRect();
  return { top: bottom + GAP_BELOW_ANCHOR_PIXELS, right: window.innerWidth - right };
}

export function AnchoredMenu({ anchorRef, onClose, menuStyle, children }: AnchoredMenuProps): ReactElement | null {
  const [position, setPosition] = useState<AnchoredMenuPosition | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const followAnchor = (): void => setPosition(measureBelowAnchor(anchor));
    followAnchor();
    window.addEventListener("scroll", followAnchor, true);
    window.addEventListener("resize", followAnchor);
    return () => {
      window.removeEventListener("scroll", followAnchor, true);
      window.removeEventListener("resize", followAnchor);
    };
  }, [anchorRef]);

  if (!position) return null;
  return createPortal(
    <>
      <div data-testid="anchored-menu-backdrop" onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
      <div role="menu" style={{ ...menuStyle, position: "fixed", top: position.top, right: position.right, zIndex: 41 }}>
        {children}
      </div>
    </>,
    document.body,
  );
}
