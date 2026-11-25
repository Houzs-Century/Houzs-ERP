// AI Connector (MCP) OAuth discovery at the site root: AI apps look for
// /.well-known/oauth-authorization-server here, at the address the person typed. Forwarded to the
// Worker (backend routes/mcp.ts mcpWellKnown) with the host it was asked on.
interface PagesContext {
  request: Request;
  env: { API_ORIGIN?: string };
}

const DEFAULT_API_ORIGIN = "https://autocount-sync-api.houzs-erp.workers.dev";

export const onRequest = async ({ request, env }: PagesContext): Promise<Response> => {
  const url = new URL(request.url);
  const fwd = new Request(`${env.API_ORIGIN || DEFAULT_API_ORIGIN}${url.pathname}`, { method: "GET", headers: { accept: "application/json", "X-Forwarded-Host": url.host } });
  return fetch(fwd);
};
