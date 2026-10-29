// QA P1 2026-10-29 (round 1, TR-081): on Windows only the home folder was an allowed import root, so files from D:\ or a USB
// stick were refused with EM-1007. A path the Creator chose in the Shell file picker or dropped on the Editor is their explicit
// choice: any local fixed / removable drive is allowed; system folders (Windows, Program Files, ProgramData) and Expertmotion's
// own install / data folders stay refused; UNC / network paths only from the picker. Paths are canonicalised with Windows
// semantics (case-insensitive, \\?\ prefixes removed, 8.3 short names and junctions / symlinks resolved by the native realpath)
// BEFORE the checks, so no spelling of a refused folder gets through. Pure apart from the injected `realpath` (tests use path.win32).
// Honest boundary: `origin` is declared by the Editor (the Shell-only R-030 route), it is not proof that a dialog was shown.
import path from 'node:path';

export type ImportOrigin = 'picker' | 'drop';
export interface Win32ImportEnv {
  /** Folders that are always allowed even inside a refused folder (the bundled sample media in the install dir). */
  allow: readonly string[];
  /** Refused folders: %SystemRoot%, Program Files (x86), ProgramData, the app install dir, the app data dir. */
  deny: readonly string[];
  /** fs.realpathSync.native on Windows: expands 8.3 names, resolves junctions / symlinks; throws when the file is missing. */
  realpath: (p: string) => string;
}
export type Win32ImportResult = { ok: true; path: string } | { ok: false; code: 'EM-1007' | 'EM-1010'; reason: string };

const W = path.win32;
/** `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\share` → `\\srv\share`; `/` → `\`; resolved and normalised. Device paths (`\\.\`) → null. */
export function win32Canonical(p: string): string | null {
  let s = p.replace(/\//g, '\\');
  if (/^\\\\\.\\/.test(s)) return null;                                     // \\.\PhysicalDrive0, \\.\pipe\…
  if (/^\\\\\?\\UNC\\/i.test(s)) s = `\\\\${s.slice(8)}`;
  else if (/^\\\\\?\\/.test(s)) s = s.slice(4);
  if (!W.isAbsolute(s) || /^\\(?!\\)/.test(s)) return null;                 // relative or drive-relative "\x"
  return W.resolve(s);
}
const isUnc = (p: string) => /^\\\\[^\\?.]/.test(p);
const lower = (p: string) => p.toLowerCase();
/** Case-insensitive "p is root or inside root" with Windows semantics. */
export function win32Inside(root: string, p: string): boolean {
  const r = win32Canonical(root); if (!r) return false;
  const rel = W.relative(lower(r), lower(p));
  return rel === '' || (!rel.startsWith('..') && !W.isAbsolute(rel));
}
/** ADS (`file.mp4:stream`) and reserved device names (CON, NUL, COM1 …) are never files the Creator chose. */
function badName(p: string): boolean {
  const tail = p.slice(2);                                                 // after "C:" or the leading double backslash
  if (tail.includes(':')) return true;
  return p.split('\\').some((seg) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(seg));
}

export function win32ImportDecision(raw: string, origin: ImportOrigin | null, env: Win32ImportEnv): Win32ImportResult {
  const first = win32Canonical(raw);
  if (!first || badName(first)) return { ok: false, code: 'EM-1007', reason: 'not-a-local-file' };
  if (isUnc(first) && origin !== 'picker') return { ok: false, code: 'EM-1007', reason: 'network-path-not-from-picker' };
  let real: string | null;
  try { real = win32Canonical(env.realpath(first)); } catch { return { ok: false, code: 'EM-1010', reason: 'missing' }; }
  if (!real || badName(real)) return { ok: false, code: 'EM-1007', reason: 'not-a-local-file' };
  // a junction / symlink that leads to a network share counts as a network path
  if (isUnc(real) && origin !== 'picker') return { ok: false, code: 'EM-1007', reason: 'network-path-not-from-picker' };
  if (!isUnc(real) && !/^[a-z]:\\/i.test(real)) return { ok: false, code: 'EM-1007', reason: 'not-a-local-file' };
  if (env.allow.some((a) => win32Inside(a, real!))) return { ok: true, path: real };
  if (env.deny.some((d) => win32Inside(d, real!))) return { ok: false, code: 'EM-1007', reason: 'system-or-app-folder' };
  return { ok: true, path: real };
}

/** The refused folders of this Windows installation (env vars as Windows sets them; the app's own folders added by the caller). */
export function win32DenyRoots(env: NodeJS.ProcessEnv, own: readonly string[]): string[] {
  const sys = env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows';
  const drive = (env['SystemDrive'] ?? 'C:').replace(/\\$/, '');
  return [sys, env['ProgramFiles'] ?? `${drive}\\Program Files`, env['ProgramFiles(x86)'] ?? `${drive}\\Program Files (x86)`, env['ProgramW6432'] ?? '',
    env['ProgramData'] ?? `${drive}\\ProgramData`, `${drive}\\$Recycle.Bin`, `${drive}\\System Volume Information`, ...own].filter(Boolean);
}
