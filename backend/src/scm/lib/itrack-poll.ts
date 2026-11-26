// ----------------------------------------------------------------------------
// itrack-poll.ts — HC-0050 / DEV-42: pull live lorry positions from iTrack
// (itrack.top Open API) every 5 min into scm.lorry_positions, beside Velocity.
// iTrack is meant to replace Velocity; until Velocity is cancelled both run.
// Turning Velocity off later = unset VELOCITY_REFRESH_TOKEN, no code change.
//
// Auth (itrack.top/api.jsp 2.1): GET /api/authorization with
// signature = md5(md5(password) + unixTime) -> access token (2 h, cached 80 min
// in SESSION_CACHE). A new token kills the previous one, so nothing else may log
// in to the API with this account. Then /api/device/list (imei -> plate) and /api/track (live fix).
// The API answers on plain HTTP only (HTTPS does not connect, 16 Nov 2026).
//
// Secrets: ITRACK_ACCOUNT, ITRACK_PASSWORD. Either unset -> no-op. Errors carry
// the iTrack code only, never a body or URL: the URL holds the token.
// ----------------------------------------------------------------------------

import { md5 as md5Bytes } from '../../acc/settlement-pdf';
import type { Env } from '../../types';
import { normalizePlate } from './plate-normalize';
import { storeFixes, type VelocityFix } from './velocity-poll';

const BASE = 'http://api.itrack.top';

const md5 = (s: string) => [...md5Bytes(new TextEncoder().encode(s))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const itrackSignature = (password: string, time: number) => md5(md5(password) + time);

type RawTrack = {
  imei?: unknown; latitude?: unknown; longitude?: unknown; speed?: unknown;
  course?: unknown; accstatus?: unknown; gpstime?: unknown; datastatus?: unknown;
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

type RawDevice = { imei?: unknown; platenumber?: unknown; devicename?: unknown };

/** PURE. The device's plate field, or its name when the plate is blank (Houzs's iTrack devices carry the plate only in the name, 18 Nov 2026). A name that is not an ERP plate stays unmatched and is logged. */
export function devicePlate(d: RawDevice): string {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return str(d.platenumber) || str(d.devicename);
}

/** PURE. /api/track body + imei->plate (from /api/device/list) -> fixes. Devices with no plate on iTrack are returned in noPlate. */
export function parseTrack(
  body: { record?: RawTrack[] } | null | undefined,
  plateByImei: Map<string, string>,
): { fixes: VelocityFix[]; noPlate: string[] } {
  const fixes: VelocityFix[] = [];
  const noPlate: string[] = [];
  for (const d of body?.record ?? []) {
    const imei = String(d.imei ?? '');
    const lat = num(d.latitude), lng = num(d.longitude), ts = num(d.gpstime);
    if (d.datastatus === 1 || lat == null || lng == null || !ts) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const plate = normalizePlate(plateByImei.get(imei) ?? null);
    if (!plate) { noPlate.push(imei); continue; }
    fixes.push({
      deviceId: `itrack:${imei}`,
      plate,
      lat,
      lng,
      speedKmh: num(d.speed),
      heading: num(d.course),
      ignition: d.accstatus === 1 ? true : d.accstatus === 0 ? false : null,
      street: null,
      recordedAt: new Date(ts * 1000).toISOString(),
    });
  }
  return { fixes, noPlate };
}

async function call<T>(path: string, query: Record<string, string>): Promise<T> {
  const res = await fetch(`${BASE}${path}?${new URLSearchParams(query)}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`itrack ${path} -> HTTP ${res.status}`);
  const body = (await res.json()) as T & { code?: number };
  if (Number(body.code) !== 0) throw new Error(`itrack ${path} -> code ${body.code}`);
  return body;
}

const TOKEN_KEY = 'itrack:access_token';

async function accessToken(env: Env, account: string, password: string): Promise<string> {
  const cached = await env.SESSION_CACHE?.get(TOKEN_KEY);
  if (cached) return cached;
  const time = Math.floor(Date.now() / 1000);
  const auth = await call<{ record: { access_token: string } }>('/api/authorization', {
    time: String(time), account, signature: itrackSignature(password, time),
  });
  await env.SESSION_CACHE?.put(TOKEN_KEY, auth.record.access_token, { expirationTtl: 80 * 60 });
  return auth.record.access_token;
}

export async function pollItrack(env: Env): Promise<{ skipped?: true; devices?: number; stored?: number; unmatched?: string[]; noPlate?: string[] }> {
  const account = env.ITRACK_ACCOUNT;
  const password = env.ITRACK_PASSWORD;
  if (!account || !password) return { skipped: true };

  const access_token = await accessToken(env, account, password);

  const fixes: VelocityFix[] = [];
  const noPlate: string[] = [];
  try {
    const list = await call<{ record?: RawDevice[] }>('/api/device/list', { access_token });
    const plateByImei = new Map((list.record ?? []).map((d) => [String(d.imei ?? ''), devicePlate(d)]));
    const imeis = [...plateByImei.keys()].filter(Boolean);
    for (let i = 0; i < imeis.length; i += 100) {
      const track = await call<{ record?: RawTrack[] }>('/api/track', { access_token, imeis: imeis.slice(i, i + 100).join(',') });
      const r = parseTrack(track, plateByImei);
      fixes.push(...r.fixes);
      noPlate.push(...r.noPlate);
    }
  } catch (e) {
    await env.SESSION_CACHE?.delete(TOKEN_KEY);
    throw e;
  }
  return { ...(await storeFixes(env, fixes)), noPlate };
}
