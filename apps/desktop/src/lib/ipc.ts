/**
 * IPC sender validation (SECURITY.md SEC-030): every handler checks that the message comes
 * from the main frame of the Editor window, whose URL is on the `app://expertmotion/` origin
 * (or the dev Vite origin when not packaged). Pure predicate: the caller passes the frame facts.
 */
import { APP_ORIGIN } from './constants.js';

export interface SenderFacts {
  /** The frame's URL, e.g. `app://expertmotion/index.html`. */
  url: string;
  /** Whether this is the window's top/main frame (not an iframe). */
  isMainFrame: boolean;
}

export interface SenderPolicy {
  /** Extra origins accepted only in development (SEC-014), e.g. `http://127.0.0.1:4120`. */
  devOrigins?: readonly string[];
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    // app:// is an opaque origin in WHATWG terms; compare scheme+host explicitly.
    if (u.protocol === 'app:') return `app://${u.hostname}`;
    return u.origin;
  } catch {
    return null;
  }
}

/** True when the sender is the Editor's main frame on an allowed origin. */
export function isTrustedSender(sender: SenderFacts, policy: SenderPolicy = {}): boolean {
  if (!sender.isMainFrame) return false;
  const origin = originOf(sender.url);
  if (origin === null) return false;
  if (origin === APP_ORIGIN) return true;
  return (policy.devOrigins ?? []).includes(origin);
}
