import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { cn } from "../lib/utils";
import {
  activateWorkspaceTab,
  closeWorkspaceTab,
  getWorkspaceTabsSnapshot,
  moveWorkspaceTab,
  recordWorkspaceVisit,
  sectionKeyFor,
  subscribeWorkspaceTabs,
  workspaceTabLabel,
} from "../lib/workspaceTabs";

/**
 * Workspace tab strip — rendered INLINE on the left of TopNavbar's single
 * 52px bar (top-chrome redesign 2b, owner handoff 2026-07-23: one row, no
 * second bar). Active tab = primary-ink text + a 2.5px petrol underline on
 * the bar's bottom edge; ✕ closes (hover-revealed on background tabs,
 * always visible on the active one); middle-click closes.
 *
 * DRAG TO REORDER (owner ask 2026-07-23: "可以自主拖拽前后"): grab a tab and
 * drag it along the strip — native HTML5 DnD (the repo idiom, see
 * Positions.tsx), reordering LIVE as the pointer crosses each neighbour's
 * midpoint, browser-tab style. Order persists with the strip
 * (sessionStorage, per window) and close-neighbour semantics follow the new
 * order. The inner <Link> sets draggable={false} so grabbing a tab drags
 * the TAB, not the link URL; plain clicks are untouched (DnD only engages
 * on an actual drag).
 *
 * Behaviour is otherwise unchanged from the shipped browser model
 * (lib/workspaceTabs.ts): in-content navigation re-points the ACTIVE tab,
 * only a sidebar click spawns/activates, and Ctrl/Cmd+click falls through
 * to a real browser window — which then keeps its own per-window company
 * and its own strip (lib/activeCompany.ts).
 *
 * This component still owns the recordWorkspaceVisit effect — TopNavbar is
 * mounted (CSS-hidden) below lg, so recording keeps working at every width
 * exactly as it did when the strip was its own bar.
 */
export function WorkspaceTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const { tabs, activeId } = useSyncExternalStore(
    subscribeWorkspaceTabs,
    getWorkspaceTabsSnapshot,
    getWorkspaceTabsSnapshot,
  );
  // Id of the tab being dragged (null = no drag). State so the dragged tab
  // can dim; a ref mirror so dragover handlers read the CURRENT value without
  // re-binding listeners mid-drag.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);

  // Record AFTER render (an effect, not render-time) — recordWorkspaceVisit
  // emits, and emitting during render would schedule an update mid-render.
  useEffect(() => {
    recordWorkspaceVisit(location.pathname, location.search);
  }, [location.pathname, location.search]);

  function close(id: string) {
    const { navigateTo } = closeWorkspaceTab(id);
    if (navigateTo !== null) navigate(navigateTo);
  }

  return (
    <div
      role="tablist"
      aria-label="Open pages"
      className="thin-scroll flex h-full min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto overflow-y-hidden"
      // Dropping on the strip's empty tail (right of the last tab) must not
      // bounce back or navigate — order was already applied live on dragover.
      onDragOver={(e) => {
        if (draggingRef.current !== null) e.preventDefault();
      }}
      onDrop={(e) => {
        if (draggingRef.current !== null) e.preventDefault();
      }}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeId;
        const label = workspaceTabLabel(sectionKeyFor(tab.href));
        return (
          <div
            key={tab.id}
            draggable
            onDragStart={(e) => {
              // Firefox refuses to start a drag without data; "move" keeps
              // the cursor honest. The tab itself is the drag image.
              e.dataTransfer.setData("text/plain", tab.id);
              e.dataTransfer.effectAllowed = "move";
              draggingRef.current = tab.id;
              setDraggingId(tab.id);
            }}
            onDragEnd={() => {
              draggingRef.current = null;
              setDraggingId(null);
            }}
            onDragOver={(e) => {
              const dragged = draggingRef.current;
              if (dragged === null) return; // foreign drag (a file, a link) — ignore
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragged === tab.id) return;
              // Live reorder, browser-tab style: crossing this tab's midpoint
              // slots the dragged tab before/after it. The insertion index is
              // expressed post-removal (moveWorkspaceTab splices out first),
              // hence the -1 when the dragged tab currently sits to our left.
              // moveWorkspaceTab no-ops on same-position, so the continuous
              // dragover stream stays cheap and the midpoint rule is stable.
              const rect = e.currentTarget.getBoundingClientRect();
              const after = e.clientX > rect.left + rect.width / 2;
              const from = tabs.findIndex((t) => t.id === dragged);
              moveWorkspaceTab(dragged, index + (after ? 1 : 0) - (from < index ? 1 : 0));
            }}
            onDrop={(e) => {
              // Order was applied live during dragover; just swallow the drop
              // so the browser doesn't navigate/open anything.
              if (draggingRef.current !== null) e.preventDefault();
            }}
            /* Middle-click closes, Chrome-tab style (owner 2026-07-26) — on
               the WHOLE tab, not just the <Link> label: the padding and the
               close-button gutter are part of "the tab" to a mouse, and the
               old Link-only handler made middle-clicks there do nothing.
               mousedown preventDefault kills Windows Chrome's middle-button
               autoscroll before it starts; auxclick then closes. */
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                close(tab.id);
              }
            }}
            className={cn(
              "group relative flex shrink-0 items-center transition-colors",
              isActive ? "text-primary-ink" : "text-ink-secondary hover:text-ink",
              draggingId === tab.id && "opacity-50",
            )}
          >
            <Link
              to={tab.href}
              role="tab"
              aria-selected={isActive}
              data-tab-id={tab.id}
              draggable={false}
              onClick={(e) => {
                // Plain left click: mark the clicked tab active BEFORE the
                // route changes, so the ensuing location effect re-points
                // nothing. Modified clicks open a real browser window — this
                // tab never navigates, so it must NOT change active either.
                if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                  activateWorkspaceTab(tab.id);
                }
              }}
              {/* Middle-click close lives on the wrapper div now (whole-tab
                  hit area); a second handler here would double-fire via
                  bubbling. */}
              className={cn(
                "flex max-w-[13rem] items-center self-center truncate py-2 pl-[15px] pr-0.5 text-[13px] leading-none",
                isActive ? "font-semibold" : "font-medium",
              )}
            >
              {label}
            </Link>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => close(tab.id)}
              title="Close tab"
              aria-label={`Close ${label}`}
              className={cn(
                "mr-1.5 flex h-[18px] w-[18px] items-center justify-center self-center rounded-[5px] transition-colors hover:bg-surface-2 hover:text-ink-secondary",
                isActive ? "text-ink-muted" : "text-transparent group-hover:text-ink-muted",
              )}
            >
              <X size={11} strokeWidth={2.5} />
            </button>
            {/* 2b active affordance: 2.5px petrol underline on the bar's
                bottom edge, inset 11px each side per the mock. */}
            {isActive && (
              <span className="absolute inset-x-[11px] bottom-0 h-[2.5px] rounded-[2px] bg-primary" />
            )}
          </div>
        );
      })}
    </div>
  );
}
