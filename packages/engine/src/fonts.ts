// Bundled OFL fonts (offline rule; I18N-08). Loaded with the CSS Font Loading API from a `url()` source, NOT with
// @remotion/fonts' loadFont: that one downloads the file with fetch(), which is governed by the CSP `connect-src` directive.
// The packaged Editor runs on app://expertmotion with `connect-src http://127.0.0.1:*` (SEC-024), so every font fetch failed
// with "TypeError: Failed to fetch" and loadFont's cancelRender() turned it into an unhandled rejection (QA 2026-10-27,
// FR-203). A FontFace `url()` source is governed by `font-src 'self'`, which the Editor allows, and works the same in the
// Service's render page (http://localhost:<port>). A font that cannot load is reported once (EM-8014) and the text keeps the
// fallback stack; loading never rejects and never holds a frame longer than the font timeout.
import { continueRender, delayRender, staticFile } from 'remotion';
import { listPresets } from '@expertmotion/catalogue';

export interface FontLoadResult { loaded: number; failed: string[] }
/** `format` (ADR-039): the CSS `format()` hint; woff2 for the @fontsource families, truetype for fonts shipped as TTF (Poppins). */
export interface FontFile { family: string; url: string; weight: string; style: 'normal' | 'italic'; format: 'woff2' | 'truetype' }

/**
 * Every bundled font file of the catalogue's font presets (`fonts/<stem>-<weight>-<style>.<ext>`). A preset's data may narrow
 * `styles` (default normal + italic) and name `ext` / `format` (default woff2); ADR-039 ships Poppins 500–900 upright as TTF.
 */
export function bundledFontFiles(resolve: (p: string) => string = staticFile): FontFile[] {
  const out: FontFile[] = [];
  for (const p of listPresets({ category: 'font' })) {
    const family = String(p.data?.['family']), stem = String(p.data?.['fileStem']);
    const styles = ((p.data?.['styles'] as string[] | undefined) ?? ['normal', 'italic']).filter((x): x is 'normal' | 'italic' => x === 'normal' || x === 'italic');
    const ext = String(p.data?.['ext'] ?? 'woff2'), format = p.data?.['format'] === 'truetype' ? 'truetype' : 'woff2';
    for (const w of (p.data?.['weights'] as number[] | undefined) ?? []) for (const style of styles) out.push({ family, url: resolve(`${stem}-${w}-${style}.${ext}`), weight: String(w), style, format });
  }
  return out;
}

/** Loads one face; false (never a rejection) when the environment has no Font Loading API or the file cannot be loaded. */
export async function loadFontFace(f: FontFile, timeoutMs = 15_000): Promise<boolean> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const face = new FontFace(f.family, `url(${JSON.stringify(f.url)}) format(${JSON.stringify(f.format ?? 'woff2')})`, { weight: f.weight, style: f.style, display: 'block' });
    const timeout = new Promise<never>((_, j) => { timer = setTimeout(() => j(new Error('font load timeout')), timeoutMs); });
    await Promise.race([face.load(), timeout]);
    document.fonts.add(face);
    return true;
  } catch { return false; } finally { if (timer) clearTimeout(timer); }
}

let loaded: Promise<FontLoadResult> | null = null;
/** Loads every bundled font once (~400 KB); a render waits via delayRender so the first frame never uses a fallback font.
 *  Always resolves: failures are counted, reported once on the console (the Shell logs renderer warnings) and skipped. */
export function ensureFontsLoaded(): Promise<FontLoadResult> {
  if (loaded) return loaded;
  const handle = delayRender('Loading bundled fonts', { timeoutInMilliseconds: 60_000 });
  const files = bundledFontFiles();
  const supported = typeof FontFace !== 'undefined' && typeof document !== 'undefined';
  loaded = Promise.all(files.map(async (f) => ({ f, ok: await loadFontFace(f) })))
    .then((rows) => {
      const failed = rows.filter((r) => !r.ok).map((r) => `${r.f.family} ${r.f.weight} ${r.f.style}`);
      if (failed.length && supported) console.warn(`[em] EM-8014 ${failed.length} of ${rows.length} bundled fonts could not be loaded; the fallback font is used: ${failed.slice(0, 4).join(', ')}`);
      return { loaded: rows.length - failed.length, failed };
    }, () => ({ loaded: 0, failed: files.map((f) => f.family) }))
    .finally(() => { try { continueRender(handle); } catch { /* already continued */ } });
  return loaded;
}

/** Tests only: forget the cached load. */
export function resetFontsForTests(): void { loaded = null; }
