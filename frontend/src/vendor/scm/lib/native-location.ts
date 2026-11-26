
export type NativeFix = {
  latitude: number;
  longitude: number;
  accuracy: number;
  simulated: boolean;
  bearing: number | null;
  speed: number | null;
  time: number | null;
};

type WatcherOptions = {
  backgroundMessage?: string;
  backgroundTitle?: string;
  requestPermissions?: boolean;
  stale?: boolean;
  distanceFilter?: number;
};

type BackgroundGeolocationPlugin = {
  addWatcher(
    options: WatcherOptions,
    callback: (position?: NativeFix, error?: { code?: string; message?: string }) => void,
  ): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
};

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  Plugins?: { BackgroundGeolocation?: BackgroundGeolocationPlugin };
};

const cap = (): CapacitorGlobal | undefined =>
  (globalThis as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;

/** Are we running inside the app rather than a browser tab? Cheap, synchronous,
 *  and safe on the server (no `window` dereference). */
export function isNativeApp(): boolean {
  try {
    return cap()?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/** Is the background watcher actually available? Present in the app AND built
 *  with the plugin — an app shipped before the plugin landed answers false, so
 *  the web path stays the fallback rather than the tracking silently dying. */
export function hasBackgroundLocation(): boolean {
  return isNativeApp() && !!cap()?.Plugins?.BackgroundGeolocation;
}

export type NativeWatchHandle = { stop: () => void };

/**
 * Start a background watcher. Returns a handle whose `stop()` is safe to call
 * more than once and before the watcher has finished registering.
 *
 * `onFix` is called for every position; `onError` for a permission refusal or a
 * hardware failure. Neither throws — a tracking failure must never take down the
 * screen a driver is trying to work on.
 */
export function startBackgroundWatch(opts: {
  onFix: (fix: NativeFix) => void;
  onError?: (message: string) => void;
  distanceFilterM?: number;
}): NativeWatchHandle {
  const plugin = cap()?.Plugins?.BackgroundGeolocation;
  if (!plugin) return { stop: () => {} };

  let watcherId: string | null = null;
  let stopped = false;

  plugin
    .addWatcher(
      {
        backgroundMessage: 'Sharing your location with dispatch for this delivery run.',
        backgroundTitle: 'Delivery in progress',
        requestPermissions: true,
        stale: false,
        distanceFilter: opts.distanceFilterM ?? 30,
      },
      (position, error) => {
        if (stopped) return;
        if (error) {
          opts.onError?.(error.message || error.code || 'location error');
          return;
        }
        if (position) opts.onFix(position);
      },
    )
    .then((id) => {
      watcherId = id;
      if (stopped) void plugin.removeWatcher({ id }).catch(() => {});
    })
    .catch((e: unknown) => opts.onError?.(e instanceof Error ? e.message : 'could not start location'));

  return {
    stop: () => {
      stopped = true;
      if (watcherId) {
        const id = watcherId;
        watcherId = null;
        void plugin.removeWatcher({ id }).catch(() => {});
      }
    },
  };
}
