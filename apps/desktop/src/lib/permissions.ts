/**
 * Renderer permission policy (SECURITY.md SEC-029). Every permission is refused except the
 * Local Network Access family, and only for the Editor's own origin: the packaged Editor at
 * `app://expertmotion` calls the Local Service on `http://127.0.0.1:<port>`, which Chromium
 * treats as a request into the loopback address space and gates behind this permission.
 * Without it every API call fails and the Editor shows "local service is not responding".
 */
import { APP_ORIGIN } from './constants.js';

export const LOOPBACK_PERMISSIONS: ReadonlySet<string> = new Set(['local-network-access', 'local-network', 'loopback-network']);
/** Other permissions the Editor itself needs: the Player's fullscreen button. */
export const EDITOR_PERMISSIONS: ReadonlySet<string> = new Set(['fullscreen']);

/** `origin` may be a full URL (webContents URL) or an origin string; anything unparseable is refused. */
export function originOf(urlOrOrigin: string | undefined | null): string | null {
  if (!urlOrOrigin) return null;
  try {
    const u = new URL(urlOrOrigin);
    return u.protocol === 'app:' ? `app://${u.host}` : u.origin;
  } catch { return null; }
}

export function allowPermission(permission: string, requestingOrigin: string | undefined | null, opts: { devOrigins?: readonly string[] } = {}): boolean {
  if (!LOOPBACK_PERMISSIONS.has(permission) && !EDITOR_PERMISSIONS.has(permission)) return false;
  const origin = originOf(requestingOrigin);
  return origin === APP_ORIGIN || (origin !== null && (opts.devOrigins ?? []).includes(origin));
}
