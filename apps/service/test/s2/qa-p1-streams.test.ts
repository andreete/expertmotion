// QA P1 2026-10-29 (round 1): music track preview and voice sample preview always answered 204 because route() ended the
// response while sendFile() was still streaming. Real HTTP requests: status 200, the right Content-Type, every byte, Range 206.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { health } from '../../src/modules/health.js';
import { createGeneratorsModule } from '../../src/modules/generators.js';
import { sendFile } from '../../src/modules/media.js';
import { route } from '../../src/http/route.js';
import { musicLibraryOf } from '../../src/s2/music-library-service.js';
import { voicesServiceOf } from '../../src/s2/voices-service.js';
import { startS2, wavBuffer, type S2Service } from './harness.js';
import { tempDir } from '../helpers.js';

describe('QA P1: streamed audio previews arrive with their bytes', () => {
  let s: S2Service; let wav: Buffer; let dir: string;
  beforeAll(async () => {
    s = await startS2([health, createGeneratorsModule()]);
    dir = tempDir('em-stream-'); wav = wavBuffer(1500);
  });
  afterAll(async () => { await s.close(); });

  it('music library track audio: 200, audio/wav, all bytes (was 204 → "Model not installed EM-7001")', async () => {
    const file = path.join(dir, 'track.wav'); fs.writeFileSync(file, wav);
    const lib = musicLibraryOf(s.ctx); const orig = lib.readyFile.bind(lib);
    lib.readyFile = async () => file;
    try {
      const r = await s.api('/music-library/any-track/audio');
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/^audio\/(wav|x-wav)/);
      const body = Buffer.from(await r.arrayBuffer());
      expect(body.length).toBe(wav.length); expect(body.equals(wav)).toBe(true);
      // Range for the <audio> element / seeking
      const p = await s.api('/music-library/any-track/audio', { headers: { Range: 'bytes=100-199' } });
      expect(p.status).toBe(206); expect(p.headers.get('content-range')).toBe(`bytes 100-199/${wav.length}`);
      expect(Buffer.from(await p.arrayBuffer()).equals(wav.subarray(100, 200))).toBe(true);
    } finally { lib.readyFile = orig; }
  });

  it('a track that is not downloaded still answers its own error code (EM-7001 422), not 204', async () => {
    const r = await s.api('/music-library/no-such-track-xyz/audio');
    expect(r.status).not.toBe(204); expect(r.status).not.toBe(200);
    expect(((await r.json()) as { error: { code: string } }).error.code).toMatch(/^EM-\d{4}$/);
  });

  it('voice sample preview: 200, audio/wav, all bytes (was a silent 204)', async () => {
    const file = voicesServiceOf(s.ctx).previewPath('piper:test-voice', 'id'); fs.writeFileSync(file, wav);
    const r = await s.api('/voices/piper%3Atest-voice/preview?language=id');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^audio\/(wav|x-wav)/);
    expect(r.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(Buffer.from(await r.arrayBuffer()).equals(wav)).toBe(true);
  });

  it('route() contract: a handler that streams without awaiting is never cut short with 204', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7); const file = path.join(dir, 'big.wav'); fs.writeFileSync(file, big);
    const app = express(); const router = express.Router();
    route(router, 'get', '/x', {}, ({ req, res }) => { void sendFile(req, res, file); });   // forgot the await on purpose
    app.use(router);
    const server = http.createServer(app); await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    try {
      const r = await fetch(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/x`);
      expect(r.status).toBe(200);
      expect(Buffer.from(await r.arrayBuffer()).length).toBe(big.length);
    } finally { server.closeAllConnections(); await new Promise<void>((ok) => server.close(() => ok())); }
  });
});
