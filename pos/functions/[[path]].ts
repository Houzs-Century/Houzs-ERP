// SPA fallback: a navigation to any path that is not a built file gets the
// app shell. Real-looking file paths that do not exist stay 404 so a broken
// asset never renders the shell. Dependency-free on purpose.
interface PagesContext {
  request: Request;
  env: { ASSETS: { fetch: (request: Request | string | URL) => Promise<Response> } };
  next: () => Promise<Response>;
}

export const onRequest = async ({ request, env, next }: PagesContext): Promise<Response> => {
  const url = new URL(request.url);
  if (request.method !== "GET" || /\.[a-z0-9]+$/i.test(url.pathname) || url.pathname.startsWith("/api/")) return next();
  const res = await next();
  if (res.status !== 404) return res;
  return env.ASSETS.fetch(new URL("/", request.url));
};
