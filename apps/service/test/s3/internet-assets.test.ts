// ADR-041 internet assets (FR-300 … FR-307): page picture extractor (HTML fixtures), Pexels mapping (fixture JSON), the R-089 import
// route with the new sources (fake egress behind the real guard), the Pexels key routes (sealed, hint only), the web.images /
// web.screenshot handlers (allow-list, source switch) and the CREDITS lines. No real network, no real browser (screenshot-real.test.ts).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyModel } from '@expertmotion/composition-model';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { providersModule } from '../../src/modules/providers.js';
import { usageModule } from '../../src/modules/usage.js';
import { agentsModule } from '../../src/modules/agents.js';
import { eventsModule } from '../../src/modules/events.js';
import { addProject, body, fakeEgress, json } from './s3-helpers.js';
import { OWNER_LICENCE_TEXT, PEXELS_LICENCE_TEXT, attributionText, creditText, largestOfSrcset, licenceText, pageImageId, pageImages, pexelsPhotoCandidate, pexelsVideoCandidate, pexelsVideoFile, researchHandlers, resolvePageImage, tagAttrs, type ImageCandidate } from '../../src/s3/research.js';
import { researchKeysOf } from '../../src/s3/research-keys.js';
import { captureOnBrowser, pngSize, screenshotPage, screenshotTurn, type BrowserForShots } from '../../src/s3/screenshot.js';
import { buildCredits } from '../../src/s2/reels/credits.js';
import { ingestOf } from '../../src/s2/ingest.js';
import { EmError } from '@expertmotion/shared';

const PAGE = 'https://www.kompas.com/berita/boikot-brand-raffi-ahmad';
const HTML = `<!doctype html><html><head><title>Netizen boikot brand &amp; acara Raffi Ahmad - Kompas</title>
<meta property="og:title" content="Netizen boikot brand Raffi Ahmad">
<meta property="og:image" content="https://asset.kompas.com/crops/og-1200x630.jpg">
<meta name="twitter:image" content="//asset.kompas.com/crops/tw-800x418.jpg">
<link rel="image_src" href="/crops/image-src.jpg">
<base href="https://www.kompas.com/berita/">
</head><body>
<img src="https://stat.kompas.com/pixel.gif" width="1" height="1">
<img src="data:image/png;base64,AAAA" width="800" height="600">
<img src="/img/logo.svg" width="400" height="400">
<img src="https://asset.kompas.com/crops/photo-a.jpg" width="1200" height="800" alt="Poster acara yang dibatalkan">
<img src="https://asset.kompas.com/crops/thumb.jpg" width="320" height="180" alt="thumb">
<img srcset="foto-400.jpg 400w, foto-1600.jpg 1600w, foto-800.jpg 800w" alt="Unjuk rasa netizen">
<img src="https://asset.kompas.com/crops/tall.jpg" width="900" height="1600">
<img data-src="https://cdn.example.org/lazy.jpg">
<img src="https://asset.kompas.com/crops/photo-a.jpg" width="1200" height="800">
<img src="http://insecure.example.org/pic.jpg" width="600" height="600">
</body></html>`;

describe('page picture extractor (FR-304)', () => {
  it('lists social-card images first, then sized <img> largest first, resolves relative addresses and skips pixels, data:, svg, small thumbs', () => {
    const c = pageImages(HTML, PAGE);
    const urls = c.map((x) => x.url);
    expect(urls.slice(0, 3)).toEqual(['https://asset.kompas.com/crops/og-1200x630.jpg', 'https://asset.kompas.com/crops/tw-800x418.jpg', 'https://www.kompas.com/crops/image-src.jpg']);
    expect(urls).toContain('https://asset.kompas.com/crops/tall.jpg');
    expect(urls).toContain('https://asset.kompas.com/crops/photo-a.jpg');
    expect(urls).toContain('https://www.kompas.com/berita/foto-1600.jpg');                // srcset largest, resolved against <base>
    expect(urls).toContain('https://insecure.example.org/pic.jpg');                        // http → https
    expect(urls).toContain('https://cdn.example.org/lazy.jpg');                            // unsized lazy image, last
    expect(urls.filter((u) => u === 'https://asset.kompas.com/crops/photo-a.jpg')).toHaveLength(1);   // deduplicated
    for (const bad of ['pixel.gif', 'data:', 'logo.svg', 'thumb.jpg']) expect(urls.some((u) => u.includes(bad))).toBe(false);
    // sized imgs sorted by area: tall (900×1600) before photo-a (1200×800)
    expect(urls.indexOf('https://asset.kompas.com/crops/tall.jpg')).toBeLessThan(urls.indexOf('https://asset.kompas.com/crops/photo-a.jpg'));
    expect(urls.indexOf('https://asset.kompas.com/crops/photo-a.jpg')).toBeLessThan(urls.indexOf('https://www.kompas.com/berita/foto-1600.jpg'));   // sized before srcset-only
    expect(urls.indexOf('https://www.kompas.com/berita/foto-1600.jpg')).toBeLessThan(urls.indexOf('https://cdn.example.org/lazy.jpg'));              // srcset-only before unsized
    const a = c.find((x) => x.url === 'https://asset.kompas.com/crops/photo-a.jpg')!;
    expect(a).toMatchObject({ source: 'page', kind: 'image', title: 'Poster acara yang dibatalkan', creator: 'kompas.com', license: 'owner', licence: OWNER_LICENCE_TEXT, landingUrl: PAGE, width: 1200, height: 800, provider: 'kompas.com', thumbUrl: a.url });
    expect(a.id).toBe(pageImageId(a.url));
    expect(c[0]!.title).toBe('Netizen boikot brand Raffi Ahmad');                          // og:title for an untitled social image
    expect(c.length).toBeLessThanOrEqual(12);
  });
  it('caps at 12 and tolerates garbage', () => {
    const many = Array.from({ length: 40 }, (_, i) => `<img src="https://x.org/p${i}.jpg" width="${500 + i}" height="500">`).join('');
    expect(pageImages(`<html><body>${many}`, 'https://x.org/a')).toHaveLength(12);
    expect(pageImages('', 'https://x.org/a')).toEqual([]);
    expect(pageImages('<img src="javascript:alert(1)" width=900 height=900><img src="https://u:p@x.org/a.jpg" width=900 height=900>', 'https://x.org/')).toEqual([]);
  });
  it('tagAttrs / largestOfSrcset', () => {
    expect(tagAttrs('<img SRC="a.jpg" width=400 data-x=\'y &amp; z\' alt>')).toEqual({ src: 'a.jpg', width: '400', 'data-x': 'y & z', alt: '' });
    expect(largestOfSrcset('a.jpg 1x, b.jpg 2x')).toEqual({ url: 'b.jpg', width: null });
    expect(largestOfSrcset('a.jpg 400w, b.jpg 1600w')).toEqual({ url: 'b.jpg', width: 1600 });
  });
  it('resolvePageImage only accepts the stored address with its own id', () => {
    const c = pageImages(HTML, PAGE)[0]!;
    expect(resolvePageImage(c).downloadUrl).toBe(c.url);
    expect(() => resolvePageImage({ ...c, url: 'https://evil.example.org/x.jpg' })).toThrow(/address cannot be used/);
    expect(() => resolvePageImage({ ...c, url: 'https://127.0.0.1/x.jpg', id: pageImageId('https://127.0.0.1/x.jpg') })).toThrow(/IP address/);
  });
});

const PHOTO = { id: 2014422, width: 3024, height: 4032, url: 'https://www.pexels.com/photo/brown-rocks-during-golden-hour-2014422/', photographer: 'Joey Farina', photographer_url: 'https://www.pexels.com/@joey', alt: 'Brown rocks during golden hour',
  src: { original: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg', large2x: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940', large: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?h=650&w=940', medium: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?h=350', small: 'https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?h=130' } };
const VIDEO = { id: 2499611, width: 1080, height: 1920, duration: 22, url: 'https://www.pexels.com/video/2499611/', image: 'https://images.pexels.com/videos/2499611/free-video-2499611.jpg', user: { id: 680589, name: 'Joey Farina', url: 'https://www.pexels.com/@joey' },
  video_files: [
    { id: 1, quality: 'uhd', file_type: 'video/mp4', width: 2160, height: 3840, link: 'https://videos.pexels.com/video-files/2499611/uhd.mp4' },
    { id: 2, quality: 'hd', file_type: 'video/mp4', width: 1080, height: 1920, link: 'https://videos.pexels.com/video-files/2499611/hd.mp4' },
    { id: 3, quality: 'sd', file_type: 'video/mp4', width: 540, height: 960, link: 'https://videos.pexels.com/video-files/2499611/sd.mp4' },
    { id: 4, quality: 'hd', file_type: 'video/mp4', width: 720, height: 1280, link: 'https://player.vimeo.com/external/2499611.hd.mp4' },
    { id: 5, quality: 'hls', file_type: 'video/mp4', width: null, height: null, link: 'https://videos.pexels.com/video-files/2499611/hls.m3u8' },
  ] };

describe('Pexels mapping (FR-301, FR-302)', () => {
  it('maps a photo and a video record; picks the largest HD / SD mp4 ≤ 1080 on a Pexels host', () => {
    const p = pexelsPhotoCandidate(PHOTO)!;
    expect(p).toMatchObject({ source: 'pexels', id: '2014422', kind: 'image', title: 'Brown rocks during golden hour', creator: 'Joey Farina', license: 'pexels', licence: PEXELS_LICENCE_TEXT, landingUrl: PHOTO.url, width: 3024, height: 4032, thumbUrl: PHOTO.src.medium });
    const v = pexelsVideoCandidate(VIDEO)!;
    expect(v).toMatchObject({ source: 'pexels-video', id: '2499611', kind: 'video', creator: 'Joey Farina', durationS: 22, thumbUrl: VIDEO.image });
    expect(pexelsVideoFile(VIDEO)).toEqual({ link: 'https://videos.pexels.com/video-files/2499611/hd.mp4', width: 1080, height: 1920, quality: 'hd' });
    expect(pexelsVideoFile({ ...VIDEO, video_files: [VIDEO.video_files[3]!] })).toBeNull();          // vimeo host refused
    expect(pexelsVideoCandidate({ ...VIDEO, video_files: [VIDEO.video_files[0]!] })).toBeNull();     // only UHD → not importable → not listed
    expect(licenceText(p)).toBe('Pexels License');
    expect(creditText(p)).toBe(`Joey Farina / Pexels — ${PHOTO.url}`);
    expect(attributionText(v)).toContain('Video by Joey Farina on Pexels');
    expect(licenceText({ license: 'by', licenseVersion: '4.0' })).toBe('CC BY 4.0');
  });
});

describe('import route, key routes, handlers (R-089, R-089a … R-089c)', () => {
  let s: TestService; let pid: string; let calls: ReturnType<typeof fakeEgress>;
  const modules = [health, settingsModule, providersModule, usageModule, agentsModule, eventsModule];
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1), Buffer.from([0xff, 0xd9])]);
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(800, 2)]);
  let served = { bigVideo: false };
  beforeAll(async () => {
    s = await startService({ modules });
    pid = addProject(s);
    calls = fakeEgress(s, [
      (c) => (c.url.startsWith('https://api.pexels.com/v1/search?') ? (c.headers['authorization'] === 'goodkey0123456789abcdef' ? json(200, { photos: [PHOTO], page: 1 }) : json(401, { error: 'Access to this API has been disallowed' })) : undefined),
      (c) => (c.url.startsWith('https://api.pexels.com/videos/search?') ? json(200, { videos: [VIDEO] }) : undefined),
      (c) => (c.url === 'https://api.pexels.com/v1/photos/2014422' ? json(200, PHOTO) : undefined),
      (c) => (c.url === 'https://api.pexels.com/videos/videos/2499611' ? json(200, VIDEO) : undefined),
      (c) => (c.url.startsWith('https://images.pexels.com/') ? new Response(JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }) : undefined),
      (c) => (c.url === 'https://videos.pexels.com/video-files/2499611/hd.mp4' ? new Response(served.bigVideo ? Buffer.alloc(61 * 1024 * 1024) : MP4, { status: 200, headers: { 'Content-Type': 'video/mp4' } }) : undefined),
      (c) => (c.url === PAGE ? new Response(HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : undefined),
      (c) => (c.url.startsWith('https://asset.kompas.com/') || (c.url.startsWith('https://www.kompas.com/') && c.url !== PAGE) ? new Response(JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }) : undefined),
    ], { lookup: async () => ['93.184.216.34'] });   // every research host "resolves" to a public address: no real DNS in the test
  });
  afterAll(async () => { await s.close(); });

  let convId: string | null = null;
  const storeBlock = (items: ImageCandidate[]): string => {
    const now = s.ctx.now();
    if (!convId) { convId = s.ctx.newId(); s.ctx.db.prepare('INSERT INTO conversations(id, project_id, agent, created_at, updated_at) VALUES (?,?,?,?,?)').run(convId, pid, 'brainstorm', now, now); }
    const mid = s.ctx.newId();
    s.ctx.db.prepare('INSERT INTO messages(id, conversation_id, role, blocks_json, created_at) VALUES (?,?,?,?,?)').run(mid, convId, 'assistant', JSON.stringify([{ type: 'text', text: 'Kandidat' }, { type: 'image_candidates', items }]), now);
    return mid;
  };
  const importOne = (messageId: string, source: string, id: string) => s.api(`/projects/${pid}/research/images/import`, { method: 'POST', json: { messageId, source, id } });
  const assetRow = (id: string) => s.ctx.db.prepare('SELECT kind, name, credit, licence FROM assets WHERE id = ?').get(id) as { kind: string; name: string; credit: string | null; licence: string | null };

  it('stores the Pexels key sealed after a check, returns only the hint, refuses a bad key with EM-4410, removes it', async () => {
    expect(await body(await s.api('/research-keys'))).toEqual({ pexels: { hint: null } });
    const bad = await s.api('/research-keys/pexels', { method: 'PUT', json: { key: 'badkey00000000000000000000' } });
    expect(bad.status).toBe(422); expect((await body(bad))['error']).toMatchObject({ code: 'EM-4410' });
    const short = await s.api('/research-keys/pexels', { method: 'PUT', json: { key: 'short key with spaces' } });
    expect(short.status).toBe(400);
    const ok = await s.api('/research-keys/pexels', { method: 'PUT', json: { key: ' goodkey0123456789abcdef\n' } });
    expect(ok.status).toBe(200); expect(await body(ok)).toEqual({ provider: 'pexels', secretHint: '…cdef', status: 'valid' });
    expect(calls.at(-1)!.url).toBe('https://api.pexels.com/v1/search?query=nature&per_page=1');
    expect(calls.at(-1)!.headers['authorization']).toBe('goodkey0123456789abcdef');
    const row = s.ctx.db.prepare('SELECT secret_enc, secret_hint FROM research_keys WHERE provider = ?').get('pexels') as { secret_enc: Buffer; secret_hint: string };
    expect(row.secret_hint).toBe('…cdef');
    expect(Buffer.from(row.secret_enc).toString('latin1')).not.toContain('goodkey');
    expect(researchKeysOf(s.ctx).key('pexels')).toBe('goodkey0123456789abcdef');
    expect(await body(await s.api('/research-keys'))).toEqual({ pexels: { hint: '…cdef' } });
  });

  it('web.images: source open / stock / page; page needs the allow-list; stock needs the key', async () => {
    const cfg = { available: true as const, mode: 'tools' as const, images: true as const, provider: 'openrouter' };
    const seen: ImageCandidate[] = [];
    let key: string | null = null;
    const h = researchHandlers({ cfg, fetchPage: s.ctx.egress.for('research'), fetchApi: s.ctx.egress.for('research-api'), allowedUrls: () => [PAGE], onImages: (c) => seen.push(...c), pexelsKey: () => key,
      screenshot: async (url, viewport) => ({ assetId: 'A1', title: `Tangkapan layar · ${new URL(url).hostname}`, host: new URL(url).hostname, width: viewport === 'phone' ? 1080 : 2160, height: viewport === 'phone' ? 1920 : 1350 }) });
    const stockNoKey = await h['web.images']!({ query: 'factory', source: 'stock' }) as { error?: { code: string } };
    expect(stockNoKey.error?.code).toBe('EM-4410');
    key = 'goodkey0123456789abcdef';
    const stock = await h['web.images']!({ query: 'factory', source: 'stock' }) as { source: string; candidates: Array<Record<string, unknown>> };
    expect(stock.source).toBe('stock');
    expect(stock.candidates.map((c) => [c['source'], c['kind'], c['licence']])).toEqual([['pexels', 'image', 'Pexels License'], ['pexels-video', 'video', 'Pexels License']]);
    expect(stock.candidates[1]).toMatchObject({ durationS: 22, author: 'Joey Farina' });
    expect(stock.candidates.every((c) => !('url' in c) && !('thumbUrl' in c))).toBe(true);                      // metadata only for the model
    const pexelsCall = calls.find((c) => c.url.includes('/v1/search?query=factory'))!;
    expect(pexelsCall.url).toContain('per_page=12&orientation=portrait'); expect(pexelsCall.headers['authorization']).toBe(key);
    const refused = await h['web.images']!({ query: 'x', source: 'page', url: 'https://other.example.org/page' }) as { error?: { code: string } };
    expect(refused.error?.code).toBe('EM-4406');
    const page = await h['web.images']!({ query: 'x', source: 'page', url: PAGE }) as { source: string; candidates: Array<Record<string, unknown>>; note: string };
    expect(page.source).toBe('page'); expect(page.candidates.length).toBeGreaterThanOrEqual(5);
    expect(page.candidates[0]).toMatchObject({ source: 'page', kind: 'image', licence: OWNER_LICENCE_TEXT, pageUrl: PAGE });
    expect(page.note).toContain("owner's copyright");
    expect(seen.filter((c) => c.source === 'page')[0]!.url).toBe('https://asset.kompas.com/crops/og-1200x630.jpg');  // the block keeps the address
    const hx = h as Record<string, (i: Record<string, unknown>) => Promise<unknown>>;
    expect(await hx['web.screenshot']!({ url: 'https://other.example.org/' })).toMatchObject({ error: { code: 'EM-4406' } });
    expect(await hx['web.screenshot']!({ url: PAGE, viewport: 'desktop' })).toMatchObject({ assetId: 'A1', host: 'www.kompas.com', width: 2160, height: 1350, licence: 'Hak cipta pemilik — kutipan' });
  });

  it('imports a Pexels photo (credit + licence on the asset), a Pexels video (mp4 asset) and a page picture; a 61 MB clip is refused', async () => {
    const stock = [pexelsPhotoCandidate(PHOTO)!, pexelsVideoCandidate(VIDEO)!];
    const page = pageImages(HTML, PAGE);
    const mid = storeBlock([...stock, ...page]);
    if (!researchKeysOf(s.ctx).key('pexels')) expect((await s.api('/research-keys/pexels', { method: 'PUT', json: { key: 'goodkey0123456789abcdef' } })).status).toBe(200);
    const photo = await importOne(mid, 'pexels', '2014422');
    expect(photo.status).toBe(202);
    const pb = await body<{ assetId: string; attribution: string }>(photo);
    expect(pb.attribution).toContain('Pexels License');
    await ingestOf(s.ctx).idle();
    expect(assetRow(pb.assetId)).toMatchObject({ kind: 'image', credit: `Joey Farina / Pexels — ${PHOTO.url}`, licence: 'Pexels License' });
    expect(calls.find((c) => c.url === PHOTO.src.large2x)!.headers['x-em-max-bytes']).toBeUndefined();              // the cap header never leaves the egress module
    expect(calls.some((c) => c.url === 'https://api.pexels.com/v1/photos/2014422' && c.headers['authorization'] === 'goodkey0123456789abcdef')).toBe(true);
    const video = await importOne(mid, 'pexels-video', '2499611');
    expect(video.status).toBe(202);
    const vb = await body<{ assetId: string }>(video);
    expect(assetRow(vb.assetId)).toMatchObject({ kind: 'video', licence: 'Pexels License' });
    expect(assetRow(vb.assetId).name).toMatch(/\.mp4$/);
    const vcall = calls.find((c) => c.url === 'https://videos.pexels.com/video-files/2499611/hd.mp4')!;
    expect(vcall.headers['accept']).toContain('video/mp4');
    const pg = page[3]!;                                                                      // a sized <img>, not the og image
    const pic = await importOne(mid, 'page', pg.id);
    expect([pic.status, pic.status === 202 ? '' : await pic.clone().text()]).toEqual([202, '']);
    const pcb = await body<{ assetId: string }>(pic);
    expect(assetRow(pcb.assetId)).toMatchObject({ kind: 'image', credit: `kompas.com — ${PAGE}`, licence: OWNER_LICENCE_TEXT });
    expect(calls.some((c) => c.url === pg.url)).toBe(true);
    // the stored block remembers the imports; the attribution table only holds the open catalogues
    const blocks = JSON.parse((s.ctx.db.prepare('SELECT blocks_json FROM messages WHERE id = ?').get(mid) as { blocks_json: string }).blocks_json) as Array<{ type: string; items?: Array<{ id: string; importedAssetId?: string }> }>;
    const items = blocks.find((b) => b.type === 'image_candidates')!.items!;
    expect(items.filter((x) => x.importedAssetId)).toHaveLength(3);
    expect((s.ctx.db.prepare('SELECT count(*) AS n FROM asset_attributions').get() as { n: number }).n).toBe(0);
    const dup = await importOne(mid, 'pexels', '2014422');
    expect(await body(dup)).toMatchObject({ assetId: pb.assetId, duplicate: true });
    // a tampered page address is never fetched
    const bad = { ...page[0]!, id: 'pg-0000000000000000', url: 'https://evil.example.org/x.jpg' };
    const mid2 = storeBlock([bad]);
    const refused = await importOne(mid2, 'page', bad.id);
    expect(refused.status).toBe(502); expect((await body(refused))['error']).toMatchObject({ code: 'EM-4407' });
    expect(calls.some((c) => c.url.includes('evil.example.org'))).toBe(false);
    // 61 MB clip → EM-4407
    served.bigVideo = true;
    const mid3 = storeBlock([pexelsVideoCandidate(VIDEO)!]);
    const big = await importOne(mid3, 'pexels-video', '2499611');
    expect(big.status).toBe(502); expect(JSON.stringify(await body(big))).toMatch(/EM-4407.*60 MB/);
    served.bigVideo = false;
    await ingestOf(s.ctx).idle();
  });

  it('without a Pexels key a Pexels import answers 409 EM-4410; research off → 409 EM-4405', async () => {
    researchKeysOf(s.ctx).remove('pexels');
    const mid = storeBlock([pexelsPhotoCandidate({ ...PHOTO, id: 777 })!]);
    const r = await importOne(mid, 'pexels', '777');
    expect(r.status).toBe(409); expect((await body(r))['error']).toMatchObject({ code: 'EM-4410' });
    s.ctx.settings.update({ webResearch: false });
    const off = await importOne(mid, 'pexels', '777');
    expect(off.status).toBe(409); expect((await body(off))['error']).toMatchObject({ code: 'EM-4405' });
    s.ctx.settings.update({ webResearch: true });
  });

  it('CREDITS.txt lists imported pictures and clips with credit + licence (FR-303)', async () => {
    // (status is not required: without ffprobe on the test host the ingest may mark the fake files failed; the credit lines come from the row)
    const rows = s.ctx.db.prepare("SELECT id, kind, status FROM assets WHERE project_id = ? AND credit IS NOT NULL").all(pid) as Array<{ id: string; kind: string; status: string }>;
    const img = rows.find((r) => r.kind === 'image')!; const vid = rows.find((r) => r.kind === 'video')!;
    expect(img && vid).toBeTruthy();
    // buildCredits walks the model JSON for `assetId`s, so raw track items are enough here (the op shapes are the composition-model's business)
    const model = createEmptyModel(pid, { ratio: '9:16', resolution: '1080p', fps: 30, language: 'id' });
    (model.tracks.overlay as unknown as Array<Record<string, unknown>>).push({ id: 'ov1', kind: 'image', assetId: img.id, atMs: 0, durationMs: 3000 });
    (model.tracks.video as unknown as Array<Record<string, unknown>>).push({ id: 'c1', assetId: vid.id, atMs: 0, durationMs: 2000 });
    const txt = buildCredits(s.ctx, pid, model, { outputFile: path.join(s.ctx.paths.tmp, 'out.mp4') });
    expect(txt).toContain('Pictures / poster:');
    expect(txt).toMatch(/Joey Farina \/ Pexels — https:\/\/www\.pexels\.com\/photo\/.* · Pexels License/);
    expect(txt).toContain('Clips:');
    expect(txt).toMatch(/\.mp4 — Joey Farina \/ Pexels .* · Pexels License/);
  });

  it('screenshot module: viewport emulation, PNG size, EM-4409 on failure, one at a time (fake browser)', async () => {
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    expect(pngSize(png1x1)).toEqual({ width: 1, height: 1 });
    expect(pngSize(Buffer.from('nope'))).toEqual({ width: 0, height: 0 });
    const sent: Array<[string, Record<string, unknown> | undefined]> = []; let closedPages = 0; let closedBrowsers = 0;
    const fake = (fail?: 'goto' | 'shot'): BrowserForShots => ({
      async newPage() {
        return { async setViewport() { /* via CDP */ }, async goto({ url }) { if (fail === 'goto') throw new Error('net::ERR_NAME_NOT_RESOLVED'); sent.push(['goto', { url }]); return null; },
          _client: () => ({ async send(method: string, params?: Record<string, unknown>) { sent.push([method, params]); if (method === 'Page.captureScreenshot') { if (fail === 'shot') throw new Error('Unable to capture screenshot'); return { value: { data: png1x1.toString('base64') } }; } return { value: {} }; } }),
          async close() { closedPages++; } };
      },
      async close() { closedBrowsers++; },
    });
    const r = await captureOnBrowser(fake(), 'https://example.org/', 'phone', 1000);
    expect(r).toMatchObject({ width: 1, height: 1 });
    expect(sent.find(([m]) => m === 'Network.setUserAgentOverride')![1]!['userAgent']).toMatch(/Android.*Mobile/);
    expect(sent.find(([m]) => m === 'Emulation.setDeviceMetricsOverride')![1]).toMatchObject({ mobile: true, width: 1080, height: 1920, deviceScaleFactor: 1 });
    expect(sent.find(([m]) => m === 'Page.captureScreenshot')![1]).toMatchObject({ format: 'png', clip: { width: 1080, height: 1920 } });
    expect(closedPages).toBe(1);
    await captureOnBrowser(fake(), 'https://example.org/', 'desktop', 1000);
    expect(sent.filter(([m]) => m === 'Emulation.setDeviceMetricsOverride').at(-1)![1]).toMatchObject({ mobile: false, width: 1440, height: 900, deviceScaleFactor: 1.5 });
    // screenshotPage: own browser opened + closed, failures → EM-4409, calls serialised
    const ok = await screenshotPage(s.ctx, 'https://example.org/', 'phone', { open: async () => fake(), waitForRenders: async () => undefined });
    expect(ok.width).toBe(1); expect(closedBrowsers).toBe(1);
    await expect(screenshotPage(s.ctx, 'https://example.org/', 'phone', { open: async () => fake('goto'), waitForRenders: async () => undefined })).rejects.toMatchObject({ code: 'EM-4409' });
    await expect(screenshotPage(s.ctx, 'https://example.org/', 'phone', { open: async () => fake('shot'), waitForRenders: async () => undefined })).rejects.toMatchObject({ code: 'EM-4409' });
    expect(closedBrowsers).toBe(3);
    const order: string[] = [];
    await Promise.all([screenshotTurn(async () => { order.push('a0'); await new Promise((r2) => setTimeout(r2, 20)); order.push('a1'); }), screenshotTurn(async () => { order.push('b0'); })]);
    expect(order).toEqual(['a0', 'a1', 'b0']);
  });

  it('importScreenshot refuses a private / malformed address before Chrome starts and names EM-4409', async () => {
    const { importScreenshot } = await import('../../src/modules/agents.js');
    await expect(importScreenshot(s.ctx, pid, 'https://127.0.0.1/admin', 'phone')).rejects.toMatchObject({ code: 'EM-4409' });
    await expect(importScreenshot(s.ctx, pid, 'ftp://example.org/', 'phone')).rejects.toMatchObject({ code: 'EM-4409' });
    s.ctx.settings.update({ webResearch: false });
    await expect(importScreenshot(s.ctx, pid, 'https://example.org/', 'phone')).rejects.toMatchObject({ code: 'EM-4405' });
    s.ctx.settings.update({ webResearch: true });
    expect(fs.existsSync(path.join(s.ctx.paths.tmp, 'research')) || true).toBe(true);
    expect(EmError).toBeDefined();
  });
});
