// Throwaway test worker — DOES NOT TOUCH PROD. Proves whether a Cloudflare
// Worker (workerd, the same engine wrangler dev runs) can connect DIRECTLY to
// the Supabase 6543 transaction pooler with postgres.js — and whether it holds
// up under concurrency. If yes, "direct -> 6543, no Hyperdrive" is a viable
// root fix for the cold-start. If postgres.js can't open the TLS socket in
// workerd, this fails fast and rules the path out.
import postgres from "postgres";

export default {
  async fetch(request, env) {
    const t0 = Date.now();
    let sql;
    try {
      sql = postgres(env.DATABASE_URL, {
        prepare: false,
        max: 1,
        ssl: "require",
        idle_timeout: 4,
        connect_timeout: 12,
        fetch_types: false,
      });
      const rows = await sql`SELECT 1 AS ok`;
      return new Response(
        JSON.stringify({ ok: rows[0]?.ok ?? null, ms: Date.now() - t0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (e) {
      return new Response(
        JSON.stringify({ err: String(e?.message || e).slice(0, 200), ms: Date.now() - t0 }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    } finally {
      try { sql && (await sql.end({ timeout: 4 })); } catch {}
    }
  },
};
