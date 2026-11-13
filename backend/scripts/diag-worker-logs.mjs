// Read-only: the production Worker's own log lines that mention a needle (a
// scan job id, a route), from Cloudflare Workers Logs. Prints each line's time,
// level and message cut at 300 chars, with any model "Raw:" text dropped, since
// Actions logs are public.
//
// RE-RUN: Actions -> "Run a backend script on production" -> diag-worker-logs.mjs,
//   mode plan. Env: NEEDLE=<text>;HOURS=3. Writes nothing anywhere.
const NEEDLE = process.env.NEEDLE || '';
const HOURS = Math.max(1, Math.min(72, Number(process.env.HOURS || 3)));
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
if (!token || !account) { console.error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set'); process.exit(2); }
if (NEEDLE.length < 4) { console.error('set NEEDLE'); process.exit(1); }

const to = Date.now();
const from = to - HOURS * 3600_000;
const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    queryId: 'diag-worker-logs',
    timeframe: { from, to },
    view: 'events',
    limit: 200,
    parameters: { needle: { value: NEEDLE, isRegex: false, matchCase: false } },
  }),
});
const body = await res.json().catch(() => ({}));
console.log(`http=${res.status} success=${body.success}`);
if (!body.success) { console.log(JSON.stringify(body.errors ?? body).slice(0, 500)); process.exit(0); }
const events = body.result?.events?.events ?? [];
console.log(`events: ${events.length}`);
const clean = (s) => String(s ?? '').split(' Raw:')[0].replace(/\s+/g, ' ').slice(0, 300);
for (const e of events.reverse()) {
  const t = new Date(e.timestamp ?? e.$metadata?.timestamp ?? 0).toISOString();
  const m = e.$metadata ?? {};
  console.log(`${t} ${m.level ?? e.level ?? ''} ${clean(m.message ?? e.message ?? JSON.stringify(e.source ?? ''))}`);
}
