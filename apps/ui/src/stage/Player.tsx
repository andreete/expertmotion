// Player (stage.player.*): Remotion <Player> rendering ExpertmotionTimeline with inputProps = current Composition Model +
// media URLs from the preview media grant (ported Preview: fit-to-box sizing, safe-area overlay, draft/full, indicators).
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Player as RemotionPlayer, type PlayerRef } from '@remotion/player';
import { ChevronLeft, ChevronRight, Maximize, Menu, Pause, Play, RefreshCw } from 'lucide-react';
import { ExpertmotionTimeline, calculateMetadata, safeAreaFor, type AssetUrls, type EngineInputProps } from '@expertmotion/engine';
import { applyOperations, deriveTiming, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { compileDefaults, getPreset } from '@expertmotion/catalogue';
import { newId } from '@expertmotion/shared';
import { useStore } from '../state/store.js';
import { Button, IconButton, MenuItem, Popover, cx } from '../components/ui.js';
import { formatTimecode } from '../i18n/index.js';
import { playerBus } from './playerBus.js';
import type { AppState } from '../state/reducer.js';
import type { ApiClient } from '../api/client.js';

const Timeline = ExpertmotionTimeline as unknown as ComponentType<Record<string, unknown>>;

/** EngineInputProps.assets from AssetDto availability flags + the preview grant (API_SPECIFICATION.md §2.2). */
export function buildAssetUrls(state: AppState, api: ApiClient): Record<string, AssetUrls> {
  const out: Record<string, AssetUrls> = {};
  const grant = state.grant;
  if (!grant) return out;
  for (const a of state.assets) {
    if (a.status !== 'ready' || a.kind === 'subtitle' || !a.media.playable) continue;
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
    case 'transition': ops = model.tracks.video.slice(0, -1).map((_, i) => ({ op: cd.op, target: { kind: 'cut' as const, index: i }, args: cd.args })); break;
    case 'caption': case 'background': case 'easing': case 'palette': case 'fontpair': case 'font': ops = [{ op: cd.op, target: project, args: cd.args }]; break;
    case 'motion': case 'effect': if (clipAt) ops = [{ op: cd.op, target: { kind: 'clip', id: clipAt.id }, args: cd.args }]; break;
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

export function StagePlayer() {
  const { state, actions, runtime, t, lang, prefs, setPrefs, dispatch } = useStore();
  const ref = useRef<PlayerRef>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 640, h: 360 });
  const [playing, setPlaying] = useState(false);
  const [ms, setMs] = useState(0);
  const [menu, setMenu] = useState(false);
  const [remountKey, setRemountKey] = useState(0);
  const [slow, setSlow] = useState(false);
  const head = state.head?.model;
  const hasClip = (head?.tracks.video.length ?? 0) > 0;
  const turbo = state.performanceProfile === 'turbo';
  const draft = !turbo && prefs.draft;
  const assets = useMemo(() => buildAssetUrls(state, runtime.api), [state.assets, state.grant, runtime.api]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => (head && state.previewPresetId ? previewModel(head, state.previewPresetId, state) : null), [head, state.previewPresetId]); // eslint-disable-line react-hooks/exhaustive-deps
  const model = preview ?? head ?? null;
  const inputProps = useMemo<EngineInputProps | null>(() => (model ? { model, assets, quality: draft ? 'draft' : 'full', watermark: Boolean(state.licence?.limits.watermark) } : null), [model, assets, draft, state.licence]);
  const meta = useMemo(() => (inputProps ? calculateMetadata({ props: inputProps }) : null), [inputProps]);
  const fps = meta?.fps ?? 30;
  const durationMs = meta ? (meta.durationInFrames / meta.fps) * 1000 : 0;
  const exportDims = useMemo(() => (model ? calculateMetadata({ props: { model, assets: {}, quality: 'full', watermark: false } }) : null), [model]);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => { if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (head) return; const h = setTimeout(() => setSlow(true), 8000); return () => clearTimeout(h); }, [head]);

  // Player events → local time + live bus; settled playhead → store.
  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) => { const v = (e.detail.frame / fps) * 1000; setMs(v); playerBus.emit(v); };
    const onPlay = () => setPlaying(true);
    const onPause = () => { setPlaying(false); actions.seek((p.getCurrentFrame() / fps) * 1000); };
    const onSeek = (e: { detail: { frame: number } }) => { const v = (e.detail.frame / fps) * 1000; setMs(v); playerBus.emit(v); if (!p.isPlaying()) actions.seek(v); };
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    p.addEventListener('seeked', onSeek);
    return () => { p.removeEventListener('frameupdate', onFrame); p.removeEventListener('play', onPlay); p.removeEventListener('pause', onPause); p.removeEventListener('seeked', onSeek); };
  }, [fps, actions, meta?.durationInFrames, remountKey]);

  useEffect(() => {
    playerBus.set({
      toggle: () => ref.current?.toggle(), play: () => ref.current?.play(), pause: () => ref.current?.pause(),
      seekMs: (v) => { const f = Math.max(0, Math.min((meta?.durationInFrames ?? 1) - 1, Math.round((v / 1000) * fps))); ref.current?.seekTo(f); setMs((f / fps) * 1000); playerBus.emit((f / fps) * 1000); actions.seek((f / fps) * 1000); },
      stepFrames: (n) => { const cur = ref.current?.getCurrentFrame() ?? 0; const f = Math.max(0, Math.min((meta?.durationInFrames ?? 1) - 1, cur + n)); ref.current?.seekTo(f); actions.seek((f / fps) * 1000); },
      currentMs: () => ((ref.current?.getCurrentFrame() ?? 0) / fps) * 1000, durationMs: () => durationMs,
      fullscreen: () => ref.current?.requestFullscreen(), isPlaying: () => ref.current?.isPlaying() ?? false,
    });
    return () => playerBus.set(null);
  }, [fps, meta?.durationInFrames, durationMs, actions]);

  useEffect(() => { if (prefs.muted) ref.current?.mute(); else ref.current?.unmute(); }, [prefs.muted, remountKey]);

  const fit = meta ? Math.min((size.w - 32) / meta.width, (size.h - 32) / meta.height) : 1;
  const w = meta ? Math.max(1, Math.floor(meta.width * fit)) : 0, h = meta ? Math.max(1, Math.floor(meta.height * fit)) : 0;
  const ratio = head?.settings.ratio ?? '16:9';
  const safe = meta && prefs.safeArea ? safeAreaFor(ratio, meta.width, meta.height) : null;
  const previewLabel = state.previewPresetId ? getPreset(state.previewPresetId)?.label[lang] : null;
  const version = state.head?.hash.slice(0, 6);
  const ratioLabel = ratio === 'custom' && head?.settings.customRatio ? `${head.settings.customRatio.w}:${head.settings.customRatio.h}` : ratio;

  return (
    <div data-el="stage.player.frame" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-em-line bg-em-panel">
      <div className="flex h-7 items-center gap-2 border-b border-em-line px-2 text-[12px]">
        <span data-el="stage.player.controls.ratio" className="t-mono" title={t('ui.stage.player.ratio')}>{ratioLabel}</span>
        <span data-el="stage.player.controls.res" className="t-mono text-em-muted" title={t('ui.stage.player.res')}>{exportDims ? `${exportDims.width}×${exportDims.height}` : '—'}</span>
        {version && <span className="t-mono text-em-success" title={t('ui.stage.player.version.ok', { version })}>v{version} ✓</span>}
        <span className="flex-1" />
        <span className="relative">
          <IconButton el="stage.player.menu" data-popover-trigger="" label={t('ui.stage.player.menu')} icon={<Menu size={16} />} size={28} onClick={() => setMenu((m) => !m)} />
          {menu && (
            <Popover role="menu" align="right" width={240} onClose={() => setMenu(false)} label={t('ui.stage.player.menu')}>
              <MenuItem el="stage.player.menu.safearea" onClick={() => setPrefs({ safeArea: !prefs.safeArea })}>{prefs.safeArea ? '✓ ' : ''}{t('ui.stage.player.menu.safearea')}</MenuItem>
              <MenuItem el="stage.player.menu.draft" disabledReason={turbo ? t('ui.stage.player.menu.draft.turbo') : null} onClick={() => setPrefs({ draft: !prefs.draft })}>{draft ? '✓ ' : ''}{t('ui.stage.player.menu.draft')}</MenuItem>
              <MenuItem el="stage.player.menu.loop" onClick={() => setPrefs({ loop: !prefs.loop })}>{prefs.loop ? '✓ ' : ''}{t('ui.stage.player.menu.loop')}</MenuItem>
              <MenuItem el="stage.player.menu.mute" onClick={() => setPrefs({ muted: !prefs.muted })}>{prefs.muted ? '✓ ' : ''}{t('ui.stage.player.menu.mute')}</MenuItem>
              <MenuItem el="stage.player.menu.seekonselect" onClick={() => setPrefs({ seekOnSelect: !prefs.seekOnSelect })}>{prefs.seekOnSelect ? '✓ ' : ''}{t('ui.stage.player.menu.seekonselect')}</MenuItem>
            </Popover>
          )}
        </span>
      </div>
      <div ref={box} data-el="stage.player.canvas" role="region" aria-label={t('a11y.stage.player.canvas')} className="relative flex min-h-0 flex-1 items-center justify-center bg-em-bg"
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const files = [...e.dataTransfer.files]; if (files.length) void actions.upload(files); }}>
        {!inputProps || !meta ? (
          <div data-el="stage.player.state.loading" className="flex flex-col items-center gap-2 text-em-muted" role="status">
            <RefreshCw size={20} className="em-spin" aria-hidden />{t('ui.stage.player.loading')}{slow && <span>{t('ui.stage.player.slow')}</span>}
          </div>
        ) : (
          <div className="relative" style={{ width: w, height: h }}>
            <RemotionPlayer key={remountKey} ref={ref} component={Timeline} inputProps={inputProps as unknown as Record<string, unknown>}
              durationInFrames={meta.durationInFrames} compositionWidth={meta.width} compositionHeight={meta.height} fps={meta.fps}
              style={{ width: w, height: h }} controls={false} loop={prefs.loop} clickToPlay spaceKeyToPlayOrPause={false} acknowledgeRemotionLicense initialFrame={Math.min(meta.durationInFrames - 1, Math.round((state.playheadMs / 1000) * meta.fps))}
              errorFallback={({ error }) => (
                <div data-el="stage.player.state.error" role="alert" className="flex h-full w-full flex-col items-center justify-center gap-2 bg-em-panel p-4 text-center">
                  <span className="font-semibold">{t('ui.stage.player.error')}</span><span className="t-mono text-em-muted">EM-3301</span>
                  <span className="max-w-[320px] truncate text-[11px] text-em-muted">{error.message}</span>
                  <Button size={28} onClick={() => { void runtime.api.issueMediaGrant(state.project?.id ?? '').then((g) => dispatch({ type: 'grant', grant: g })).catch(() => undefined); setRemountKey((k) => k + 1); }}>{t('ui.stage.player.rebuild')}</Button>
                </div>
              )} />
            {safe && (
              <div aria-hidden className="pointer-events-none absolute border border-dashed border-em-accent-2/80"
                style={{ left: safe.left * fit, top: safe.top * fit, right: safe.right * fit, bottom: safe.bottom * fit }} />
            )}
            {previewLabel && <span className="absolute left-2 top-2 rounded-[4px] bg-em-accent px-1.5 text-[11px] font-semibold text-em-accent-ink">{t('ui.stage.player.previewing', { preset: previewLabel })}</span>}
            {previewLabel && !hasClip && <span className="absolute bottom-2 left-2 right-2 rounded-[4px] bg-black/70 px-1.5 text-center text-[11px]">{t('ui.stage.player.sample')}</span>}
            {draft && <span className="absolute bottom-2 right-2 rounded-[4px] bg-black/70 px-1.5 text-[11px]">{t('ui.stage.player.draft')}</span>}
          </div>
        )}
      </div>
      <div className="flex h-10 items-center gap-2 border-t border-em-line px-2">
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
        <IconButton el="stage.player.controls.fullscreen" label={t('ui.stage.player.fullscreen')} icon={<Maximize size={16} />} onClick={() => ref.current?.requestFullscreen()} />
      </div>
    </div>
  );
}

