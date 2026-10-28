// ---------------------------------------------------------------------------
// APNs sender — direct HTTP/2 to api.push.apple.com from the Worker.
//
// WHY NO LIBRARY. Every popular APNs package rides Node's http2 module, which
// does not exist in Workers. Apple's provider API is plain HTTPS + a JWT, and
// Cloudflare's fetch speaks HTTP/2 to origins that support it (APNs does), so
// a bare fetch is the whole client.
//
// SHIPS DARK, like RESEND_API_KEY: with the APNS_* secrets unset every send is
// a logged no-op that never throws. The secrets arrive only after the Apple
// Developer enrolment completes (docs/ios-app-store.md) — an APNs auth KEY
// (.p8), which unlike certificates does not expire:
//   APNS_TEAM_ID     — 10-char Apple Developer Team ID
//   APNS_KEY_ID      — 10-char key ID of the .p8
//   APNS_PRIVATE_KEY — the .p8 file's PEM contents (ES256 / P-256)
//   APNS_SANDBOX     — "1" to hit the sandbox gateway (TestFlight uses PROD)
//
// TOKEN CACHE. Apple rejects providers that mint a JWT per request (TooManyProviderTokenUpdates)
// AND tokens older than an hour. Cache in module scope for 45 minutes — module
// scope survives across requests within a Worker isolate, which is exactly the
// lifetime this needs; a cold isolate simply mints a fresh one.
// ---------------------------------------------------------------------------

import type { Env } from "../types";

const APNS_HOST_PROD = "https://api.push.apple.com";
const APNS_HOST_SANDBOX = "https://api.sandbox.push.apple.com";

/** The bundle id doubles as the APNs topic. One place, not three. */
export const APNS_TOPIC = "com.houzscentury.erp";

export function apnsConfigured(env: Env): boolean {
  return !!(env.APNS_TEAM_ID && env.APNS_KEY_ID && env.APNS_PRIVATE_KEY);
}

let cachedJwt: { token: string; mintedAt: number; keyId: string } | null = null;

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function providerJwt(env: Env): Promise<string> {
  const keyId = env.APNS_KEY_ID!;
  const now = Date.now();
  if (cachedJwt && cachedJwt.keyId === keyId && now - cachedJwt.mintedAt < 45 * 60 * 1000) {
    return cachedJwt.token;
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(env.APNS_PRIVATE_KEY!),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) }));
  const signingInput = `${header}.${claims}`;
  // WebCrypto ECDSA already returns the raw r||s form JWTs want (no DER step).
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const token = `${signingInput}.${b64url(sig)}`;
  cachedJwt = { token, mintedAt: now, keyId };
  return token;
}

export type PushResult =
  | { ok: true }
  | { ok: false; status: number; reason: string; tokenDead: boolean }
  | { ok: false; status: 0; reason: "not_configured" | "network"; tokenDead: false };

/**
 * Send one alert push to one device. Never throws.
 *
 * `tokenDead` is the caller's cue to disable the device row: Apple answered
 * 410 Unregistered, or 400 BadDeviceToken (a sandbox/prod-environment mismatch
 * reports as the latter).
 */
export async function sendApnsAlert(
  env: Env,
  deviceToken: string,
  alert: { title: string; body: string },
  opts?: { threadId?: string; badge?: number },
): Promise<PushResult> {
  if (!apnsConfigured(env)) {
    console.log("[apns] not configured — skipping send");
    return { ok: false, status: 0, reason: "not_configured", tokenDead: false };
  }
  try {
    const jwt = await providerJwt(env);
    const host = env.APNS_SANDBOX === "1" ? APNS_HOST_SANDBOX : APNS_HOST_PROD;
    const res = await fetch(`${host}/3/device/${deviceToken}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": APNS_TOPIC,
        "apns-push-type": "alert",
        "apns-priority": "10",
      },
      body: JSON.stringify({
        aps: {
          alert,
          sound: "default",
          ...(opts?.badge != null ? { badge: opts.badge } : {}),
          ...(opts?.threadId ? { "thread-id": opts.threadId } : {}),
        },
      }),
    });
    if (res.ok) return { ok: true };
    let reason = `http_${res.status}`;
    try {
      const body = (await res.json()) as { reason?: string };
      if (body?.reason) reason = body.reason;
    } catch {
      /* keep the status-based reason */
    }
    const tokenDead = res.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered";
    return { ok: false, status: res.status, reason, tokenDead };
  } catch (e) {
    console.error("[apns] send failed", e);
    return { ok: false, status: 0, reason: "network", tokenDead: false };
  }
}
