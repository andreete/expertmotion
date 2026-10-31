// composition.frames (FR-310 … FR-312, ADR-041 addendum): "see the preview". Stills of the CURRENT head Composition Model — the
// project as the Creator sees it in the Player — at the given composition times (default: the middle of every clip / scene, at
// most PREVIEW_FRAMES_MAX) rendered with the Engine still renderer (the Export "Gambar PNG" / cover path, FR-289) at a 720p
// composition scale, tiled by ffmpeg into one small JPEG contact sheet (cells ≤ PREVIEW_CELL_WIDTH px wide, like `media.frames`
// does for footage). The runner lifts `imageBase64` into an image part for vision models; every model also gets `onScreen`: what the
// model says is on screen at each time (clip / scene, texts, pictures, shapes, caption page), computed deterministically here.
// One Chrome at a time: the stills run inside the web.screenshot turn, after the render queue is idle, and under the heavy lock
// (renderStill). 60 s in total; any failure is EM-4412. The same (versionId, times) is rendered once per agent run (handler cache).
import fs from 'node:fs';
import path from 'node:path';
import { EmError, errorMessage } from '@expertmotion/shared';
import { deriveTiming, type AssetFacts, type CompositionModelT } from '@expertmotion/composition-model';
import type { ServiceContext } from '../context.js';
import { generatorsServiceOf } from '../s2/generators-service.js';
import { renderServiceOf } from '../s2/render-service.js';
import { runTool } from '../s2/proc.js';
import { screenshotTurn } from './screenshot.js';

export const PREVIEW_FRAMES_MAX = 6;
/** Contact-sheet cell width (px); the height follows the composition ratio. */
export const PREVIEW_CELL_WIDTH = 360;
/** Whole tool call: waiting for renders + every still + the tile pass. */
export const PREVIEW_TOTAL_TIMEOUT_MS = 60_000;
export const PREVIEW_RENDER_WAIT_MS = 30_000;
/** A sheet above this is not sent as an image (the result says so); six 360 px cells are ~100 KB. */
export const PREVIEW_IMAGE_MAX_BYTES = 1_500_000;

export interface PreviewFramesInput { atMs?: number[]; scenes?: boolean }
export interface OnScreen {
  atMs: number;
  /** m:ss of `atMs`. */
  clock: string;
  /** The clip playing at `atMs` (0-based index as in composition.video), its scene background preset or asset name; null outside every clip. */
  clip: { index: number; id: string; scene?: string; asset?: string } | null;
  /** A transition in progress at `atMs` (preset id). */
  transition?: string;
  texts: Array<{ id: string; variant: string; text: string }>;
  /** Images, videos and shapes in front of the clip (overlay track), back to front. */
  pictures: Array<{ id: string; kind: string; asset?: string; preset?: string }>;
  caption: string | null;
}
export interface PreviewSheet {
  versionId: string;
  /** Size of one still (the composition at the 720p scale) and of the sheet. */
  frame: { width: number; height: number };
  cols: number; rows: number;
  cells: Array<{ atMs: number; clock: string; x: number; y: number; w: number; h: number }>;
  onScreen: OnScreen[];
  /** One line per cell, for models without image input (and as a cross-check for the others). */
  summary: string[];
  mediaType: 'image/jpeg';
  imageBase64?: string;
  note?: string;
}
export interface PreviewDeps {
  /** Renders one still of `model` at `frameMs` into `outPath` (JPEG). Default: the Engine still renderer under the heavy lock. */
  renderStill?: (model: CompositionModelT, frameMs: number, outPath: string, signal: AbortSignal) => Promise<void>;
  /** Waits for the render queue to go idle (default: renderServiceOf(ctx).idle()). */
  waitForRenders?: () => Promise<void>;
  signal?: AbortSignal;
}

export const clockOf = (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Middle of every clip (composition time); more than `max` clips → `max` clips spread evenly over the sequence. */
export function sceneMiddles(model: CompositionModelT, max = PREVIEW_FRAMES_MAX): number[] {
  const t = deriveTiming(model);
  const mids = model.tracks.video.map((c, i) => Math.round(t.clipStartMs[i]! + c.durationMs / 2));
  if (!mids.length) return t.durationMs > 0 ? [Math.floor(t.durationMs / 2)] : [0];
  if (mids.length <= max) return mids;
  const picked = new Set<number>();
  for (let k = 0; k < max; k++) picked.add(mids[Math.round((k * (mids.length - 1)) / (max - 1))]!);
  return [...picked];
}
/** The times a `composition.frames` call looks at: `atMs` (clamped into the video) plus the scene middles when asked or when no times were given; unique, sorted, ≤ max. */
export function previewFrameTimes(model: CompositionModelT, input: PreviewFramesInput, max = PREVIEW_FRAMES_MAX): number[] {
  const end = Math.max(0, deriveTiming(model).durationMs - 1);
  const given = (input.atMs ?? []).filter((x) => Number.isFinite(x)).map((x) => Math.min(end, Math.max(0, Math.round(x))));
  const times = given.length && !input.scenes ? given : [...given, ...sceneMiddles(model, max)];
  return [...new Set(times)].sort((a, b) => a - b).slice(0, max);
}

const inWindow = (t: number, atMs: number, durationMs: number) => t >= atMs && t < atMs + durationMs;
/** What the Composition Model puts on screen at `atMs` (deterministic; no rendering). */
export function onScreenAt(model: CompositionModelT, atMs: number, assets: readonly AssetFacts[] = []): OnScreen {
  const names = new Map(assets.map((a) => [a.id, a.name ?? a.id]));
  const t = deriveTiming(model);
  let clip: OnScreen['clip'] = null; let transition: string | undefined;
  model.tracks.video.forEach((c, i) => {
    const start = t.clipStartMs[i]!;
    if (!clip && inWindow(atMs, start, c.durationMs)) clip = { index: i, id: c.id, ...(c.scene ? { scene: c.scene.presetId } : {}), ...(c.assetId ? { asset: names.get(c.assetId) ?? c.assetId } : {}) };
    if (i > 0) { const tr = model.transitions.find((x) => x.cutIndex === i - 1); if (tr && Math.abs(atMs - start) < tr.durationMs) transition = tr.presetId; }
  });
  const texts = model.tracks.text.filter((x) => inWindow(atMs, x.timing.atMs, x.timing.durationMs)).sort((a, b) => a.layer - b.layer)
    .map((x) => ({ id: x.id, variant: x.variantId.replace(/^preset:text\./, ''), text: x.text.length > 120 ? `${x.text.slice(0, 117)}…` : x.text }));
  const pictures = model.tracks.overlay.filter((o) => inWindow(atMs, o.timing.atMs, o.timing.durationMs)).sort((a, b) => a.layer - b.layer)
    .map((o) => ({ id: o.id, kind: o.kind, ...(o.kind === 'shape' ? { preset: o.presetId } : { asset: names.get(o.assetId) ?? o.assetId }) }));
  const page = model.tracks.caption.pages.find((p) => inWindow(atMs, p.startMs, p.durationMs));
  return { atMs, clock: clockOf(atMs), clip, ...(transition ? { transition } : {}), texts, pictures, caption: page ? page.text.trim() : null };
}
/** One readable line of an OnScreen entry (the model without image input reads these). */
export function describeOnScreen(o: OnScreen): string {
  const q = (s: string) => `'${s.replace(/\s+/g, ' ')}'`;
  const where = o.clip ? `clip ${o.clip.index + 1}${o.clip.scene ? ` (scene ${o.clip.scene.replace(/^preset:background\./, 'background.')})` : o.clip.asset ? ` (${o.clip.asset})` : ''}` : 'no clip (empty frame)';
  const parts = [
    o.texts.length ? `texts: ${o.texts.map((x) => `${x.variant} ${q(x.text)}`).join(', ')}` : 'no text',
    o.pictures.length ? `pictures: ${o.pictures.map((p) => (p.kind === 'shape' ? `shape ${p.preset ?? ''}`.trim() : `${p.kind} ${p.asset ?? ''}`.trim())).join(', ')}` : null,
    o.caption ? `caption ${q(o.caption)}` : null,
    o.transition ? `transition ${o.transition}` : null,
  ].filter((x): x is string => !!x);
  return `${o.clock} — ${where}; ${parts.join('; ')}`;
}

/** Width / height of a baseline or progressive JPEG (SOF0 … SOF2 marker). */
export function jpegSize(buf: Buffer): { width: number; height: number } {
  let o = 2;
  while (o + 9 < buf.length) {
    if (buf[o] !== 0xff) { o++; continue; }
    const marker = buf[o + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
    const len = buf.readUInt16BE(o + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
    o += 2 + len;
  }
  throw new Error('not a JPEG');
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> => new Promise<T>((resolve, reject) => {
  const h = setTimeout(() => { onTimeout?.(); reject(new Error(`timed out ${what} after ${ms} ms`)); }, ms); h.unref?.();
  p.then((v) => { clearTimeout(h); resolve(v); }, (e) => { clearTimeout(h); reject(e); });
});

/** The Engine still renderer (FR-289) on a copy of the model at the 720p composition scale (cheap; the picture is the same). */
export function previewModel(model: CompositionModelT): CompositionModelT {
  const m = structuredClone(model);
  m.settings.resolution = '720p';
  return m;
}

/**
 * Renders the contact sheet of `model` (the head Composition Model, `versionId`) at `times`. Serialised with web.screenshot and
 * the render queue (one Chrome at a time); PREVIEW_TOTAL_TIMEOUT_MS in total; every failure is EM-4412.
 */
export async function previewFrames(ctx: ServiceContext, projectId: string, head: { model: CompositionModelT; versionId: string }, times: number[], assets: readonly AssetFacts[] = [], deps: PreviewDeps = {}): Promise<PreviewSheet> {
  if (!times.length) throw new EmError('EM-9002', 'Invalid request: no times.', { status: 400, path: 'body.atMs' });
  const onScreen = times.map((t) => onScreenAt(head.model, t, assets));
  const summary = onScreen.map(describeOnScreen);
  const t0 = Date.now();
  return screenshotTurn(async () => {
    const ac = new AbortController();
    deps.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    const dir = path.join(ctx.paths.tmp, `preview-${ctx.newId()}`); fs.mkdirSync(dir, { recursive: true });
    try {
      const work = (async () => {
        await withTimeout(deps.waitForRenders ? deps.waitForRenders() : renderServiceOf(ctx).idle(), PREVIEW_RENDER_WAIT_MS, 'waiting for the running render');
        const model = previewModel(head.model);
        const render = deps.renderStill ?? ((m, frameMs, outPath, signal) => generatorsServiceOf(ctx).renderStill(projectId, m, frameMs, outPath, 'jpeg', signal));
        for (const [i, t] of times.entries()) {
          if (ac.signal.aborted) throw new Error('cancelled');
          await render(model, t, path.join(dir, `f-${String(i + 1).padStart(2, '0')}.jpg`), ac.signal);
        }
        const first = jpegSize(fs.readFileSync(path.join(dir, 'f-01.jpg')));
        const cw = Math.min(PREVIEW_CELL_WIDTH, Math.floor(first.width / 2) * 2);
        const ch = Math.max(2, Math.round((cw * first.height) / first.width / 2) * 2);
        const cols = Math.ceil(Math.sqrt(times.length)), rows = Math.ceil(times.length / cols);
        const sheet = path.join(dir, 'sheet.jpg');
        // one frame = a scale pass only; several = the `tile` filter of the product's full ffmpeg (the same as media.frames; Remotion's minimal ffmpeg has no tile)
        const vf = times.length === 1 ? `scale=${cw}:${ch}` : `scale=${cw}:${ch},tile=${cols}x${rows}`;
        await runTool({ exe: ctx.resources.ffmpeg, args: ['-v', 'error', '-nostdin', '-y', '-threads', '2', '-framerate', '1', '-i', path.join(dir, 'f-%02d.jpg'), '-vf', vf, '-frames:v', '1', '-q:v', '5', sheet], cwd: dir, timeoutMs: 30_000, signal: ac.signal });
        const buf = fs.readFileSync(sheet);
        const tooBig = buf.length > PREVIEW_IMAGE_MAX_BYTES;
        ctx.log.info({ projectId, versionId: head.versionId, frames: times.length, bytes: buf.length, ms: Date.now() - t0 }, 'composition.frames captured');
        return { versionId: head.versionId, frame: first, cols, rows, cells: times.map((atMs, i) => ({ atMs, clock: clockOf(atMs), x: (i % cols) * cw, y: Math.floor(i / cols) * ch, w: cw, h: ch })), onScreen, summary, mediaType: 'image/jpeg' as const,
          ...(tooBig ? { note: 'The contact sheet is larger than 1.5 MB; ask for fewer frames.' } : { imageBase64: buf.toString('base64') }) };
      })();
      return await withTimeout(work, PREVIEW_TOTAL_TIMEOUT_MS, 'capturing the preview', () => ac.abort());
    } catch (e) {
      if (e instanceof EmError && e.code === 'EM-8202') throw e;
      const tail = Array.isArray((e as { stderrTail?: unknown })?.stderrTail) ? ` ${((e as { stderrTail: string[] }).stderrTail).slice(-2).join(' ')}` : '';
      const why = `${errorMessage(e)}${tail}`.replace(/\s+/g, ' ').slice(0, 200);
      ctx.log.warn({ projectId, versionId: head.versionId, frames: times.length, ms: Date.now() - t0, err: why }, 'composition.frames failed');
      throw new EmError('EM-4412', 'The preview could not be captured.', { details: { frames: times.length, reason: why }, cause: e });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

/**
 * The `composition.frames` tool handler for one agent run (both agents). Reads the head through `ctx.hooks.composition`; the same
 * (versionId, times) is rendered once per run (cache in this closure); failures come back as `{error}` tool results, never throws.
 */
export function previewFramesTool(ctx: ServiceContext, projectId: string, deps: PreviewDeps = {}): (input: Record<string, unknown>) => Promise<unknown> {
  const cache = new Map<string, PreviewSheet>();
  return async (i) => {
    let head: { model: CompositionModelT; versionId: string };
    try { head = ctx.hooks.composition(projectId); } catch { return { error: { code: 'EM-9003', message: 'This project has no video yet.' } }; }
    const atMs = Array.isArray(i['atMs']) ? (i['atMs'] as unknown[]).filter((x): x is number => typeof x === 'number') : typeof i['atMs'] === 'number' ? [i['atMs']] : [];
    const times = previewFrameTimes(head.model, { atMs, ...(i['scenes'] === true ? { scenes: true } : {}) });
    const key = `${head.versionId}|${times.join(',')}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let assets: AssetFacts[] = [];
    try { assets = ctx.hooks.assetFacts(projectId); } catch { /* names optional */ }
    try {
      const sheet = await previewFrames(ctx, projectId, head, times, assets, deps);
      cache.set(key, sheet);
      return sheet;
    } catch (e) {
      const reason = e instanceof EmError && e.details && typeof (e.details as { reason?: unknown }).reason === 'string' ? ` (${(e.details as { reason: string }).reason})` : '';
      return { error: { code: e instanceof EmError ? e.code : 'EM-4412', message: `${errorMessage(e)}${reason}`.slice(0, 400) }, onScreen: times.map((t) => onScreenAt(head.model, t, assets)), summary: times.map((t) => describeOnScreen(onScreenAt(head.model, t, assets))) };
    }
  };
}
