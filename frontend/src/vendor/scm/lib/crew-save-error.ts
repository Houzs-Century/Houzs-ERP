type Notify = (opts: { title: string; body: string; tone: 'error' }) => unknown;

export function crewSaveFailed(notify: Notify, revert: (() => void) | undefined, error: unknown): void {
  revert?.();
  void notify({ title: 'Crew not saved', body: error instanceof Error && error.message ? error.message : 'Something went wrong.', tone: 'error' });
}
