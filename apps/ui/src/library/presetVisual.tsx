// Placeholder swatch for Catalogue Cards whose prerendered loop is not available (ADR-011 loops are built by
// `build:engine`; until then, and in mock mode, a category-coloured swatch with the category glyph is shown).
import { Captions, Image as ImageIcon, Move, Music2, Shapes, Shuffle, Spline, Type, Wand2 } from 'lucide-react';
import type { ReactNode } from 'react';

const GLYPH: Record<string, ReactNode> = {
  transition: <Shuffle size={20} />, caption: <Captions size={20} />, background: <ImageIcon size={20} />, motion: <Move size={20} />, shape: <Shapes size={20} />,
  easing: <Spline size={20} />, effect: <Wand2 size={20} />, audio: <Music2 size={20} />, text: <Type size={20} />, texteffect: <Type size={20} />,
};
export const categoryIcon = (category: string, size = 16): ReactNode => {
  const g = GLYPH[category];
  return g ? <span style={{ display: 'inline-flex', width: size, height: size, alignItems: 'center' }} aria-hidden>{g}</span> : null;
};

function hue(s: string): number { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

export function PresetSwatch({ id, category, playing }: { id: string; category: string; playing: boolean }) {
  const h = hue(id);
  return (
    <div className="flex h-full w-full items-center justify-center text-white/85" aria-hidden
      style={{ background: `linear-gradient(135deg, hsl(${h} 45% 32%), hsl(${(h + 40) % 360} 35% 14%))`, transition: 'filter var(--t-fast)', filter: playing ? 'brightness(1.25)' : 'none' }}>
      {GLYPH[category]}
    </div>
  );
}
