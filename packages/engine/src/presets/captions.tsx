import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionPageT } from '@expertmotion/composition-model';
import { useTheme } from '../theme.js';
import type { Layout } from '../layout.js';

/** One caption page inside its <Sequence> (book §7.7). whiteSpace: 'pre' keeps the leading spaces that separate tokens. */
export const CaptionPageView: React.FC<{ page: CaptionPageT; styleId: string; params: Record<string, unknown>; layout: Layout }> = ({ page, styleId, params, layout }) => {
  const t = useTheme(); const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  if (styleId === 'preset:caption.none') return null;
  const nowMs = page.startMs + (frame / fps) * 1000;
  const size = Number(params['fontSize'] ?? 56) * layout.u;
  const accent = String(params['highlightColour'] ?? t.accent);
  const pos = String(params['position'] ?? 'bottom');
  const justify = pos === 'top' ? 'flex-start' : pos === 'center' ? 'center' : 'flex-end';
  const pad = pos === 'top' ? { paddingTop: layout.safe.top } : pos === 'bottom' ? { paddingBottom: layout.safe.bottom } : {};
  const box = styleId === 'preset:caption.box' ? { background: 'rgba(0,0,0,0.75)', borderRadius: 0.3 * size, padding: `${0.25 * size}px ${0.45 * size}px` } : {};
  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: 'center', paddingLeft: layout.safe.left, paddingRight: layout.safe.right, ...pad }}>
      <div style={{ fontFamily: t.headingFont, fontWeight: 800, fontSize: size, lineHeight: 1.2, textAlign: 'center', whiteSpace: 'pre', color: t.text, textShadow: styleId === 'preset:caption.box' ? 'none' : `0 ${0.04 * size}px ${0.12 * size}px rgba(0,0,0,0.8)`, ...box }}>
        {page.tokens.map((tok, i) => {
          const active = tok.fromMs <= nowMs && tok.toMs > nowMs;
          const spoken = tok.toMs <= nowMs;
          let style: React.CSSProperties = {};
          switch (styleId) {
            case 'preset:caption.karaoke': style = { color: spoken || active ? accent : t.text }; break;
            case 'preset:caption.pop': { const s = active ? spring({ frame: frame - Math.round(((tok.fromMs - page.startMs) / 1000) * fps), fps, config: { damping: 10 } }) : 0; style = { color: active ? accent : t.text, display: 'inline-block', scale: 1 + 0.2 * s }; break; }
            case 'preset:caption.moving-pill': style = active ? { background: accent, color: t.bg, borderRadius: 0.25 * size, padding: `0 ${0.15 * size}px` } : {}; break;
            default: style = { color: active ? accent : t.text };     // editorial, box
          }
          return <span key={i} style={style}>{tok.text}</span>;
        })}
      </div>
    </AbsoluteFill>
  );
};
