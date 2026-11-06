/* The pure rule behind the printer's self-healing: which write failure means
 * "the printer went away" (cable pulled, powered off, laptop slept), so the
 * POS re-binds the already-allowed device and retries once instead of
 * handing the cashier a WebUSB error. */
export const printerGone = (e: unknown): boolean =>
  /disconnected|not found|NetworkError|not opened|no device|device unavailable|transfer error|LIBUSB/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));
