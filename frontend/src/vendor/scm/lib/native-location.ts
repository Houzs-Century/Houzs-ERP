// ---------------------------------------------------------------------------
// Background location, for the native app only.
//
// WHY THIS EXISTS. `useTripLocationCapture` says it plainly in its own comment:
// tracking "STOPS when ... the page is backgrounded/hidden". That is not a bug
// in the hook — no mobile browser can watch position with the screen locked. So
// a driver who pockets their phone between drops disappears from the map, and
// the customer-facing "where is my delivery" question cannot be answered
// honestly. Closing that hole is the reason the native app exists.
//
// WHY THERE IS NO npm DEPENDENCY HERE. The plugin lives in `native/`, not in
// `frontend/package.json`, and that separation is deliberate — the SPA's
// bundle-size gate is already at its ceiling on main and desktop browsers must
// not carry a phone-only capability. A Capacitor plugin's JS wrapper is a thin
// shim over `window.Capacitor.Plugins.<Name>`, so calling that directly costs
// ZERO bytes in the web bundle and behaves identically inside the app.
//
// The types below are a hand-written mirror of the plugin's `definitions.d.ts`
// (@capacitor-community/background-geolocation). They are narrowed to what this
// file uses; a field the plugin adds later is simply not read.
// ---------------------------------------------------------------------------

export type NativeFix = {
  latitude: number;
  longitude: number;
  /** Horizontal uncertainty in metres, 68% confidence. */
  accuracy: number;
  /** TRUE when the position came from a mock-location app rather than GPS. */
  simulated: boolean;
  bearing: number | null;
  speed: number | null;
  /** Device clock, ms since epoch. */
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
  /** Metres of movement before a new fix is delivered. A stationary lorry should
   *  not fill the table with identical rows, and the battery cost of a fix every
   *  few seconds is the top reason drivers disable tracking. */
  distanceFilterM?: number;
}): NativeWatchHandle {
  const plugin = cap()?.Plugins?.BackgroundGeolocation;
  if (!plugin) return { stop: () => {} };

  let watcherId: string | null = null;
  let stopped = false;

  plugin
    .addWatcher(
      {
        /* Supplying backgroundMessage is what makes this a BACKGROUND watcher on
           both platforms — without it the plugin only guarantees foreground
           updates, which is the behaviour we already have and are replacing.
           On Android it is also the text of the mandatory ongoing notification;
           on iOS it is unused, but omitting it changes the semantics. */
        backgroundMessage: 'Sharing your location with dispatch for this delivery run.',
        backgroundTitle: 'Delivery in progress',
        requestPermissions: true,
        /* A stale fix delivered while the GPS is still settling would post a
           position the lorry has already left, and the customer page would show
           it as current. */
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
      // Stopped while the watcher was still registering — tear it down now, or
      // it outlives the trip and keeps draining the battery.
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
