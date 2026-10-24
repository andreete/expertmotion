import { describe, expect, it } from 'vitest';
import { buildServiceEnv, systemPath } from '../src/lib/child-env.js';

describe('Local Service environment (SEC-065)', () => {
  const parent = { SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\T', TMP: 'C:\\T', LANG: 'id_ID', PATH: 'C:\\Users\\x\\bin;C:\\Python;C:\\Windows\\System32',
    HTTPS_PROXY: 'http://evil:8080', NODE_OPTIONS: '--require x.js', EM_DEV: '1', EM_LOG_LEVEL: 'debug', ELECTRON_RUN_AS_NODE: '1' };
  it('packaged: only the allow-listed keys and a system-only PATH', () => {
    const env = buildServiceEnv(parent, { platform: 'win32', packaged: true });
    expect(Object.keys(env).sort()).toEqual(['LANG', 'PATH', 'SYSTEMROOT', 'TEMP', 'TMP']);
    expect(env['PATH']).toBe(systemPath(parent, 'win32'));
    expect(env['PATH']).not.toContain('Users');
    expect(env['PATH']).not.toContain('Python');
    expect(env['PATH']!.split(';').every((d) => d.startsWith('C:\\Windows'))).toBe(true);
  });
  it('development keeps the parent PATH and EM_LOG_LEVEL, still no proxies or NODE_OPTIONS', () => {
    const env = buildServiceEnv(parent, { platform: 'linux', packaged: false });
    expect(env['PATH']).toBe(parent.PATH);
    expect(env['EM_LOG_LEVEL']).toBe('debug');
    expect(env).not.toHaveProperty('HTTPS_PROXY');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('EM_DEV');
  });
  it('Linux packaged PATH is the system directories', () => {
    expect(buildServiceEnv({ PATH: '/home/u/.local/bin:/usr/bin' }, { platform: 'linux', packaged: true })['PATH']).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });
});
