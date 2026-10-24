/**
 * Development-mode rules (SECURITY.md SEC-014). A packaged build (`app.isPackaged === true`)
 * ignores every `EM_*` relaxation: no dev origin, no env token, no dev-token file. These helpers
 * are pure so the "packaged build ignores the variable" test runs on Linux.
 */
import { DEV_UI_PORT_DEFAULT } from './constants.js';

export interface Env {
  readonly [key: string]: string | undefined;
}

export interface DevRules {
  /** Whether the dev Vite origin is accepted as an extra CSP/IPC/Origin allow-list entry. */
  readonly allowDevOrigin: boolean;
  /** The dev origins (127.0.0.1 and localhost on the UI port), or empty in a packaged build. */
  readonly devOrigins: readonly string[];
  /** A fixed Service Token taken from EM_TOKEN, or null (generate one instead). */
  readonly devToken: string | null;
  /** Whether the Shell may write `<dataDir>/dev-token` for the Vite proxy (dev only). */
  readonly writeDevTokenFile: boolean;
}

function devUiPort(env: Env): number {
  const raw = env.EM_UI_PORT;
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEV_UI_PORT_DEFAULT;
}

/**
 * Resolves the dev relaxations. In a packaged build everything is off regardless of env;
 * the caller passes `isPackaged` from Electron's `app.isPackaged`.
 */
export function resolveDevRules(isPackaged: boolean, env: Env): DevRules {
  if (isPackaged) return { allowDevOrigin: false, devOrigins: [], devToken: null, writeDevTokenFile: false };
  const port = devUiPort(env);
  const explicit = env.EM_UI_ORIGIN;
  const origins = explicit !== undefined && explicit !== '' ? [explicit] : [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const token = env.EM_TOKEN !== undefined && env.EM_TOKEN !== '' ? env.EM_TOKEN : null;
  return { allowDevOrigin: true, devOrigins: origins, devToken: token, writeDevTokenFile: token === null };
}

/** The URL the Shell loads: the Vite dev server in development, the app:// scheme when packaged. */
export function editorEntryUrl(isPackaged: boolean, env: Env): string {
  if (isPackaged) return 'app://expertmotion/index.html';
  return `http://127.0.0.1:${devUiPort(env)}/`;
}
