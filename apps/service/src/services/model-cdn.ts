// Operator model CDN (Operator decision 2026-10-25: Cloudflare R2 bucket behind a custom domain; DEPLOYMENT_AND_PACKAGING.md §16,
// LOCAL_AI_MODELS.md §4.5, SEC-071/SEC-072). The base URL is injected at service build time: scripts/build.mjs defines
// __EM_MODEL_CDN_URL__ from EM_MODEL_CDN_URL (https only), or the placeholder below when the variable is unset.
// When a CDN is configured, Model Downloads and the signed manifest (`<cdn>/models.json` + `.sig`) come ONLY from that host:
// the Hugging Face / GitHub hosts of the built-in registry are dropped from the allow-list. Without it (placeholder, source runs
// without the variable) the built-in allow-list stays — development only; scripts/release-check.mjs refuses such a release.
import { allowedHosts } from '@expertmotion/models';

declare const __EM_MODEL_CDN_URL__: string | undefined;

/** The value scripts/build.mjs injects when EM_MODEL_CDN_URL is not set (an Operator item in release-check). */
export const MODEL_CDN_PLACEHOLDER = 'PLACEHOLDER_SET_EM_MODEL_CDN_URL';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Why `raw` cannot be the model CDN base URL, or null when it can (https, DNS host name, no credentials, query or fragment). */
export function modelCdnUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a URL'; }
  if (u.protocol !== 'https:') return 'only https:// is allowed';
  if (u.username || u.password) return 'credentials in the URL are not allowed';
  if (u.search || u.hash) return 'no query or fragment';
  if (u.port) return 'no explicit port';
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || IPV4.test(h) || h.startsWith('[')) return 'a public DNS host name is required';
  return null;
}

/** Normalised base URL (no trailing slash), or null for the placeholder, an empty value or an invalid URL. */
export function normalizeModelCdnUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v || v === MODEL_CDN_PLACEHOLDER || modelCdnUrlProblem(v) !== null) return null;
  const u = new URL(v);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

// Built bundles always carry the define (the placeholder at least), so the environment is read only on source runs (tsx dev, tests).
const injected = typeof __EM_MODEL_CDN_URL__ === 'string' ? __EM_MODEL_CDN_URL__ : process.env['EM_MODEL_CDN_URL'];
/** The Operator model CDN of this build, or null (development). */
export const MODEL_CDN_URL: string | null = normalizeModelCdnUrl(injected);

export const modelCdnHost = (base: string | null = MODEL_CDN_URL): string | null => (base ? new URL(base).hostname.toLowerCase() : null);

/** SEC-071 download-host allow-list: exactly the CDN host when configured, the built-in Hugging Face/GitHub list otherwise. */
export function modelDownloadHosts(base: string | null = MODEL_CDN_URL): string[] {
  const host = modelCdnHost(base);
  return host ? [host] : allowedHosts();
}

/** `<cdn>/models.json` and `<cdn>/models.json.sig`. */
export const manifestUrls = (base: string): { manifest: string; signature: string } => ({ manifest: `${base}/models.json`, signature: `${base}/models.json.sig` });
