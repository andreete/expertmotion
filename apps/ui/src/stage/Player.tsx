// Player (stage.player.*): Remotion <Player> rendering ExpertmotionTimeline with inputProps = current Composition Model +
// media URLs from the preview media grant (ported Preview: fit-to-box sizing, safe-area overlay, draft/full, indicators).
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Player as RemotionPlayer, type PlayerRef } from '@remotion/player';
import { ChevronLeft, ChevronRight, Maximize, Menu, MessageSquare, Minimize, Pause, Play, RefreshCw, Sparkles, Upload } from 'lucide-react';
import { ExpertmotionTimeline, calculateMetadata, safeAreaFor, type AssetUrls, type EngineInputProps } from '@expertmotion/engine';
import { applyOperations, deriveTiming, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { compileDefaults, getPreset } from '@expertmotion/catalogue';
import { newId } from '@expertmotion/shared';
import { useStore } from '../state/store.js';
import { Button, IconButton, MenuItem, Popover, cx } from '../components/ui.js';
import { formatTimecode } from '../i18n/index.js';
import { playerBus } from './playerBus.js';
import { CanvasHandles, type CanvasGesture } from './CanvasHandles.js';
import { ItemMenu, type ItemMenuAnchor } from './ItemMenu.js';
import { RecentStrip } from '../screens/StartScreen.js';
import { canvasItemOf, transformEditOf, withLiveTransform, type Xf } from './canvas-transform.js';
import { playerPrefsFor, playerPrefsPatch, type PlayerPrefs } from '../prefs.js';
import type { AppState } from '../state/reducer.js';
import type { ApiClient } from '../api/client.js';

const Timeline = ExpertmotionTimeline as unknown as ComponentType<Record<string, unknown>>;

/** EngineInputProps.assets from AssetDto availability flags + the preview grant (API_SPECIFICATION.md §2.2). */
export function buildAssetUrls(state: AppState, api: ApiClient): Record<string, AssetUrls> {
  const out: Record<string, AssetUrls> = {};
  const grant = state.grant;
  if (!grant) return out;
  for (const a of state.assets) {
    if (a.status !== 'ready' || a.kind === 'subtitle' || !a.media.playable || a.missing) continue;   // FR-048: missing → placeholder frame
    out[a.id] = {
      kind: a.kind, playable: api.mediaUrl(grant, a.id, 'playable'),
      ...(a.media.proxy ? { proxy: api.mediaUrl(grant, a.id, 'proxy') } : {}),
      ...(a.durationMs !== null ? { durationMs: a.durationMs } : {}), ...(a.width !== null ? { width: a.width } : {}),
      ...(a.height !== null ? { height: a.height } : {}), ...(a.hasAudio !== null ? { hasAudio: a.hasAudio } : {}),
    };
  }
  return out;
}

/**
 * Transient hover preview (IX-01, ADR-011): the preset's Compile defaults applied to a throw-away copy of the current
 * version, shown only in the Player and never sent anywhere. The Local Service remains the only writer of the model.
 */
export function previewModel(model: CompositionModelT, presetId: string, state: AppState): CompositionModelT | null {
  const p = getPreset(presetId);
  const cd = compileDefaults(presetId);
  if (!p || !cd) return null;
  const project = { kind: 'project' as const };
  let ops: OperationT[] = [];
  const clipAt = (() => { const t = deriveTiming(model); return model.tracks.video.find((c) => { const w = t.elementWindows[c.id]; return w && state.playheadMs >= w.fromMs && state.playheadMs < w.toMs; }) ?? model.tracks.video[0]; })();
  switch (p.category) {
    case 'transition': {
      // FR-033: preview on the current selection (selected cuts / the cut after a selected clip), else every cut.
      const cuts = state.selection.flatMap((s) => (s.kind === 'cut' && s.index !== undefined ? [s.index] : s.kind === 'clip' ? (() => { const i = model.tracks.video.findIndex((c) => c.id === s.id); return i >= 0 && i < model.tracks.video.length - 1 ? [i] : []; })() : []));
      const list = cuts.length ? [...new Set(cuts)] : model.tracks.video.slice(0, -1).map((_, i) => i);
      ops = list.map((index) => ({ op: cd.op, target: { kind: 'cut' as const, index }, args: cd.args })); break;
    }
    case 'caption': case 'background': case 'easing': case 'palette': case 'fontpair': case 'font': ops = [{ op: cd.op, target: project, args: cd.args }]; break;
    case 'motion': case 'effect': {
      const kinds = p.category === 'motion' ? ['clip', 'text', 'shape'] : ['clip'];
      const chosen = state.selection.filter((s) => kinds.includes(s.kind) && s.id);
      if (chosen.length) ops = chosen.map((s) => ({ op: cd.op, target: { kind: s.kind, id: s.id! }, args: cd.args }));
      else if (clipAt) ops = [{ op: cd.op, target: { kind: 'clip', id: clipAt.id }, args: cd.args }];
      break;
    }
    case 'texteffect': {
      const texts = state.selection.filter((s) => s.kind === 'text' && s.id);
      ops = texts.map((s) => ({ op: cd.op, target: { kind: 'text' as const, id: s.id! }, args: cd.args }));
      break;
    }
    case 'shape': ops = [{ op: cd.op, args: { ...cd.args, atMs: state.playheadMs } }]; break;
    case 'text': ops = [{ op: cd.op, args: { ...cd.args, text: p.label.en, atMs: state.playheadMs } }]; break;
    default: return null;
  }
  if (!ops.length) return null;
  const facts = state.assets.map((a) => ({ id: a.id, kind: a.kind, status: a.status, ...(a.durationMs !== null ? { durationMs: a.durationMs } : {}), ...(a.width !== null ? { width: a.width } : {}), ...(a.height !== null ? { height: a.height } : {}) }));
  let base = model;
  if (p.category === 'caption' && !model.tracks.caption.pages.length) {
    base = structuredClone(model);
    base.tracks.caption.pages = [{ text: p.label.id, startMs: 0, durationMs: Math.max(1000, deriveTiming(model).durationMs), tokens: [] }];
  }
  const r = applyOperations(base, ops, { assets: facts, tier: state.hardware?.tier ?? 'T0', newId });
  return r.ok ? r.value.model : null;
}

/** Nothing to show: no clips, texts, overlays, captions, audio or background (QA 2026-10-25: empty state, not a spinner). */
export function isEmptyComposition(m: CompositionModelT): boolean {
  const t = m.tracks;
  return t.video.length === 0 && t.text.length === 0 && t.overlay.length === 0 && t.audio.length === 0 && t.caption.pages.length === 0 && !m.background;
}

/** Why the Player is still waiting for a composition (logged when it takes longer than usual). */
export function previewWaitCause(state: Pick<AppState, 'project' | 'head' | 'headLoading' | 'grant'>): string {
  if (!state.project) return 'no-project';
  if (state.headLoading) return 'head-loading';
  if (!state.head) return 'head-missing';
  if (!state.head.model) return 'head-without-model';
  return 'metadata';
}
export const SLOW_PREVIEW_MS = 8000;

export function StagePlayer() {
  const { state, actions, runtime, t, lang, prefs, setPrefs, dispatch } = useStore();
  const stateRef = useRef(state);
  stateRef.current = state;
  const ref = useRef<PlayerRef>(null);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [isFull, setIsFull] = useState(false);
  const [size, setSize] = useState({ w: 640, h: 360 });
  const [playing, setPlaying] = useState(false);
  // QA UX round 1: the time display starts at the settled playhead — it read 00:00 after a remount while the Timeline playhead
  // stayed at the end (and `ended` below settles all three at the last frame).
  const [ms, setMs] = useState(state.playheadMs);
  const [menu, setMenu] = useState(false);
  const [remountKey, setRemountKey] = useState(0);
  const [slow, setSlow] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const pid = state.project?.id;
  const pp = playerPrefsFor(prefs, pid);                                       // FR-060: per-Project Player choices
  const setPlayer = (patch: Partial<PlayerPrefs>) => setPrefs(playerPrefsPatch(prefs, pid, patch));
  const head = state.head?.model;
  const hasClip = (head?.tracks.video.length ?? 0) > 0;
  const turbo = state.performanceProfile === 'turbo';
  const draft = !turbo && pp.draft;
  const assets = useMemo(() => buildAssetUrls(state, runtime.api), [state.assets, state.grant, runtime.api]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => (head && state.previewPresetId ? previewModel(head, state.previewPresetId, state) : null), [head, state.previewPresetId]); // eslint-disable-line react-hooks/exhaustive-deps
  // ADR-028 / FR-180: canvas handles for the selected clip / image / shape; `live` is the optimistic transform of a running gesture.
  const [live, setLive] = useState<{ id: string; xf: Xf } | null>(null);
  const [itemMenu, setItemMenu] = useState<ItemMenuAnchor | null>(null);   // ADR-031: right-click on the canvas box
  const canvasItem = useMemo(() => (head && !preview && state.selection.length === 1 ? canvasItemOf(head, state.selection[0], (id) => { const a = state.assets.find((x) => x.id === id); return a ? { width: a.width, height: a.height } : null; }) : null),
    [head, preview, state.selection, state.assets]);
  useEffect(() => { setLive(null); }, [state.head?.hash, canvasItem?.id]);
  const liveXf = live && canvasItem && live.id === canvasItem.id ? live.xf : null;
  const base = preview ?? head ?? null;
  const model = useMemo(() => (base && canvasItem && liveXf ? withLiveTransform(base, canvasItem, liveXf) : base), [base, canvasItem, liveXf]);
  const inputProps = useMemo<EngineInputProps | null>(() => (model ? { model, assets, quality: draft ? 'draft' : 'full' } : null), [model, assets, draft]);
  const meta = useMemo(() => (inputProps ? calculateMetadata({ props: inputProps }) : null), [inputProps]);
  const fps = meta?.fps ?? 30;
  const durationMs = meta ? (meta.durationInFrames / meta.fps) * 1000 : 0;
  const exportDims = useMemo(() => (model ? calculateMetadata({ props: { model, assets: {}, quality: 'full' } }) : null), [model]);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => { if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // FR-059: fullscreen the whole Player frame so our own controls stay visible as an overlay; Escape exits (browser).
  useEffect(() => {
    const on = () => setIsFull(typeof document !== 'undefined' && document.fullscreenElement === frame.current && frame.current !== null);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFullscreen = () => {
    if (typeof document === 'undefined') return;
    if (document.fullscreenElement) { void document.exitFullscreen?.().catch(() => undefined); return; }
    const el = frame.current;
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
  };
  const fullRef = useRef(toggleFullscreen);
  fullRef.current = toggleFullscreen;
  // "Taking longer than usual" after 8 s without a composition: offer Retry and log the cause (Shell log via the [em] tag).
  const [retryNonce, setRetryNonce] = useState(0);
  useEffect(() => {
    if (head || !pid) { setSlow(false); return; }
    const h = setTimeout(() => {
      setSlow(true);
      console.warn(`[em] player: preview still loading after ${SLOW_PREVIEW_MS / 1000} s (${previewWaitCause(stateRef.current)})`, { projectId: stateRef.current.project?.id ?? null, headId: stateRef.current.head?.id ?? null });
    }, SLOW_PREVIEW_MS);
    return () => clearTimeout(h);
  }, [head, pid, retryNonce]);
  const retryLoad = () => { setSlow(false); setRetryNonce((n) => n + 1); void actions.refreshHead(); if (pid) void runtime.api.issueMediaGrant(pid).then((g) => dispatch({ type: 'grant', grant: g })).catch(() => undefined); };
  const empty = !!head && !preview && isEmptyComposition(head);

  // Player events → local time + live bus; settled playhead → store.
  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) => { const v = (e.detail.frame / fps) * 1000; setMs(v); playerBus.emit(v); };
    const onPlay = () => setPlaying(true);
    const onPause = () => { setPlaying(false); actions.seek((p.getCurrentFrame() / fps) * 1000); };
    const onSeek = (e: { detail: { frame: number } }) => { const v = (e.detail.frame / fps) * 1000; setMs(v); playerBus.emit(v); if (!p.isPlaying()) actions.seek(v); };
    const onWaiting = () => setBuffering(true), onResume = () => setBuffering(false);   // FR-061: media still loading
    // QA UX round 1: playback reaching the end settles the playhead there (time display, Timeline and store agree)
    const onEnded = () => { setPlaying(false); const v = (p.getCurrentFrame() / fps) * 1000; setMs(v); playerBus.emit(v); actions.seek(v); };
    p.addEventListener('ended', onEnded);
    p.addEventListener('waiting', onWaiting);
    p.addEventListener('resume', onResume);
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    p.addEventListener('seeked', onSeek);
    return () => { p.removeEventListener('ended', onEnded); p.removeEventListener('waiting', onWaiting); p.removeEventListener('resume', onResume); p.removeEventListener('frameupdate', onFrame); p.removeEventListener('play', onPlay); p.removeEventListener('pause', onPause); p.removeEventListener('seeked', onSeek); };
  }, [fps, actions, meta?.durationInFrames, remountKey, empty, !inputProps]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    playerBus.set({
      toggle: () => ref.current?.toggle(), play: () => ref.current?.play(), pause: () => ref.current?.pause(),
      seekMs: (v) => { const f = Math.max(0, Math.min((meta?.durationInFrames ?? 1) - 1, Math.round((v / 1000) * fps))); ref.current?.seekTo(f); setMs((f / fps) * 1000); playerBus.emit((f / fps) * 1000); actions.seek((f / fps) * 1000); },
      stepFrames: (n) => { const cur = ref.current?.getCurrentFrame() ?? 0; const f = Math.max(0, Math.min((meta?.durationInFrames ?? 1) - 1, cur + n)); ref.current?.seekTo(f); actions.seek((f / fps) * 1000); },
      currentMs: () => ((ref.current?.getCurrentFrame() ?? 0) / fps) * 1000, durationMs: () => durationMs,
      fullscreen: () => fullRef.current(), isPlaying: () => ref.current?.isPlaying() ?? false,
    });
    return () => playerBus.set(null);
  }, [fps, meta?.durationInFrames, durationMs, actions]);

  useEffect(() => { if (pp.muted) ref.current?.mute(); else ref.current?.unmute(); }, [pp.muted, remountKey, empty]);

  const fit = meta ? Math.min((size.w - 32) / meta.width, (size.h - 32) / meta.height) : 1;
  const w = meta ? Math.max(1, Math.floor(meta.width * fit)) : 0, h = meta ? Math.max(1, Math.floor(meta.height * fit)) : 0;
  // Round 2 (QA 2026-10-29 "weight-500 headings look heavier in the Player than in the MP4"): the Player and the export load the
  // same bundled font files and weights (pixel parity at 1080×1920: ≤ 0.5 % of pixels differ). The heavier look came from Chrome
  // rasterising the text AT the preview scale (hinting at ~8 px); the export is rasterised at full size and then shown smaller.
  // `.em-raster` (index.css) gives the Player's scaled container `will-change: transform` (its own compositing layer); measured in
  // Chrome Headless Shell at 270×480 the extra text "ink" against the downscaled export fell from 2.2–5.5 % to 0.2–1.0 %. The class
  // is re-applied after the preview size changes so the layer is rasterised again for the new size.
  const rasterRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rasterRef.current; if (!el) return;
    el.classList.remove('em-raster');
    const id = requestAnimationFrame(() => el.classList.add('em-raster'));
    return () => cancelAnimationFrame(id);
  }, [w, h]);
  const ratio = head?.settings.ratio ?? '16:9';
  const safe = meta && pp.safeArea ? safeAreaFor(ratio, meta.width, meta.height) : null;
  const quality = t(draft ? 'ui.stage.player.quality.draft' : 'ui.stage.player.quality.full');   // FR-058
  const loading = state.headLoading || buffering;
  const reload = () => { void runtime.api.issueMediaGrant(state.project?.id ?? '').then((g) => dispatch({ type: 'grant', grant: g })).catch(() => undefined); setRemountKey((k) => k + 1); };
  const toggleDraft = () => {
    const next = !pp.draft;
    setPlayer({ draft: next });
    if (!next && (state.hardware?.tier ?? 'T0') === 'T0') actions.toast('warn', 'ui.stage.player.menu.full.t0warn');
  };
  const itemLabel = (() => {
    if (!canvasItem || !head) return '';
    if (canvasItem.kind === 'clip') { const i = head.tracks.video.findIndex((c) => c.id === canvasItem.id); return t('ui.stage.player.canvas.clip', { n: i + 1 }); }
    if (canvasItem.kind === 'image') { const o = head.tracks.overlay.find((x) => x.id === canvasItem.id); return o?.kind === 'image' ? state.assets.find((a) => a.id === o.assetId)?.name ?? t('ui.stage.timeline.kind.image') : ''; }
    return t('ui.stage.timeline.kind.shape');
  })();
  const showHandles = !!canvasItem && ms >= canvasItem.fromMs && ms < canvasItem.toMs && !state.headLoading;
  const commitTransform = (xf: Xf, g: CanvasGesture) => {
    if (!canvasItem) return;
    setLive({ id: canvasItem.id, xf });                                         // keep the new picture until the new version arrives
    void actions.transformEdit(transformEditOf(canvasItem, xf), t(`ui.stage.player.canvas.done.${g}`, { label: itemLabel })).finally(() => setLive(null));
  };
  const previewLabel = state.previewPresetId ? getPreset(state.previewPresetId)?.label[lang] : null;
  const version = state.head?.hash.slice(0, 6);
  const ratioLabel = ratio === 'custom' && head?.settings.customRatio ? `${head.settings.customRatio.w}:${head.settings.customRatio.h}` : ratio;

  return (
    <div ref={frame} data-el="stage.player.frame" data-fullscreen={isFull ? 'true' : undefined} className={cx('relative flex min-h-0 flex-1 flex-col overflow-hidden bg-em-panel', isFull ? 'h-full w-full' : 'rounded-[12px] border border-em-line')}>
      <div className="flex h-7 items-center gap-2 border-b border-em-line px-2 text-[12px]">
        <span data-el="stage.player.controls.ratio" className="t-mono" title={t('ui.stage.player.ratio')}>{ratioLabel}</span>
        <span data-el="stage.player.controls.res" className="t-mono text-em-muted" title={t('ui.stage.player.res')}>{exportDims ? `${exportDims.width}×${exportDims.height}` : '—'} · {quality}</span>
        {version && <span className="t-mono text-em-success" title={t('ui.stage.player.version.ok', { version })}>v{version} ✓</span>}
        <span className="flex-1" />
        <span className="relative">
          <IconButton el="stage.player.menu" data-popover-trigger="" label={t('ui.stage.player.menu')} icon={<Menu size={16} />} size={28} onClick={() => setMenu((m) => !m)} />
          {menu && (
            <Popover role="menu" align="right" width={240} onClose={() => setMenu(false)} label={t('ui.stage.player.menu')}>
              <MenuItem el="stage.player.menu.safearea" onClick={() => setPlayer({ safeArea: !pp.safeArea })}>{pp.safeArea ? '✓ ' : ''}{t('ui.stage.player.menu.safearea')}</MenuItem>
              <MenuItem el="stage.player.menu.draft" disabledReason={turbo ? t('ui.stage.player.menu.draft.turbo') : null} onClick={toggleDraft}>{draft ? '✓ ' : ''}{t('ui.stage.player.menu.draft')}</MenuItem>
              <MenuItem el="stage.player.menu.loop" onClick={() => setPlayer({ loop: !pp.loop })}>{pp.loop ? '✓ ' : ''}{t('ui.stage.player.menu.loop')}</MenuItem>
              <MenuItem el="stage.player.menu.mute" onClick={() => setPlayer({ muted: !pp.muted })}>{pp.muted ? '✓ ' : ''}{t('ui.stage.player.menu.mute')}</MenuItem>
              <MenuItem el="stage.player.menu.seekonselect" onClick={() => setPrefs({ seekOnSelect: !prefs.seekOnSelect })}>{prefs.seekOnSelect ? '✓ ' : ''}{t('ui.stage.player.menu.seekonselect')}</MenuItem>
            </Popover>
          )}
        </span>
      </div>
      <div ref={box} data-el="stage.player.canvas" role="region" aria-label={t('a11y.stage.player.canvas')} className="relative flex min-h-0 flex-1 items-center justify-center bg-em-bg"
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const files = [...e.dataTransfer.files]; if (files.length) void actions.upload(files); }}>
        {!pid ? (
          <div data-el="stage.player.state.noproject" role="status" className="flex max-w-[360px] flex-col items-center gap-2 p-4 text-center">
            <span className="text-[14px] font-semibold">{t('ui.stage.player.noproject.title')}</span>
            <span className="text-em-muted">{t('ui.stage.player.noproject.body')}</span>
            <span className="flex gap-2">
              <Button el="stage.player.state.noproject.new" size={28} variant="primary" onClick={() => { void actions.newProject(); }}>{t('ui.hdr.menu.file.new')}</Button>
              <Button el="stage.player.state.noproject.open" size={28} onClick={() => actions.setScreen({ kind: 'project.open' })}>{t('ui.hdr.menu.file.open')}</Button>
            </span>
          </div>
        ) : !inputProps || !meta ? (
          <div data-el="stage.player.state.loading" className="flex flex-col items-center gap-2 text-em-muted" role="status">
            <RefreshCw size={20} className="em-spin" aria-hidden />{t('ui.stage.player.loading')}{slow && <span>{t('ui.stage.player.slow')}</span>}
            {slow && <Button el="stage.player.state.loading.retry" size={28} onClick={retryLoad}>{t('ui.sys.toast.tryagain')}</Button>}
          </div>
        ) : empty ? (
          // FR-263: the empty project pushes the automatic path first (write the idea → the Editor makes the video), footage second
          <div data-el="stage.player.state.empty" role="status" className="flex max-w-[420px] flex-col items-center gap-2 p-4 text-center">
            <Sparkles size={22} className="text-em-accent" aria-hidden />
            <span className="text-[14px] font-semibold">{t('ui.stage.player.empty.auto.title')}</span>
            <span className="text-em-muted">{t('ui.stage.player.empty.auto.body')}</span>
            <span className="flex flex-wrap justify-center gap-2">
              <Button el="stage.player.state.empty.write" size={28} variant="primary" icon={<MessageSquare size={14} />} tip={t('ui.stage.player.empty.write.tip')}
                onClick={() => window.dispatchEvent(new CustomEvent('em:focus-composer', { detail: { agent: 'editor' } }))}>{t('ui.stage.player.empty.write')}</Button>
              <Button el="stage.player.state.empty.import" size={28} icon={<Upload size={14} />} tip={t('ui.stage.player.empty.import.tip')} onClick={() => window.dispatchEvent(new CustomEvent('em:import', { detail: {} }))}>{t('ui.stage.player.empty.import')}</Button>
            </span>
            <RecentStrip />
          </div>
        ) : (
          <div ref={rasterRef} className="relative em-raster" style={{ width: w, height: h }}>
            <RemotionPlayer key={remountKey} ref={ref} component={Timeline} inputProps={inputProps as unknown as Record<string, unknown>}
              durationInFrames={meta.durationInFrames} compositionWidth={meta.width} compositionHeight={meta.height} fps={meta.fps}
              style={{ width: w, height: h, ...(state.headLoading ? { visibility: 'hidden' as const } : {}) }} controls={false} loop={pp.loop} clickToPlay spaceKeyToPlayOrPause={false} acknowledgeRemotionLicense initialFrame={Math.min(meta.durationInFrames - 1, Math.round((state.playheadMs / 1000) * meta.fps))}
              errorFallback={({ error }) => (
                <div data-el="stage.player.state.error" role="alert" className="flex h-full w-full flex-col items-center justify-center gap-2 bg-em-panel p-4 text-center">
                  <span className="font-semibold">{t('ui.stage.player.error')}</span><span className="t-mono text-em-muted">EM-3301</span>
                  <span className="max-w-[320px] truncate text-[11px] text-em-muted">{error.message}</span>
                  <span className="flex gap-2">
                    <Button el="stage.player.state.error.reload" size={28} onClick={reload}>{t('ui.stage.player.rebuild')}</Button>
                    <Button el="stage.player.state.error.recovery" size={28} variant="ghost" onClick={() => actions.setScreen({ kind: 'project.recover' })}>{t('ui.stage.player.openrecovery')}</Button>
                  </span>
                </div>
              )} />
            {loading && (
              <div data-el="stage.player.state.loading" role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-em-bg/80 text-em-muted">
                <RefreshCw size={20} className="em-spin" aria-hidden />{state.headLoading ? t('ui.stage.player.loading.version') : t('ui.stage.player.loading.media')}
              </div>
            )}
            {safe && (
              <div aria-hidden className="pointer-events-none absolute border border-dashed border-em-accent-2/80"
                style={{ left: safe.left * fit, top: safe.top * fit, right: safe.right * fit, bottom: safe.bottom * fit }} />
            )}
            {showHandles && canvasItem && (
              <CanvasHandles item={canvasItem} xf={liveXf ?? canvasItem.xf} screenW={w} label={t('a11y.stage.player.canvas.box', { label: itemLabel })} hint={t('ui.stage.player.canvas.hint')}
                onLive={(xf) => setLive(xf ? { id: canvasItem.id, xf } : null)} onCommit={commitTransform}
                onMenu={(at) => setItemMenu({ ...at, refs: [{ kind: canvasItem.kind, id: canvasItem.id }], source: 'canvas', returnFocus: null })} />
            )}
            {itemMenu && <ItemMenu anchor={itemMenu} onClose={() => setItemMenu(null)} />}
            {previewLabel && <span className="absolute left-2 top-2 rounded-[4px] bg-em-accent px-1.5 text-[11px] font-semibold text-em-accent-ink">{t('ui.stage.player.previewing', { preset: previewLabel })}</span>}
            {previewLabel && !hasClip && <span className="absolute bottom-2 left-2 right-2 rounded-[4px] bg-black/70 px-1.5 text-center text-[11px]">{t('ui.stage.player.sample')}</span>}
            {draft && <span className="absolute bottom-2 right-2 rounded-[4px] bg-black/70 px-1.5 text-[11px]">{t('ui.stage.player.draft')}</span>}
          </div>
        )}
      </div>
      <div data-el="stage.player.controls" className={cx('flex h-10 items-center gap-2 px-2', isFull ? 'absolute inset-x-0 bottom-0 z-10 bg-black/70 text-white' : 'border-t border-em-line')}>
        {playing
          ? <IconButton el="stage.player.controls.pause" label={t('ui.stage.player.pause')} icon={<Pause size={16} />} onClick={() => ref.current?.pause()} />
          : <IconButton el="stage.player.controls.play" label={t('ui.stage.player.play')} icon={<Play size={16} />} onClick={() => ref.current?.play()} disabledReason={meta ? null : t('ui.stage.player.loading')} />}
        <IconButton label={t('ui.stage.player.prevframe')} icon={<ChevronLeft size={16} />} size={28} onClick={() => playerBus.get()?.stepFrames(-1)} />
        <IconButton label={t('ui.stage.player.nextframe')} icon={<ChevronRight size={16} />} size={28} onClick={() => playerBus.get()?.stepFrames(1)} />
        <span data-el="stage.player.controls.time" role="status" aria-live="off" className="t-mono">{formatTimecode(ms, fps)}</span>
        <input data-el="stage.player.controls.scrubber" type="range" role="slider" min={0} max={Math.max(0, (meta?.durationInFrames ?? 1) - 1)} step={1}
          value={Math.round((ms / 1000) * fps)} aria-label={t('a11y.stage.player.scrubber')}
          aria-valuetext={t('a11y.stage.player.scrubber.value', { time: formatTimecode(ms, fps), total: formatTimecode(durationMs, fps) })}
          onChange={(e) => playerBus.get()?.seekMs((Number(e.target.value) / fps) * 1000)} className={cx('h-1 flex-1 accent-[var(--em-accent)]')} />
        <span data-el="stage.player.controls.duration" className="t-mono text-em-muted">{formatTimecode(durationMs, fps)}</span>
        <IconButton el="stage.player.controls.fullscreen" label={t(isFull ? 'ui.stage.player.fullscreen.exit' : 'ui.stage.player.fullscreen')} aria-pressed={isFull} icon={isFull ? <Minimize size={16} /> : <Maximize size={16} />} onClick={toggleFullscreen} />
      </div>
    </div>
  );
}

