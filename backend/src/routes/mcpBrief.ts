import { Hono } from "hono";
import type { Env } from "../types";
import { escapeHtml } from "../services/mcp-proactive";
import { unsubscribeByToken } from "../services/mcp-proactive-run";

/**
 * /api/mcp/brief — the public one-click unsubscribe for the AI Connector brief
 * and alert emails (mounted under routes/mcp.ts, above the auth gate). GET shows
 * one button, so a mail scanner opening the link changes nothing; POST (the
 * button, or a mail app's RFC 8058 List-Unsubscribe-Post) switches both off.
 */
export const mcpBriefPublic = new Hono<{ Bindings: Env }>();

const page = (title: string, body: string, status: 200 | 404 = 200): Response =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;background:#f3f4f6;margin:0;padding:32px 16px"><div style="max-width:440px;margin:0 auto;background:#fff;border-radius:8px;padding:24px">${body}</div></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      },
    },
  );

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

mcpBriefPublic.get("/unsubscribe/:token", (c) => {
  const token = c.req.param("token");
  if (!TOKEN_RE.test(token)) return page("Link not valid", "<h2>This unsubscribe link is not valid.</h2><p>Change your email settings on System &gt; AI Connector in the ERP.</p>", 404);
  return page(
    "Unsubscribe",
    `<h2 style="margin-top:0">Stop the ERP brief and alert emails?</h2><p style="color:#4b5563">You can switch them on again any time on System &gt; AI Connector.</p>
<form method="post" action="${escapeHtml(token)}"><button type="submit" style="background:#111827;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:15px;cursor:pointer">Unsubscribe</button></form>`,
  );
});

mcpBriefPublic.post("/unsubscribe/:token", async (c) => {
  const token = c.req.param("token");
  const ok = TOKEN_RE.test(token) && (await unsubscribeByToken(c.env.DB, token));
  if (!ok) return page("Link not valid", "<h2>This unsubscribe link is not valid.</h2><p>Change your email settings on System &gt; AI Connector in the ERP.</p>", 404);
  return page("Unsubscribed", "<h2 style=\"margin-top:0\">You are unsubscribed.</h2><p style=\"color:#4b5563\">No more brief or alert emails. Switch them on again on System &gt; AI Connector.</p>");
});
