// Same-origin /api proxy to the Houzs ERP Worker — the POS calls /api/... on
// its own host and this Function forwards it, exactly as the ERP frontend's
// functions/api/[[path]].ts does. API_ORIGIN (a Pages env var) overrides the
// production Worker for a staging deploy.
interface PagesContext {
  request: Request;
  env: { API_ORIGIN?: string };
}

const DEFAULT_API_ORIGIN = "https://autocount-sync-api.houzs-erp.workers.dev";

export const onRequest = async ({ request, env }: PagesContext): Promise<Response> => {
  const url = new URL(request.url);
  const origin = env.API_ORIGIN || DEFAULT_API_ORIGIN;
  return fetch(`${origin}${url.pathname}${url.search}`, request);
};
