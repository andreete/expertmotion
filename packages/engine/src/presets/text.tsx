import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Highlight, Underline, Circle as RoughCircle } from '@remotion/rough-notation';
import { getPreset } from '@expertmotion/catalogue';
import { glueText, type TextLayerT } from '@expertmotion/composition-model';
import { useTheme } from '../theme.js';
import type { Layout } from '../layout.js';
import { motionCss, motionFrame } from '../motion.js';
import { easingFn, safeBezier, springDamping } from '../easing.js';
import { textLayerFit } from '../text-fit.js';
import { parseNumberIn, withNumber } from '../format-number.js';
import { fontStack, symbolRuns } from '../font-stack.js';

const clampOpts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
/**
 * One Text Layer inside its own <Sequence> (frame 0 = layer start). Deterministic fitting (shared estimator) keeps preview =
 * render. ADR-034: the positioned box never carries the motion (an inner wrapper does), so scale / grow / reveal act around the
 * text itself; `valign: top` anchors the top edge; style.lineHeight and style.box (pill / chip behind the text).
 */
export const TextElement: React.FC<{ layer: TextLayerT; layout: Layout; durationInFrames: number }> = ({ layer, layout, durationInFrames }) => {
  const t = useTheme(); const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const v = (getPreset(layer.variantId)?.data ?? {}) as Record<string, unknown>;
  const { weight, boxW, boxLeft, anchor, fit, lineHeight, lineTexts } = textLayerFit(layer, layout, t.textDefaults);
  const align = layer.style.align ?? (v['align'] as 'left' | 'center' | 'right' | undefined) ?? t.textDefaults.align;
  const colour = layer.style.colour ?? t.textDefaults.colour;
  const family = layer.style.fontFamily ?? t.textDefaults.fontFamily ?? (layer.variantId === 'preset:text.lower-third' ? t.bodyFont : t.headingFont);
  const mf = motionFrame(layer.motion, frame, durationInFrames, fps, layout.u, t.defaultEasingId, layer.id);
  const fs = fit.fontSize, u = layout.u;
  const b = layer.style.box;
  const box: React.CSSProperties = b ? { background: b.colour, padding: `${b.padY * u}px ${b.padX * u}px`, borderRadius: b.radius * u }
    : v['box'] ? { background: 'rgba(0,0,0,0.72)', padding: `${0.3 * fs}px ${0.5 * fs}px`, borderRadius: 0.3 * fs } : {};
  const bar: React.CSSProperties = v['bar'] ? { borderLeft: `${0.18 * fs}px solid ${t.accent}`, paddingLeft: 0.4 * fs, background: 'rgba(0,0,0,0.55)', paddingTop: 0.15 * fs, paddingBottom: 0.15 * fs, paddingRight: 0.4 * fs } : {};
  const counter = layer.effect?.presetId === 'preset:texteffect.counter';
  const content = renderContent(layer, frame, fps, t.accent, t.defaultEasingId, lineTexts);
  return (
    <div data-em-text={layer.id} style={{ position: 'absolute', left: boxLeft, top: anchor.top, width: boxW, transform: layer.valign === 'top' ? 'translate(-50%, 0)' : 'translate(-50%, -50%)', textAlign: align }}>
      <div style={motionCss(mf)}>
        <span style={{ display: 'inline-block', fontFamily: fontStack(family), fontWeight: weight, fontSize: fs, lineHeight, color: colour, opacity: layer.style.opacity ?? t.textDefaults.opacity,
          fontStyle: (layer.style.italic ?? t.textDefaults.italic ?? v['italic']) ? 'italic' : 'normal', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textAlign: align,
          textWrap: 'balance',                                     // round 2: balanced lines, the estimator models the same (text-box.ts)
          // Entry 35: `text-wrap` is a shorthand that sets text-wrap-mode back to `wrap`, and it comes after `white-space` in this
          // object, so `whiteSpace: nowrap` alone did not hold: a counting "+14,0%" (wider digits than the final "+17,2%") broke
          // its "%" onto a second line over the label. A no-wrap text says it in both properties.
          ...(counter || !/\s/.test(layer.text.trim()) ? { whiteSpace: 'nowrap', textWrap: 'nowrap' } : {}), ...(counter && align !== 'left' ? { fontVariantNumeric: 'tabular-nums' } : {}), ...box, ...bar }}>
          {v['italic'] ? '“' : ''}{content}{v['italic'] ? '”' : ''}
        </span>
      </div>
    </div>
  );
};

/** Count-up progress of the counter effect: params from, durationMs, delayMs, easingId / bezier (ADR-034). */
function counterValue(layer: TextLayerT, frame: number, fps: number, defaultEasingId: string): string {
  const p = (layer.effect?.params ?? {}) as Record<string, unknown>;
  const parsed = parseNumberIn(layer.text);
  if (!parsed) return layer.text;
  const delay = Math.round((Number(p['delayMs'] ?? 0) / 1000) * fps), dur = Math.max(1, Math.round((Number(p['durationMs'] ?? 1200) / 1000) * fps));
  const bz = p['bezier'];
  let k: number;
  if (Array.isArray(bz) && bz.length === 4) k = interpolate(frame, [delay, delay + dur], [0, 1], { ...clampOpts, easing: safeBezier(bz) });
  else {
    const id = typeof p['easingId'] === 'string' ? p['easingId'] : 'preset:easing.out-cubic';
    const damping = springDamping(id);
    k = damping === null ? interpolate(frame, [delay, delay + dur], [0, 1], { ...clampOpts, easing: easingFn(id ?? defaultEasingId) }) : spring({ frame: frame - delay, fps, config: { damping }, durationInFrames: dur });
  }
  const from = typeof p['from'] === 'number' ? p['from'] : 0;
  return withNumber(parsed, from + (parsed.value - from) * k);
}

/**
 * C9 (review 2026-10-29): a word is a keyword when it IS one of the keyword words (punctuation and case ignored), or starts with
 * one of at least 4 letters (Indonesian suffixes: "harganya" for "harga"). A one-letter keyword no longer colours every word
 * that contains that letter.
 */
export function isKeywordWord(word: string, keywords: readonly string[]): boolean {
  const clean = (t: string) => t.toLowerCase().replace(/[.,!?;:"“”'‘’()%]/g, '');
  const w = clean(word);
  if (!w) return false;
  return keywords.some((k) => k.split(/\s+/).map(clean).filter(Boolean).some((kw) => w === kw || (kw.length >= 4 && w.startsWith(kw))));
}
function renderContent(layer: TextLayerT, frame: number, fps: number, accent: string, defaultEasingId: string, lineTexts?: readonly string[]): React.ReactNode {
  const fx = layer.effect?.presetId;
  if (fx === 'preset:texteffect.counter') return counterValue(layer, frame, fps, defaultEasingId);
  // Round 2: the lines chosen by the shared estimator (balanced, bound groups such as "Jan–Agu 2026" / "(miliar US$)" glued with
  // U+00A0), rendered with explicit breaks so the Player, the export and the quality gate show the same lines
  const text = lineTexts && lineTexts.length ? lineTexts.join('\n') : glueText(layer.text);
  const words = text.split(/([^\S\u00A0]+)/);
  // Motion presets that work per character / per word (DESIGN_CATALOGUE §5, P1)
  if (layer.motion?.presetId === 'preset:motion.typewriter') {
    const cps = 20; const shown = Math.floor((Math.max(0, frame - Math.round((layer.motion.delayMs / 1000) * fps)) / fps) * cps);
    return text.slice(0, shown);
  }
  const keyColour = String(layer.effect?.params['colour'] ?? accent);
  const keywords = fx === 'preset:texteffect.keyword' ? ((layer.effect?.params['words'] as string[] | undefined) ?? []).map((w) => w.toLowerCase()) : [];
  const isKey = (w: string) => w.split('\u00A0').some((part) => isKeywordWord(part, keywords));   // a glued group is one span
  if (layer.motion?.presetId === 'preset:motion.word-stagger' || fx === 'preset:texteffect.kinetic' || fx === 'preset:texteffect.keyword') {
    const stagger = layer.motion?.presetId === 'preset:motion.word-stagger' || fx === 'preset:texteffect.kinetic' ? Number(layer.motion?.params['staggerFrames'] ?? 4) : 0;
    const start = Math.round(((layer.motion?.delayMs ?? 0) / 1000) * fps);
    let wi = 0;
    return words.map((w, i) => {
      if (/^[^\S\u00A0]+$/.test(w)) return <span key={i}>{w}</span>;
      const key = isKey(w);
      const s = stagger ? spring({ frame: frame - start - (wi++) * stagger, fps, config: { damping: 14 } }) : 1;
      const pop = key ? spring({ frame: frame - start - Math.round(0.35 * fps) - wi * stagger, fps, config: { damping: 10 } }) : 0;
      return <span key={i} style={{ display: 'inline-block', ...(stagger ? { opacity: s, translate: `0px ${(1 - s) * 0.4}em` } : {}), ...(key ? { color: keyColour, scale: `${1 + 0.06 * Math.sin(Math.min(1, pop) * Math.PI)}` } : {}) }}>{symbolRuns(w, `w${i}`)}</span>;
    });
  }
  const colour = String(layer.effect?.params['colour'] ?? accent);
  const progress = interpolate(frame, [Math.round(0.3 * fps), Math.round(1.1 * fps)], [0, 1], clampOpts);
  // rough-notation annotates one box per element and keeps it on one line, so long text would overflow (seen in the slice-v0
  // golden frame). Annotating word by word keeps normal line wrapping; the stroke progresses across words in reading order.
  const perWord = (Mark: typeof Highlight, color: string) => {
    const ws = words.filter((w) => !/^[^\S\u00A0]+$/.test(w)); let k = 0;
    return words.map((w, i) => {
      if (/^[^\S\u00A0]+$/.test(w)) return <span key={i}>{w}</span>;
      const local = Math.min(1, Math.max(0, progress * ws.length - k++));
      return <Mark key={i} progress={local} color={color}>{w}</Mark>;
    });
  };
  switch (fx) {
    case 'preset:texteffect.highlight': return perWord(Highlight, `color-mix(in srgb, ${colour} 70%, transparent)`);
    case 'preset:texteffect.underline': return perWord(Underline as typeof Highlight, colour);
    case 'preset:texteffect.circle': return <RoughCircle progress={progress} color={colour}>{text}</RoughCircle>;
    default: return symbolRuns(text);                              // QA A16: ≤ ≥ ± … in Inter at the heading size
  }
}
