import React, { createContext, useContext } from 'react';
import { getPreset } from '@expertmotion/catalogue';
import type { ThemeT } from '@expertmotion/composition-model';

export interface ThemeTokens { bg: string; text: string; accent: string; accent2: string; headingFont: string; bodyFont: string; textDefaults: ThemeT['textDefaults']; defaultEasingId: string }
const familyOf = (fontPresetId: unknown, fallback: string) => String(getPreset(String(fontPresetId))?.data?.['family'] ?? fallback);

export function tokensFor(theme: ThemeT): ThemeTokens {
  const pal = getPreset(theme.paletteId)?.data ?? {};
  const pair = getPreset(theme.fontPairId)?.data ?? {};
  return {
    bg: String(pal['bg'] ?? '#14120F'), text: String(pal['text'] ?? '#F4EFE6'), accent: String(pal['accent'] ?? '#E8913A'), accent2: String(pal['accent2'] ?? '#4FD1A5'),
    headingFont: familyOf(pair['heading'], 'Plus Jakarta Sans'), bodyFont: familyOf(pair['body'], 'Inter'),
    textDefaults: theme.textDefaults, defaultEasingId: theme.defaultEasingId,
  };
}
const Ctx = createContext<ThemeTokens | null>(null);
export const ThemeProvider: React.FC<{ theme: ThemeT; children: React.ReactNode }> = ({ theme, children }) => <Ctx.Provider value={tokensFor(theme)}>{children}</Ctx.Provider>;
export function useTheme(): ThemeTokens { const t = useContext(Ctx); if (!t) throw new Error('useTheme outside ThemeProvider'); return t; }
