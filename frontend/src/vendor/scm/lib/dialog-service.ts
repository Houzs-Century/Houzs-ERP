
import type { NotifyOpts } from '../components/NotifyDialog';

export type ConfirmOpts = {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type ConfirmFn = (opts: ConfirmOpts) => Promise<boolean>;
type NotifyFn = (opts: NotifyOpts) => Promise<void>;

let liveConfirm: ConfirmFn | null = null;
let liveNotify: NotifyFn | null = null;

/** Called once by <DialogServiceBridge> (inside the providers) at app mount. */
export function registerDialogService(fns: { confirm: ConfirmFn; notify: NotifyFn }): void {
  liveConfirm = fns.confirm;
  liveNotify = fns.notify;
}

function flatten(title: string, body?: unknown): string {
  return [title, typeof body === 'string' ? body : ''].filter(Boolean).join('\n\n');
}

/** In-app confirm from non-React code. Falls back to window.confirm pre-mount. */
export function serviceConfirm(opts: ConfirmOpts): Promise<boolean> {
  if (liveConfirm) return liveConfirm(opts);
  return Promise.resolve(window.confirm(flatten(opts.title, opts.body)));
}

/** In-app alert from non-React code. Falls back to window.alert pre-mount. */
export function serviceNotify(opts: NotifyOpts): Promise<void> {
  if (liveNotify) return liveNotify(opts);
  window.alert(flatten(opts.title, opts.body));
  return Promise.resolve();
}
