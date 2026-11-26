
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
