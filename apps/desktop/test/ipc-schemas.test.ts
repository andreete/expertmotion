import { describe, expect, it } from 'vitest';
import { IpcPath, OpenUrlArg, parseIpc, PickFilesArgs, PickFolderArgs, PickSaveArgs, UpdateActionArg } from '../src/lib/ipc-schemas.js';

describe('IPC argument validation (SEC-030)', () => {
  it('accepts what the Editor sends', () => {
    expect(parseIpc(PickFilesArgs, { filters: [{ name: 'Expertmotion backup', extensions: ['emproj', 'zip'] }], multiple: false })).not.toBeNull();
    expect(parseIpc(PickFilesArgs, { filters: [{ name: '', extensions: ['*'] }], multiple: false })).not.toBeNull();
    expect(parseIpc(PickFilesArgs, undefined)).toEqual({});
    expect(parseIpc(PickFolderArgs, { defaultPath: 'C:\\Users\\x\\Videos' })).not.toBeNull();
    expect(parseIpc(PickSaveArgs, { defaultPath: 'clip.mp4', filters: [{ name: 'MP4', extensions: ['mp4'] }] })).not.toBeNull();
    expect(UpdateActionArg.safeParse('download').success).toBe(true);
  });
  it('rejects malformed or hostile arguments', () => {
    expect(parseIpc(PickFilesArgs, { filters: [{ name: 'x', extensions: ['../exe'] }] })).toBeNull();
    expect(parseIpc(PickFilesArgs, { filters: 'all' })).toBeNull();
    expect(parseIpc(PickFilesArgs, { multiple: 'yes' })).toBeNull();
    expect(parseIpc(PickFilesArgs, { properties: ['openDirectory'] })).toBeNull();            // unknown keys are refused (.strict)
    expect(parseIpc(PickFolderArgs, { defaultPath: 'file:///etc/passwd' })).toBeNull();
    expect(parseIpc(PickFolderArgs, { defaultPath: 'a\0b' })).toBeNull();
    expect(parseIpc(PickSaveArgs, { defaultPath: 'x'.repeat(2000) })).toBeNull();
    expect(parseIpc(PickSaveArgs, 42)).toBeNull();
    expect(IpcPath.safeParse(42).success).toBe(false);
    expect(OpenUrlArg.safeParse({ href: 'https://x' }).success).toBe(false);
    expect(UpdateActionArg.safeParse('install-now').success).toBe(false);
  });
});
