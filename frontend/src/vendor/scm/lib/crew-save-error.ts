// What a Delivery Planning crew pick does when its save is refused: put the picker
// back to the saved value and say why. Before this an SO row's refused save
// vanished silently, the picker kept the pick until the next poll blanked it, and
// staff read that as "filled the driver, it went missing" (2026-11-10).
type Notify = (opts: { title: string; body: string; tone: 'error' }) => unknown;

export function crewSaveFailed(notify: Notify, revert: (() => void) | undefined, error: unknown): void {
  revert?.();
  void notify({ title: 'Crew not saved', body: error instanceof Error && error.message ? error.message : 'Something went wrong.', tone: 'error' });
}
