/* The thermal printer over Web Bluetooth or WebUSB (ESC/POS). One-time
 * "Connect printer" asks the browser's Allow dialog; the choice is kept by
 * the browser, and the app reconnects to the last device on its own. If
 * printing fails the sale is already saved and the sell screen offers Skip
 * print / Reconnect / Retry (P14). */
type BtDevice = { id: string; name?: string; gatt?: { connected: boolean; connect(): Promise<unknown>; disconnect(): void; getPrimaryServices(): Promise<{ uuid: string; getCharacteristics(): Promise<{ uuid: string; properties: { write?: boolean; writeWithoutResponse?: boolean }; writeValueWithoutResponse?(v: BufferSource): Promise<void>; writeValueWithResponse?(v: BufferSource): Promise<void>; writeValue(v: BufferSource): Promise<void> }[]> }[]> }; addEventListener(ev: string, fn: () => void): void };
type Bluetooth = { requestDevice(o: unknown): Promise<BtDevice>; getDevices?(): Promise<BtDevice[]> };
type UsbDevice = { productName?: string; manufacturerName?: string; opened: boolean; configuration: { interfaces: { interfaceNumber: number; alternate: { interfaceClass: number; endpoints: { direction: string; endpointNumber: number; type: string }[] } }[] } | null; open(): Promise<void>; selectConfiguration(n: number): Promise<void>; claimInterface(n: number): Promise<void>; transferOut(ep: number, data: BufferSource): Promise<unknown>; close(): Promise<void> };
type Usb = { requestDevice(o: unknown): Promise<UsbDevice>; getDevices(): Promise<UsbDevice[]> };

const nav = navigator as Navigator & { bluetooth?: Bluetooth; usb?: Usb };

export type PrinterStatus = { connected: boolean; name: string | null; transport: "BLUETOOTH" | "USB" | null; error: string | null };

const SERIAL_SERVICES = ["000018f0-0000-1000-8000-00805f9b34fb", "0000ff00-0000-1000-8000-00805f9b34fb", "e7810a71-73ae-499d-8c15-faa9aef0c3f2", "49535343-fe7d-4ae5-8fa9-9fafd205e455"];

let bt: BtDevice | null = null;
let btChar: { write(v: BufferSource): Promise<void> } | null = null;
let usb: UsbDevice | null = null;
let usbEp: number | null = null;
let status: PrinterStatus = { connected: false, name: null, transport: null, error: null };
const listeners = new Set<(s: PrinterStatus) => void>();

export function onPrinterStatus(fn: (s: PrinterStatus) => void): () => void {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}
function setStatus(s: Partial<PrinterStatus>) {
  status = { ...status, ...s };
  for (const fn of listeners) fn(status);
}
export const printerStatus = (): PrinterStatus => status;
export const printerSupported = (): { bluetooth: boolean; usb: boolean } => ({ bluetooth: !!nav.bluetooth, usb: !!nav.usb });

async function bindBt(device: BtDevice): Promise<void> {
  if (!device.gatt) throw new Error("No GATT on this device");
  if (!device.gatt.connected) await device.gatt.connect();
  const services = await device.gatt.getPrimaryServices();
  for (const svc of services) {
    const chars = await svc.getCharacteristics();
    const c = chars.find((x) => x.properties.writeWithoutResponse || x.properties.write);
    if (c) {
      btChar = { write: (v) => (c.properties.writeWithoutResponse && c.writeValueWithoutResponse ? c.writeValueWithoutResponse(v) : c.writeValue(v)) };
      bt = device;
      device.addEventListener("gattserverdisconnected", () => { btChar = null; setStatus({ connected: false, error: "Printer disconnected" }); });
      setStatus({ connected: true, name: device.name ?? "Bluetooth printer", transport: "BLUETOOTH", error: null });
      return;
    }
  }
  throw new Error("No writable characteristic on this printer");
}

async function bindUsb(device: UsbDevice): Promise<void> {
  if (!device.opened) await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  const iface = device.configuration?.interfaces.find((i) => i.alternate.interfaceClass === 7) ?? device.configuration?.interfaces[0];
  if (!iface) throw new Error("No interface on this printer");
  await device.claimInterface(iface.interfaceNumber);
  const ep = iface.alternate.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
  if (!ep) throw new Error("No OUT endpoint on this printer");
  usb = device;
  usbEp = ep.endpointNumber;
  setStatus({ connected: true, name: device.productName ?? "USB printer", transport: "USB", error: null });
}

/** The one-time Allow dialog (Web Bluetooth or WebUSB). */
export async function connectPrinter(kind: "BLUETOOTH" | "USB"): Promise<PrinterStatus> {
  try {
    if (kind === "BLUETOOTH") {
      if (!nav.bluetooth) throw new Error("Web Bluetooth is not available in this browser");
      const device = await nav.bluetooth.requestDevice({ filters: SERIAL_SERVICES.map((s) => ({ services: [s] })), optionalServices: SERIAL_SERVICES });
      await bindBt(device);
    } else {
      if (!nav.usb) throw new Error("WebUSB is not available in this browser");
      const device = await nav.usb.requestDevice({ filters: [{ classCode: 7 }] });
      await bindUsb(device);
    }
  } catch (e) {
    setStatus({ connected: false, error: e instanceof Error ? e.message : String(e) });
  }
  return status;
}

/** Reconnect to the device the browser already allowed, silently. */
export async function reconnectPrinter(): Promise<PrinterStatus> {
  try {
    if (nav.usb) {
      const devices = await nav.usb.getDevices();
      const d = devices[0];
      if (d) { await bindUsb(d); return status; }
    }
    if (nav.bluetooth?.getDevices) {
      const devices = await nav.bluetooth.getDevices();
      const d = devices[0];
      if (d) { await bindBt(d); return status; }
    }
    setStatus({ connected: false, error: null });
  } catch (e) {
    setStatus({ connected: false, error: e instanceof Error ? e.message : String(e) });
  }
  return status;
}

/** Send bytes in chunks (Bluetooth MTU is small). */
export async function printBytes(bytes: Uint8Array): Promise<void> {
  if (btChar) {
    const CHUNK = 100;
    for (let i = 0; i < bytes.length; i += CHUNK) await btChar.write(bytes.slice(i, i + CHUNK));
    return;
  }
  if (usb && usbEp != null) {
    const CHUNK = 4096;
    for (let i = 0; i < bytes.length; i += CHUNK) await usb.transferOut(usbEp, bytes.slice(i, i + CHUNK));
    return;
  }
  throw new Error("No printer connected");
}
