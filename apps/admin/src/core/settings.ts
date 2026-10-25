/** Operator settings, stored as JSON in the app's userData folder. Never holds a passphrase or a seed. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type NetworkPolicy = 'strict' | 'warn';

export interface KnownKey {
  kid: string;
  publicKeyHex: string;
  file: string;
}

export interface Settings {
  workspaceDir: string;
  /** strict = the CLI's rule (no signing while a network interface is up); warn = banner only */
  networkPolicy: NetworkPolicy;
  signature: string;
  lang: 'en' | 'id';
  /** public halves of the key files opened or created here, for Verify while locked */
  knownKeys: KnownKey[];
  lastKeyFile: string | null;
}

export function defaultSettings(workspaceDir: string): Settings {
  return { workspaceDir, networkPolicy: 'strict', signature: 'Expertmotion Support', lang: 'en', knownKeys: [], lastKeyFile: null };
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** Load and sanitise; a missing or corrupt file yields the defaults. */
export function loadSettings(file: string, workspaceDir: string): Settings {
  const d = defaultSettings(workspaceDir);
  if (!existsSync(file)) return d;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return d;
  }
  const keys = Array.isArray(raw.knownKeys) ? raw.knownKeys : [];
  return {
    workspaceDir: str(raw.workspaceDir, 4096) && path.isAbsolute(raw.workspaceDir) ? raw.workspaceDir : d.workspaceDir,
    networkPolicy: raw.networkPolicy === 'warn' ? 'warn' : 'strict',
    signature: str(raw.signature, 200) ? raw.signature : d.signature,
    lang: raw.lang === 'id' ? 'id' : 'en',
    knownKeys: keys
      .filter((k): k is KnownKey => {
        const o = k as Record<string, unknown>;
        return !!k && typeof k === 'object' && str(o.kid, 2) && /^[A-Z0-9]{2}$/.test(o.kid) && str(o.publicKeyHex, 64) && /^[0-9a-f]{64}$/.test(o.publicKeyHex) && str(o.file, 4096);
      })
      .slice(0, 20),
    lastKeyFile: str(raw.lastKeyFile, 4096) ? raw.lastKeyFile : null,
  };
}

export function saveSettings(file: string, s: Settings): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
}
