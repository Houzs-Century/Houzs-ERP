import type {
  Env,
  ACSalesOrder,
  ACPurchaseOrder,
  ACPurchaseOrderDoc,
  ACSalesOrderDetail,
  ACDeliveryOrder,
} from "../types";

const AUTOCOUNT_WRITES_DISABLED = true;

function headers(env: Env, rid: string) {
  return {
    "X-API-KEY": env.AUTOCOUNT_API_KEY,
    "X-Request-ID": rid,
    "ngrok-skip-browser-warning": "true",
    "Content-Type": "application/json",
  };
}

/** How long a single-SO lookup may take before the caller goes on without it. */
export const GET_SINGLE_TIMEOUT_MS = 5_000;

export class AutoCountClient {
  constructor(private env: Env, private rid: string = crypto.randomUUID()) {}

  private url(path: string): string {
    return `${this.env.AUTOCOUNT_API_URL}${path}`;
  }

  async getSince(checkpoint: string): Promise<ACSalesOrder[]> {
    const res = await fetch(this.url(`/SalesOrder/getSince/${encodeURIComponent(checkpoint)}`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok) throw new Error(`getSince HTTP ${res.status}`);
    return (await res.json()) as ACSalesOrder[];
  }

  async getAll(): Promise<ACSalesOrder[]> {
    const res = await fetch(this.url(`/SalesOrder/getAll`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok) throw new Error(`getAll HTTP ${res.status}`);
    return (await res.json()) as ACSalesOrder[];
  }

  async getSingle(docNo: string): Promise<ACSalesOrder | null> {
    const res = await fetch(this.url(`/SalesOrder/getSingle/${encodeURIComponent(docNo)}`), {
      headers: headers(this.env, this.rid),
      signal: AbortSignal.timeout(GET_SINGLE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`getSingle HTTP ${res.status}`);
    const arr = (await res.json()) as ACSalesOrder[];
    return arr && arr.length > 0 ? arr[0] : null;
  }

  async getDetail(docNo: string): Promise<ACSalesOrderDetail[]> {
    const res = await fetch(this.url(`/SalesOrder/getDetail/${encodeURIComponent(docNo)}`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok) throw new Error(`getDetail HTTP ${res.status}`);
    return (await res.json()) as ACSalesOrderDetail[];
  }

  async fetchAllDeliveryOrders(): Promise<Response> {
    const res = await fetch(this.url(`/DeliveryOrder/getAll`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok || !res.body) throw new Error(`DeliveryOrder/getAll HTTP ${res.status}`);
    return res;
  }

  async getDeliveryOrdersSince(checkpoint: string): Promise<ACDeliveryOrder[] | null> {
    const res = await fetch(this.url(`/DeliveryOrder/getSince/${encodeURIComponent(checkpoint)}`), {
      headers: headers(this.env, this.rid),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`DeliveryOrder/getSince HTTP ${res.status}`);
    return (await res.json()) as ACDeliveryOrder[];
  }

  async getOverdue(): Promise<ACSalesOrder[]> {
    const res = await fetch(this.url(`/SalesOrder/getOverdue`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok) throw new Error(`getOverdue HTTP ${res.status}`);
    return (await res.json()) as ACSalesOrder[];
  }

  async pushSalesOrder(payload: {
    DocNo: string;
    Remark4: string | null;
    ExpiryDate: string | null;
  }): Promise<{ ok: boolean; status: number; body: string }> {
    const body = {
      DocNo: payload.DocNo,
      Remark4: payload.Remark4 ?? "",
      Attention: "SEAMPIFY",
      ExpiryDate: normalizeDate(payload.ExpiryDate),
    };
    if (AUTOCOUNT_WRITES_DISABLED) {
      console.warn(
        `[autocount][${this.rid}] WRITES DISABLED — skipping pushSalesOrder ${payload.DocNo}`,
        body
      );
      return { ok: true, status: 200, body: "skipped: AUTOCOUNT_WRITES_DISABLED" };
    }
    const res = await fetch(this.url(`/SalesOrder/updateFromSheet`), {
      method: "PUT",
      headers: headers(this.env, this.rid),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text };
  }

  async getOutstandingPOs(): Promise<ACPurchaseOrder[]> {
    const res = await fetch(this.url(`/PurchaseOrder/getOutstanding`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok) throw new Error(`getOutstandingPOs HTTP ${res.status}`);
    return (await res.json()) as ACPurchaseOrder[];
  }

  async getAllPODocs(): Promise<ACPurchaseOrderDoc[]> {
    const res = await fetch(this.url(`/PurchaseOrder/getAll`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok) throw new Error(`getAllPODocs HTTP ${res.status}`);
    return (await res.json()) as ACPurchaseOrderDoc[];
  }

  async getPODetail(docNo: string): Promise<Array<Record<string, any>>> {
    const res = await fetch(
      this.url(`/PurchaseOrder/getDetail/${encodeURIComponent(docNo)}`),
      { headers: headers(this.env, this.rid) }
    );
    if (!res.ok) throw new Error(`getPODetail HTTP ${res.status}`);
    return (await res.json()) as Array<Record<string, any>>;
  }

  async getAllCreditors(): Promise<Array<Record<string, any>>> {
    const res = await fetch(this.url(`/Creditor/getAll`), {
      headers: headers(this.env, this.rid),
    });
    if (!res.ok) throw new Error(`getAllCreditors HTTP ${res.status}`);
    return (await res.json()) as Array<Record<string, any>>;
  }

  async getSingleCreditor(code: string): Promise<Record<string, any> | null> {
    const res = await fetch(
      this.url(`/Creditor/getSingle/${encodeURIComponent(code)}`),
      { headers: headers(this.env, this.rid) }
    );
    if (!res.ok) throw new Error(`getSingleCreditor HTTP ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body)) return body.length > 0 ? body[0] : null;
    return body as Record<string, any>;
  }

  async getStockItem(itemCode: string): Promise<Record<string, any> | null> {
    const res = await fetch(
      this.url(`/StockItem/getSingle/${encodeURIComponent(itemCode)}`),
      { headers: headers(this.env, this.rid) }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getStockItem HTTP ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body)) return body.length > 0 ? body[0] : null;
    return body as Record<string, any>;
  }

  async pushPODates(payload: {
    docNo: string;
    date1: string | null;
    date2: string | null;
    date3: string | null;
  }): Promise<{ ok: boolean; status: number; body: string }> {
    const body = {
      docNo: payload.docNo,
      POUDF_EDate: normalizeDate(payload.date1),
      POUDF_EDate2: normalizeDate(payload.date2),
      POUDF_EDate3: normalizeDate(payload.date3),
    };
    if (AUTOCOUNT_WRITES_DISABLED) {
      console.warn(
        `[autocount][${this.rid}] WRITES DISABLED — skipping pushPODates ${payload.docNo}`,
        body
      );
      return { ok: true, status: 200, body: "skipped: AUTOCOUNT_WRITES_DISABLED" };
    }
    const res = await fetch(this.url(`/PurchaseOrder/update-udf-dates`), {
      method: "PUT",
      headers: headers(this.env, this.rid),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text };
  }
}

/**
 * Public read-only check — exposed so other modules (status endpoints,
 * UI banners) can detect the kill switch state without poking at the
 * private constant. Returns true when outbound writes are halted.
 */
export function isAutoCountWritesDisabled(): boolean {
  return AUTOCOUNT_WRITES_DISABLED;
}

/**
 * Inbound-sync kill switch. When AUTOCOUNT_SYNC_DISABLED="true" (wrangler.toml
 * [vars]), every AutoCount PULL is skipped — the cron handler and the manual
 * /api/sync routes check this so no data is fetched from AutoCount. Non-AutoCount
 * cron work (ASSR alerts, SLA, reminders, points) keeps running. Env-driven so
 * it flips with a one-line var change + deploy, no code edit. Set 2026-06-13 at
 * the owner's request ("暂时关闭, 不需要数据进来"); flip the var to re-enable.
 */
export function isAutoCountSyncDisabled(env: {
  AUTOCOUNT_SYNC_DISABLED?: string;
}): boolean {
  return env.AUTOCOUNT_SYNC_DISABLED === "true";
}

function normalizeDate(d: string | null | undefined): string | null {
  if (!d) return null;
  return d.replace(/\//g, "-");
}

export function cleanPhone(p: string | null | undefined): string {
  if (!p) return "";
  return String(p).replace(/[+&\- ]/g, "");
}

export function dateOnly(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.split("T")[0];
}

export function routeRegion(o: ACSalesOrder): "WEST" | "EAST" | "SG" | null {
  const addr = (o.InvAddr3 || "").toUpperCase();
  const loc = (o.SalesLocation || "").toUpperCase();
  if (addr.includes("SINGAPORE")) return "SG";
  // HQ = the Balakong head office — 2023-era SOs carry it instead of a
  // branch code (owner sighting 2026-07-23: SO-000186, Kedah address,
  // rejected by the manual pull as "isn't a West/East-Malaysia/SG order").
  if (loc === "KL" || loc === "PG" || loc === "HQ") return "WEST";
  if (loc === "SBH" || loc === "SRW") return "EAST";
  return null;
}
