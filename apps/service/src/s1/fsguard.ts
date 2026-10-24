// File-system confinement for Creator-chosen paths (TRD TR-081, SECURITY EM-8302): absolute, canonical, no UNC or device
// paths, inside the user profile, the temp folder or the Expertmotion data folder. Paths are canonicalised with realpath so
// symlinks cannot escape a root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EmError } from '@expertmotion/shared';

export function allowedRoots(dataDir: string): string[] {
  const roots = [os.homedir(), os.tmpdir(), dataDir].filter(Boolean).map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });
  return [...new Set(roots)];
}
const refuse = (p: string) => new EmError('EM-8302', 'Expertmotion can only save to folders inside your user profile or removable drives. Choose another folder.', { path: 'body.path', details: { reason: 'outside-allowed-roots', name: path.basename(p) } });

/** Returns the canonical path of an existing file or folder inside an allowed root, else EM-8302. */
export function confine(p: string, roots: readonly string[], kind: 'dir' | 'file'): string {
  if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p) || /^\\\\|^\/\/|^\\\\\?\\|^\\\\\.\\/.test(p)) throw refuse(String(p));
  let real: string;
  try { real = fs.realpathSync(p); } catch { throw new EmError(kind === 'dir' ? 'EM-6301' : 'EM-6302', kind === 'dir' ? 'The backup file could not be written. Choose another folder and try again.' : 'This file is not an Expertmotion backup.', { status: 422, details: { reason: 'missing' } }); }
  const st = fs.statSync(real);
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) throw new EmError(kind === 'dir' ? 'EM-6301' : 'EM-6302', kind === 'dir' ? 'Choose a folder for the backup.' : 'This file is not an Expertmotion backup.', { status: 422, details: { reason: 'type' } });
  const inside = roots.some((r) => { const rel = path.relative(r, real); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); });
  if (!inside) throw refuse(real);
  return real;
}
