// @vitest-environment jsdom
// QA 2026-10-31: when the browser cannot paint Remotion effects (HTML-in-canvas missing, "Enable Canvas Draw Element"), the Player
// drops the effects and approximates them with a CSS filter instead of crashing to a black frame.
import { afterEach, describe, expect, it } from 'vitest';
import { cssFilterFallback, htmlInCanvasSupported, resetHtmlInCanvasCache } from '../src/presets/effects.js';

const fx = (presetId: string, params: Record<string, unknown> = {}) => ({ presetId, params, motion: 'static' as const });

describe('effects fallback without HTML-in-canvas', () => {
  afterEach(() => resetHtmlInCanvasCache());
  it('jsdom has no drawElementImage → unsupported; outside a browser → supported (renderer, tests of pure code)', () => {
    expect(htmlInCanvasSupported()).toBe(false);
    resetHtmlInCanvasCache();
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({ drawElementImage: () => undefined })) as unknown as typeof orig;
    try { expect(htmlInCanvasSupported()).toBe(true); } finally { HTMLCanvasElement.prototype.getContext = orig; }
  });
  it('maps blur / colour grade / duotone to CSS filters and ignores effects with no CSS equivalent', () => {
    expect(cssFilterFallback([fx('preset:effect.blur', { radiusPx: 12 })])).toBe('blur(12px)');
    expect(cssFilterFallback([fx('preset:effect.colour-grade', { brightness: 0.5, contrast: 0, saturation: -1 })])).toBe('brightness(1.3) contrast(1) saturate(0)');
    expect(cssFilterFallback([fx('preset:effect.duotone'), fx('preset:effect.pixelate')])).toBe('grayscale(1) sepia(0.35)');
    expect(cssFilterFallback([fx('preset:effect.pixelate'), fx('preset:effect.greenscreen')])).toBeUndefined();
    expect(cssFilterFallback([])).toBeUndefined();
  });
});
