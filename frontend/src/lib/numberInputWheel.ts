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
