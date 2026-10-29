// QA P1 2026-10-29 (round 1): Windows imports from D:\ or a USB stick were refused EM-1007 (only the home folder was a root).
// Windows path semantics via path.win32 and an injected native realpath (8.3 names, junctions, symlinks).
import { describe, expect, it } from 'vitest';
import { canonicalImportPath } from '../../src/modules/assets.js';
import { win32Canonical, win32DenyRoots, win32ImportDecision, win32Inside, type Win32ImportEnv } from '../../src/s2/import-paths-win32.js';

const WINENV = { SystemRoot: 'C:\\WINDOWS', SystemDrive: 'C:', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' };
const INSTALL = 'C:\\Users\\Rina\\AppData\\Local\\Programs\\Expertmotion';
const DATA = 'C:\\Users\\Rina\\AppData\\Roaming\\Expertmotion';
/** What fs.realpathSync.native would return: 8.3 names expanded, junctions / symlinks followed, real casing. */
const REAL: Record<string, string> = {
  'c:\\progra~1\\app\\clip.mp4': 'C:\\Program Files\\App\\clip.mp4',
  'c:\\users\\rina\\videos\\link-to-sys': 'C:\\Windows\\System32',
  'c:\\users\\rina\\videos\\link-to-sys\\drivers\\etc\\hosts': 'C:\\Windows\\System32\\drivers\\etc\\hosts',
  'c:\\users\\rina\\videos\\nas.mp4': '\\\\nas\\media\\nas.mp4',
  'd:\\shoot\\junction\\a.mp4': 'E:\\Footage\\a.mp4',
  'c:\\users\\rina\\videos\\vlog~1.mp4': 'C:\\Users\\Rina\\Videos\\vlog panjang.mp4',
};
const realpath = (p: string): string => { const k = p.toLowerCase(); if (k.includes('missing')) throw new Error('ENOENT'); return REAL[k] ?? p; };
const env: Win32ImportEnv = { allow: [`${INSTALL}\\resources\\sample`], deny: win32DenyRoots(WINENV, [INSTALL, DATA]), realpath };
const ok = (p: string, origin: 'picker' | 'drop' | null = 'drop') => win32ImportDecision(p, origin, env);

describe('QA P1: win32 import roots', () => {
  it('files on D:\\, a USB stick (F:\\) and the home folder are allowed from the picker AND from drag-and-drop', () => {
    for (const o of ['picker', 'drop'] as const) {
      expect(ok('D:\\Shoot\\day1\\A001.MP4', o)).toEqual({ ok: true, path: 'D:\\Shoot\\day1\\A001.MP4' });
      expect(ok('F:\\DCIM\\100CANON\\IMG_0001.JPG', o)).toMatchObject({ ok: true });
      expect(ok('C:\\Users\\Rina\\Videos\\vlog.mp4', o)).toMatchObject({ ok: true });
    }
  });
  it('system folders and the app\'s own install / data folders stay refused, in any casing or spelling', () => {
    for (const p of ['C:\\Windows\\System32\\drivers\\etc\\hosts', 'c:\\windows\\win.ini', 'C:/WINDOWS/notepad.exe', 'C:\\Program Files\\App\\clip.mp4', 'C:\\Program Files (x86)\\x\\y.png',
      'C:\\ProgramData\\Secrets\\a.wav', `${DATA}\\data\\studio.db`, `${INSTALL.toUpperCase()}\\resources\\app.asar`, 'C:\\$Recycle.Bin\\S-1-5\\x.mp4'])
      expect(ok(p), p).toMatchObject({ ok: false, code: 'EM-1007', reason: 'system-or-app-folder' });
  });
  it('the bundled sample media inside the install dir stays importable', () => {
    expect(ok(`${INSTALL}\\resources\\sample\\pantai.mp4`)).toMatchObject({ ok: true });
  });
  it('canonicalisation: \\\\?\\ prefixes, 8.3 short names, junctions and symlinks are resolved before the check', () => {
    expect(win32Canonical('\\\\?\\D:\\Shoot\\a.mp4')).toBe('D:\\Shoot\\a.mp4');
    expect(win32Canonical('\\\\?\\UNC\\nas\\media\\a.mp4')).toBe('\\\\nas\\media\\a.mp4');
    expect(win32Canonical('D:\\Shoot\\..\\Shoot\\.\\a.mp4')).toBe('D:\\Shoot\\a.mp4');
    expect(ok('\\\\?\\D:\\Shoot\\a.mp4')).toEqual({ ok: true, path: 'D:\\Shoot\\a.mp4' });
    expect(ok('\\\\?\\C:\\Windows\\win.ini')).toMatchObject({ ok: false, reason: 'system-or-app-folder' });
    expect(ok('C:\\PROGRA~1\\App\\clip.mp4')).toMatchObject({ ok: false, reason: 'system-or-app-folder' });        // 8.3 name of Program Files
    expect(ok('C:\\Users\\Rina\\Videos\\link-to-sys\\drivers\\etc\\hosts')).toMatchObject({ ok: false, reason: 'system-or-app-folder' });   // symlink into Windows
    expect(ok('D:\\Shoot\\junction\\a.mp4')).toEqual({ ok: true, path: 'E:\\Footage\\a.mp4' });                     // junction to another local drive
    expect(ok('C:\\Users\\Rina\\Videos\\VLOG~1.MP4')).toEqual({ ok: true, path: 'C:\\Users\\Rina\\Videos\\vlog panjang.mp4' });
    expect(win32Inside('c:\\program files', 'C:\\Program Files\\x')).toBe(true);
    expect(win32Inside('C:\\Program Files', 'C:\\Program Files (x86)\\x')).toBe(false);
  });
  it('UNC / network paths only from the picker (also behind a link); device paths, ADS and reserved names never', () => {
    expect(ok('\\\\nas\\media\\a.mp4', 'picker')).toMatchObject({ ok: true, path: '\\\\nas\\media\\a.mp4' });
    expect(ok('\\\\nas\\media\\a.mp4', 'drop')).toMatchObject({ ok: false, reason: 'network-path-not-from-picker' });
    expect(ok('\\\\nas\\media\\a.mp4', null)).toMatchObject({ ok: false, reason: 'network-path-not-from-picker' });
    expect(ok('\\\\?\\UNC\\nas\\media\\a.mp4', 'drop')).toMatchObject({ ok: false, reason: 'network-path-not-from-picker' });
    expect(ok('C:\\Users\\Rina\\Videos\\nas.mp4', 'drop')).toMatchObject({ ok: false, reason: 'network-path-not-from-picker' });
    for (const p of ['\\\\.\\PhysicalDrive0', 'D:\\Shoot\\a.mp4:hidden', 'D:\\Shoot\\CON', 'D:\\nul.mp4', 'relative\\a.mp4', '\\Shoot\\a.mp4'])
      expect(ok(p, 'picker'), p).toMatchObject({ ok: false, code: 'EM-1007' });
    expect(ok('D:\\missing.mp4')).toMatchObject({ ok: false, code: 'EM-1010' });
  });
  it('canonicalImportPath on win32: EM-1007 with the reason, the allowed path otherwise', () => {
    const o = { platform: 'win32' as const, origin: 'drop' as const, win32: { allow: env.allow, deny: env.deny, realpath } };
    expect(canonicalImportPath('D:\\Shoot\\a.mp4', [], o)).toBe('D:\\Shoot\\a.mp4');
    expect(() => canonicalImportPath('C:\\Windows\\win.ini', [], o)).toThrow(expect.objectContaining({ code: 'EM-1007', details: { reason: 'system-or-app-folder' } }));
    expect(() => canonicalImportPath('D:\\missing.mp4', [], o)).toThrow(expect.objectContaining({ code: 'EM-1010' }));
  });
});
