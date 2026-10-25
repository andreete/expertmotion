import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { isInsideRepo } from './license-lib.js';

/** Nearest ancestor (or self) that contains a .git entry, or null. */
export function findGitRoot(p: string): string | null {
  let dir = path.resolve(p);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Private keys never live in a repository (AGENTS.md rule 7). The CLI library's own check covers this
 * repository when run from source; inside the bundled app its repo root is not known, so the admin app
 * additionally refuses any folder inside a git working tree.
 */
export function keyLocationProblem(p: string): string | null {
  if (isInsideRepo(p)) return 'This folder is inside the Expertmotion repository. Keep the signing key outside any repository (e.g. on the encrypted USB drive).';
  const g = findGitRoot(p);
  if (g) return `This folder is inside a git repository (${g}). Keep the signing key outside any repository (e.g. on the encrypted USB drive).`;
  return null;
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function workspacePaths(workspaceDir: string): { auditPath: string; outDir: string; distDir: string; revokedPath: string } {
  const distDir = path.join(workspaceDir, 'dist');
  return {
    auditPath: path.join(workspaceDir, 'audit', 'licences.csv'),
    outDir: path.join(workspaceDir, 'out'),
    distDir,
    revokedPath: path.join(distDir, 'revoked.json'),
  };
}
