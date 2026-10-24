// Single egress module (ARCHITECTURE §9, SEC-080…088): the ONLY place that may call fetch towards the internet.
// Private Mode blocks everything (EM-8202); hosts must be on the allow-list (EM-8203); HTTPS only.
import { EmError } from '@expertmotion/shared';

export const PROVIDER_HOSTS = ['openrouter.ai', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'] as const;
export const MODEL_HOSTS = ['huggingface.co', 'cdn-lfs.huggingface.co', 'cas-bridge.xethub.hf.co', 'github.com', 'objects.githubusercontent.com'] as const;

export interface Egress { fetch: typeof fetch; isPrivate(): boolean }
export function createEgress(opts: { isPrivate: () => boolean; extraHosts?: () => string[]; impl?: typeof fetch }): Egress {
  const impl = opts.impl ?? globalThis.fetch;
  const guarded: typeof fetch = async (input, init) => {
    if (opts.isPrivate()) throw new EmError('EM-8202', 'Private Mode is on, so Expertmotion is not connecting to the internet.');
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== 'https:') throw new EmError('EM-8203', `Only HTTPS connections are allowed (${url.host}).`);
    const allowed = [...PROVIDER_HOSTS, ...MODEL_HOSTS, ...(opts.extraHosts?.() ?? [])];
    if (!allowed.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) throw new EmError('EM-8203', `Connections to ${url.hostname} are not allowed.`);
    return impl(input, init);
  };
  return { fetch: guarded, isPrivate: opts.isPrivate };
}
