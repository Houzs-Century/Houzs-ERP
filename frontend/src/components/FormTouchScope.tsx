import type { ReactNode, SyntheticEvent } from "react";

/**
 * Reports the first time the person touches the form inside it: types in a
 * field, changes a select or checkbox, or picks an option from a list. React
 * events bubble through portals, so pickers and sheets rendered elsewhere in the
 * DOM still count. Values the page sets itself (defaults, seeds) fire no such
 * event and do not. `display: contents` keeps it out of the layout.
 *
 * React's change event, never the native `input` one: a select fires `input`
 * BEFORE `change`, and a re-render between the two puts the controlled select
 * back to its old value, so the pick is lost (seen in MobilePurchaseDocNew's
 * tests). Marking on change lands in the same batch as the field's own update.
 */
export function FormTouchScope({ onTouch, children }: { onTouch: () => void; children: ReactNode }) {
  const onPick = (e: SyntheticEvent) => {
    if (e.target instanceof Element && e.target.closest('[role="option"]')) onTouch();
  };
  return (
    <div
      style={{ display: "contents" }}
      onChangeCapture={onTouch}
      onMouseDownCapture={onPick}
      onClickCapture={onPick}
    >
      {children}
    </div>
  );
}
