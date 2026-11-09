/* Bring a not-yet-drawn row near, `offset` px into the table body. The app scrolls
   inside a panel (its <main>), not the window: move the nearest scrolling ancestor,
   or the window when nothing above the table scrolls. Scrolling only the window
   left the row never found (Suppliers Back, Conts-ERP #406). A programmatic scroll
   does not always emit `scroll`, and the row window only moves on that event, so
   it is sent here. */
export function scrollPanelNearRow(tbody: HTMLElement, offset: number): void {
  let panel: HTMLElement | null = tbody.parentElement;
  while (panel && !(/(auto|scroll)/.test(getComputedStyle(panel).overflowY) && panel.scrollHeight > panel.clientHeight)) {
    panel = panel.parentElement;
  }
  if (panel) {
    panel.scrollTop += tbody.getBoundingClientRect().top - panel.getBoundingClientRect().top + offset - panel.clientHeight / 2;
    panel.dispatchEvent(new Event("scroll"));
  } else {
    window.scrollTo({ top: window.scrollY + tbody.getBoundingClientRect().top + offset - window.innerHeight / 2 });
    window.dispatchEvent(new Event("scroll"));
  }
}
