import { describe, expect, it } from 'vitest';
import { buildBootstrap, parseServiceMessage, shutdownMessage } from '../src/lib/bootstrap.js';

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

  it('shutdown message is a constant', () => {
    expect(shutdownMessage).toEqual({ type: 'shutdown' });
  });
});
