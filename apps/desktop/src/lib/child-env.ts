/**
 * Scrubbed environment for the Local Service utility process (SECURITY.md SEC-065, SEC-002): only SYSTEMROOT, TEMP/TMP, LANG and
 * a `PATH` reduced to operating-system directories (no user-installed tools, no per-user PATH entries, so a planted `ffmpeg.exe`
 * or `node.exe` on the Creator's PATH is never found). No proxies, no NODE_OPTIONS, no EM_* (except EM_LOG_LEVEL in development).
 * Development runs keep the parent PATH because the dev Service resolves `ffmpeg`/`ffprobe` by name. Pure; unit-tested.
 */
export function systemPath(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const root = env['SYSTEMROOT'] ?? env['SystemRoot'] ?? 'C:\\Windows';
    // System32 (taskkill, wmic), Wbem (WMI) and Windows PowerShell (systeminformation hardware probes).
    return [`${root}\\System32`, root, `${root}\\System32\\Wbem`, `${root}\\System32\\WindowsPowerShell\\v1.0`].join(';');
  }
  return '/usr/bin:/bin:/usr/sbin:/sbin';
}

export function buildServiceEnv(env: Readonly<Record<string, string | undefined>>, opts: { platform: NodeJS.Platform; packaged: boolean }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['SYSTEMROOT', 'TEMP', 'TMP', 'LANG'] as const) { const v = env[key]; if (v !== undefined) out[key] = v; }
  out['PATH'] = opts.packaged ? systemPath(env, opts.platform) : (env['PATH'] ?? systemPath(env, opts.platform));
  if (!opts.packaged && env['EM_LOG_LEVEL'] !== undefined) out['EM_LOG_LEVEL'] = env['EM_LOG_LEVEL'];
  return out;
}
