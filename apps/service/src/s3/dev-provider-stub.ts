// Development-only provider stub (process.md Entry 28): with EM_DEV=1 (cfg.dev) and EM_DEV_PROVIDER_STUB=http://127.0.0.1:<port>,
// every provider call (OpenRouter, OpenAI, Anthropic, Gemini) is answered by a local stub server (poc/e2e/provider-stub.mjs)
// instead of the internet, so the Providers flow and both agents can be driven end to end without a real key or quota.
// The egress module still checks the ORIGINAL https URL against the allow-list (SEC-082) before this rewrite runs, so the
// stub never widens what the Service may reach. Release builds (`build.mjs --encrypt-prompts`) define
// `process.env.EM_DEV_PROVIDER_STUB` as undefined, so this is dead code there; a packaged Service has cfg.dev = false anyway.

/** Provider host → path prefix on the stub server. */
export const STUB_PREFIX: Readonly<Record<string, string>> = {
  'openrouter.ai': 'openrouter', 'api.openai.com': 'openai', 'api.anthropic.com': 'anthropic', 'generativelanguage.googleapis.com': 'gemini',
};

/** The stub origin when it is switched on (dev only, plain http on 127.0.0.1 with a port, nothing else), else null. */
export function devProviderStubOrigin(dev: boolean, raw: string | undefined = process.env.EM_DEV_PROVIDER_STUB): string | null {
  if (!dev || !raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
  const port = Number(u.port);
  if (port === 3000 || port === 4000) return null;                                     // never the other tenant's ports
  return u.origin;
}

/** Rewrites provider URLs to `<origin>/<prefix><path><query>`; every other URL passes through untouched. */
export function stubUrl(raw: string, origin: string): string {
  const u = new URL(raw);
  const prefix = u.protocol === 'https:' ? STUB_PREFIX[u.hostname.toLowerCase()] : undefined;
  return prefix ? `${origin}/${prefix}${u.pathname}${u.search}` : raw;
}

/** A fetch implementation for the egress module that sends provider calls to the stub. */
export function withDevProviderStub(impl: typeof fetch, origin: string): typeof fetch {
  return (input, init) => {
    if (typeof input === 'string' || input instanceof URL) return impl(stubUrl(String(input), origin), init);
    const next = stubUrl(input.url, origin);
    return next === input.url ? impl(input, init) : impl(new Request(next, input), init);
  };
}
