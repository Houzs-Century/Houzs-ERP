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
