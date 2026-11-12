/* A device that lost its terminal: another device was set up on it, so the
 * ERP no longer knows this token. The sync engine asks for the terminal back
 * and a supervisor approves from another device or from POS Admin; nobody
 * at this device types anything (backend routes/lib/pos-reconnect.ts). */
import { ApiError } from "./api";

/** "no": connected. "waiting": asked, a supervisor has to approve.
 *  "not_eligible": the ERP will not take a request from this device, so it
 *  needs a pairing link from POS Admin > Terminals. */
export type LostTerminal = "no" | "waiting" | "not_eligible";

/** The ERP answered that this token belongs to no terminal. */
export function lostTerminal(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 401) return false;
  const body = e.body;
  return typeof body === "object" && body !== null && (body as { error?: unknown }).error === "device_not_registered";
}

/** A refusal of the request itself (not a network failure): no point asking again. */
export const requestRefused = (e: unknown): boolean => e instanceof ApiError && e.status >= 400 && e.status < 500;

/** What the cashier reads while the device is cut off. */
export function lostTerminalText(lost: LostTerminal, terminal: string): string | null {
  if (lost === "no") return null;
  const head = `This device is no longer connected as ${terminal}: another device was set up as ${terminal}. Selling still works and every bill is kept on this device.`;
  return lost === "waiting"
    ? `${head} A supervisor has been asked to reconnect it; there is nothing to type here.`
    : `${head} Ask the office for a pairing link (POS Admin, Terminals, Pair device) to reconnect it.`;
}
