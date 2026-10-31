import React, { createContext, useContext } from 'react';
import { getPreset } from '@expertmotion/catalogue';
import type { ThemeT } from '@expertmotion/composition-model';

/** ADR-039 adds the palette roles the infographic shapes read (bg2 panel, muted, negative, warn); every palette has a fallback. */
export interface ThemeTokens { bg: string; bg2: string; text: string; accent: string; accent2: string; muted: string; negative: string; warn: string; headingFont: string; bodyFont: string; textDefaults: ThemeT['textDefaults']; defaultEasingId: string }
const familyOf = (fontPresetId: unknown, fallback: string) => String(getPreset(String(fontPresetId))?.data?.['family'] ?? fallback);
const mix = (c: string, with_: string, pct: number) => `color-mix(in srgb, ${c} ${100 - pct}%, ${with_} ${pct}%)`;

export function tokensFor(theme: ThemeT): ThemeTokens {
  const pal = getPreset(theme.paletteId)?.data ?? {};
  const pair = getPreset(theme.fontPairId)?.data ?? {};
  const bg = String(pal['bg'] ?? '#14120F'), text = String(pal['text'] ?? '#F4EFE6');
  return {
    bg, text, accent: String(pal['accent'] ?? '#E8913A'), accent2: String(pal['accent2'] ?? '#4FD1A5'),
    bg2: String(pal['bg2'] ?? mix(bg, text, 8)), muted: String(pal['muted'] ?? mix(text, bg, 45)), negative: String(pal['negative'] ?? '#FF5C5C'), warn: String(pal['warn'] ?? '#FFA94D'),
    headingFont: familyOf(pair['heading'], 'Plus Jakarta Sans'), bodyFont: familyOf(pair['body'], 'Inter'),
    textDefaults: theme.textDefaults, defaultEasingId: theme.defaultEasingId,
  };
}
const Ctx = createContext<ThemeTokens | null>(null);
export const ThemeProvider: React.FC<{ theme: ThemeT; children: React.ReactNode }> = ({ theme, children }) => <Ctx.Provider value={tokensFor(theme)}>{children}</Ctx.Provider>;
export function useTheme(): ThemeTokens { const t = useContext(Ctx); if (!t) throw new Error('useTheme outside ThemeProvider'); return t; }
