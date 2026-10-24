import { describe, expect, it } from 'vitest';
import { buildBootstrap, buildMetrics, parseServiceMessage, shutdownMessage } from '../src/lib/bootstrap.js';

const key = 'a'.repeat(64);

describe('bootstrap message (SEC-002, TR-002)', () => {
  it('builds a well-formed bootstrap', () => {
    const b = buildBootstrap({ token: 'x'.repeat(43), port: 47600, dataDir: 'C:/d', dbKeyHex: key });
    expect(b).toEqual({ type: 'bootstrap', token: 'x'.repeat(43), port: 47600, dataDir: 'C:/d', dbKeyHex: key });
  });

  it('rejects a bad dbKeyHex, port, token and dataDir', () => {
    expect(() => buildBootstrap({ token: 'x'.repeat(43), port: 47600, dataDir: 'd', dbKeyHex: 'nothex' })).toThrow();
    expect(() => buildBootstrap({ token: 'x'.repeat(43), port: 0, dataDir: 'd', dbKeyHex: key })).toThrow();
    expect(() => buildBootstrap({ token: 'short', port: 47600, dataDir: 'd', dbKeyHex: key })).toThrow();
    expect(() => buildBootstrap({ token: 'x'.repeat(43), port: 47600, dataDir: '', dbKeyHex: key })).toThrow();
  });

  it('parses ready and fatal messages, rejecting junk', () => {
    expect(parseServiceMessage({ type: 'ready', port: 47600 })).toEqual({ type: 'ready', port: 47600 });
    expect(parseServiceMessage({ type: 'fatal', code: 'EM-8002' })).toEqual({ type: 'fatal', code: 'EM-8002' });
    expect(parseServiceMessage({ type: 'ready' })).toBeNull();
    expect(parseServiceMessage(null)).toBeNull();
    expect(parseServiceMessage('ready')).toBeNull();
  });

  it('carries the prompt key half only when present and well-formed (SEC-133)', () => {
    const base = { token: 'x'.repeat(43), port: 47600, dataDir: 'C:\\data', dbKeyHex: 'a'.repeat(64) };
    expect(buildBootstrap({ ...base, promptKeyHalf: '' })).not.toHaveProperty('promptKeyHalf');
    expect(buildBootstrap({ ...base, promptKeyHalf: 'b'.repeat(64) }).promptKeyHalf).toBe('b'.repeat(64));
    expect(() => buildBootstrap({ ...base, promptKeyHalf: 'zz' })).toThrow();
  });

  it('shutdown message is a constant', () => {
    expect(shutdownMessage).toEqual({ type: 'shutdown' });
  });
});

describe('Shell memory report (FR-127)', () => {
  it('sums Electron process working sets except the Local Service utility process', () => {
    const m = buildMetrics([{ pid: 1, type: 'Browser', memory: { workingSetSize: 102_400 } }, { pid: 2, type: 'Tab', memory: { workingSetSize: 204_800 } },
      { pid: 3, type: 'GPU', memory: { workingSetSize: 51_200 } }, { pid: 9, type: 'Utility', memory: { workingSetSize: 999_999 } }], 9);
    expect(m).toEqual({ type: 'metrics', shellMb: 350 });
  });
});
