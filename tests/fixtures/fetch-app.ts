// A fetch-handler app for bundleFetchHandler: a dependency-free router that
// uses import.meta (defined away by the bundle) and the Web APIs a real app
// would.
const base = new URL("./", import.meta.url).protocol;

export default {
  async fetch(request: Request, env: { greeting: string }) {
    const url = new URL(request.url);
    if (url.pathname === "/hello")
      return Response.json({ base, greeting: env.greeting });
    return new Response("not found", { status: 404 });
  },
};
