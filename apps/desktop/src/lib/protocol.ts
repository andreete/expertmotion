/**
 * Path resolution for the `app://expertmotion/` protocol handler (SECURITY.md SEC-025).
 * The handler maps a request URL to a file inside the Editor directory (apps/ui/dist) with a
 * prefix check: anything resolving outside that root, or using `..`, is refused (→ 404).
 * Pure: path math only, no filesystem and no `electron` import.
 */
import { posix } from 'node:path';

export interface ResolveOptions {
  /** Absolute root of the built Editor (the directory that holds index.html). */
  root: string;
  /** The request URL, e.g. `app://expertmotion/assets/app-ab12.js`. */
  url: string;
  /** SPA fallback file served when the path has no extension (client-side routing). */
  indexFile?: string;
  /** Path separator of the target platform; '\\' on Windows. Defaults to POSIX '/'. */
  sep?: string;
}

export type ResolveResult = { ok: true; absolutePath: string; relativePath: string } | { ok: false; reason: 'bad-url' | 'traversal' | 'bad-host' };

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Resolves a request path to an absolute file path under `root`, or rejects it.
 * The host must be exactly `expertmotion`; the pathname is normalised with POSIX semantics,
 * then joined to the root; the result must remain within the root (SEC-025, SEC-010 prefix check).
 */
export function resolveAppUrl(opts: ResolveOptions): ResolveResult {
  const indexFile = opts.indexFile ?? 'index.html';
  const sep = opts.sep ?? '/';
  let parsed: URL;
  try {
    parsed = new URL(opts.url);
  } catch {
    return { ok: false, reason: 'bad-url' };
  }
  if (parsed.protocol !== 'app:') return { ok: false, reason: 'bad-url' };
  if (parsed.hostname !== 'expertmotion') return { ok: false, reason: 'bad-host' };

  const raw = parsed.pathname === '/' || parsed.pathname === '' ? `/${indexFile}` : parsed.pathname;
  const decoded = decode(raw);
  if (decoded === null || decoded.includes('\0')) return { ok: false, reason: 'bad-url' };

  // Reject any backslash before normalisation so `\..\` cannot smuggle a traversal on Windows.
  if (decoded.includes('\\')) return { ok: false, reason: 'traversal' };

  // Normalise with a leading slash so posix.normalize cannot climb above the root.
  const normalised = posix.normalize(decoded);
  if (normalised.startsWith('../') || normalised === '..' || normalised.includes('/../')) {
    return { ok: false, reason: 'traversal' };
  }

  // SPA fallback: a path with no file extension serves index.html.
  const last = normalised.split('/').pop() ?? '';
  const relPosix = (last.includes('.') ? normalised : `/${indexFile}`).replace(/^\/+/, '');
  if (relPosix === '' || relPosix.startsWith('..')) return { ok: false, reason: 'traversal' };

  const relNative = sep === '/' ? relPosix : relPosix.split('/').join(sep);
  const rootNorm = opts.root.endsWith(sep) ? opts.root.slice(0, -sep.length) : opts.root;
  const absolutePath = `${rootNorm}${sep}${relNative}`;

  // Final guard: the absolute path must start with the root + separator (SEC-025).
  if (!absolutePath.startsWith(`${rootNorm}${sep}`)) return { ok: false, reason: 'traversal' };
  return { ok: true, absolutePath, relativePath: relPosix };
}
