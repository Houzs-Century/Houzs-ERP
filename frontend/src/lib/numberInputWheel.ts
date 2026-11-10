/* A mouse wheel over a FOCUSED number input steps its value — a staff member
   scrolling down a GRN with the cursor resting on "Received" quietly changed
   the quantity. The app has ~100 raw number inputs and no shared component, so
   this is one listener for the whole document: the focused number input is
   blurred before the browser applies the wheel step, and the page scrolls as
   the user meant. Installed once from main.tsx. */
export function blurFocusedNumberInputOnWheel(event: Event): void {
  const target = event.target;
  if (
    target instanceof HTMLInputElement &&
    target.type === "number" &&
    target === target.ownerDocument.activeElement
  ) {
    target.blur();
  }
}

export function installNumberInputWheelGuard(doc: Document = document): () => void {
  doc.addEventListener("wheel", blurFocusedNumberInputOnWheel, { capture: true, passive: true });
  return () => doc.removeEventListener("wheel", blurFocusedNumberInputOnWheel, { capture: true });
}
