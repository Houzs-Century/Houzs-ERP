// ----------------------------------------------------------------------------
// velocity-poll.ts — DEV-42: pull live lorry positions from Radius Velocity
// (Kinesis trackers) every 5 min and store them in scm.lorry_positions.
//
// Velocity gives live position only, no history, so the stored rows ARE the
// history. Read-only against Velocity. Auth (api-docs.velocityfleet.com,
// Authentication): POST the refresh token to /oauth2/refresh/ -> access token
// (30-day life) -> Bearer on every call.
//
// Secrets: VELOCITY_REFRESH_TOKEN (wrangler secret). VELOCITY_CUSTOMER_ID is the
// numeric key from GET /vapi/v1/accounts/users/customers, not the account number.
// Either unset -> no-op. Errors carry the HTTP status only, never a body: a body
// could echo the token into the logs.
// ----------------------------------------------------------------------------

import type { Env } from '../../types';
import { normalizePlate } from './plate-normalize';

const BASE = 'https://www.velocityfleet.com';

export type VelocityFix = {
  deviceId: string;
  plate: string; // normalized
  lat: number;
  lng: number;
  speedKmh: number | null;
  heading: number | null;
  ignition: boolean | null;
  street: string | null;
  recordedAt: string; // ISO
};

type RawDevice = {
  id?: unknown; vehicle_registration?: unknown; lat?: unknown; lon?: unknown;
  speed?: unknown; speed_measure_text?: unknown; direction?: unknown;
  ignition?: unknown; street?: unknown; town?: unknown; timestamp?: unknown;
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** PURE. Velocity live-positions body -> fixes. Drops devices with no plate, no position or no time. */
export function parseDevices(body: { devices?: RawDevice[] } | null | undefined): VelocityFix[] {
  const out: VelocityFix[] = [];
  for (const d of body?.devices ?? []) {
    const plate = normalizePlate(typeof d.vehicle_registration === 'string' ? d.vehicle_registration : null);
    const lat = num(d.lat), lng = num(d.lon), ts = num(d.timestamp);
    if (!plate || lat == null || lng == null || ts == null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const speed = num(d.speed);
    const mph = /mph/i.test(String(d.speed_measure_text ?? ''));
    out.push({
      deviceId: String(d.id ?? ''),
      plate,
      lat,
      lng,
      speedKmh: speed == null ? null : mph ? speed * 1.609344 : speed,
      heading: num(d.direction),
      ignition: d.ignition === 'Y' ? true : d.ignition === 'N' ? false : null,
      street: [d.street, d.town].filter((s) => typeof s === 'string' && s).join(', ') || null,
      recordedAt: new Date(ts * 1000).toISOString(),
    });
  }
  return out;
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`velocity ${init.method ?? 'GET'} ${path.split('?')[0]} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export async function pollVelocity(env: Env): Promise<{ skipped?: true; devices?: number; stored?: number; unmatched?: string[] }> {
  const refresh = env.VELOCITY_REFRESH_TOKEN;
  const customer = env.VELOCITY_CUSTOMER_ID;
  if (!refresh || !customer) return { skipped: true };

  // ponytail: a fresh access token every run (288/day). Cache it in KV if Velocity complains.
  const form = new FormData();
  form.append('token', refresh);
  const { token } = await call<{ token: string }>('/vapi/v1/accounts/users/oauth2/refresh/', { method: 'POST', body: form });

  const body = await call<{ devices?: RawDevice[] }>(
    `/api/mobile/kinesis/device-live-positions/?customer=${encodeURIComponent(customer)}&useUTC`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  const fixes = parseDevices(body);
  if (!fixes.length) return { devices: 0, stored: 0, unmatched: [] };

  const { results: lorries } = await env.DB
    .prepare('SELECT id, plate, company_id FROM scm.lorries')
    .all<{ id: string; plate: string; company_id: number }>();
  const byPlate = new Map(lorries.map((l) => [normalizePlate(l.plate), l]));

  let stored = 0;
  const unmatched: string[] = [];
  for (const f of fixes) {
    const lorry = byPlate.get(f.plate);
    if (!lorry) { unmatched.push(f.plate); continue; }
    const r = await env.DB
      .prepare(
        `INSERT INTO scm.lorry_positions
           (company_id, lorry_id, device_id, lat, lng, speed_kmh, heading, ignition, street, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (lorry_id, recorded_at) DO NOTHING`,
      )
      .bind(lorry.company_id, lorry.id, f.deviceId, f.lat, f.lng, f.speedKmh, f.heading, f.ignition, f.street, f.recordedAt)
      .run();
    stored += r.meta?.changes ?? 0;
  }
  return { devices: fixes.length, stored, unmatched };
}
