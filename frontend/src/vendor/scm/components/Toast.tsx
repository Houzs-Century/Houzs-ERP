// HOUZS VENDOR SHIM — Toast.
//
// 2990's Toast is a standalone <ToastProvider> + useToast() variant-toast stack
// (apps/backend/src/components/Toast.tsx). This shim maps the same `ToastApi`
// surface (toast() callable + .success/.error/.warning/.info/.push) onto Houzs's
// own non-blocking corner-toast stack (src/hooks/useToast.tsx), which is mounted
// once at the app root in main.tsx and therefore wraps every /scm/* page.
//
// History — this used to bridge onto useNotify (NotifyDialog): a full-screen
// modal with an OK button. That turned every fire-and-forget toast.success(...)
// into a BLOCKING dialog. On SO Maintenance the per-state warehouse <select>
// fires toast.success(`${state} → ${warehouse}`) on every change, so picking a
// warehouse popped a modal that stole focus (autoFocus OK) and interrupted bulk
// assignment — commander couldn't smoothly move to the next state. Routing the
// informational variants to the auto-dismissing corner toast removes the
// interruption while keeping the in-app (non-window.alert) surface. Genuine
// failures still surface via toast.error (a red corner toast) or, where the
// caller wants a hard stop, an explicit useNotify()/useConfirm() at the call
// site — those were left untouched.
//
// Only `useToast` is consumed by the vendored SO Maintenance page; the
// ToastProvider export is kept as a no-op pass-through in case a later page
// expects to wrap a subtree.

import type { ReactNode } from 'react';
import { useToast as useHouzsToast } from '../../../hooks/useToast';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  duration?: number;
}

type PushFn = (message: string, opts?: ToastOptions) => void;

export interface ToastApi extends PushFn {
  success: PushFn;
  error: PushFn;
  warning: PushFn;
  info: PushFn;
  push: PushFn;
}

/** Bridge the variant-toast API onto Houzs's non-blocking corner toast.
 *  Each variant maps 1:1; the bare callable and .push default to info. */
export const useToast = (): ToastApi => {
  const toast = useHouzsToast();
  const make = (variant: ToastVariant): PushFn => (message: string) => {
    toast[variant](message);
  };
  const api = make('info') as ToastApi;
  api.success = make('success');
  api.error = make('error');
  api.warning = make('warning');
  api.info = make('info');
  api.push = make('info');
  return api;
};

/** No-op provider — Houzs's ToastProvider (mounted at the app root) already
 *  supplies the toast surface, so this just renders its children. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
