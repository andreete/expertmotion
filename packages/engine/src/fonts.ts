// Bundled OFL fonts via @remotion/fonts + staticFile (offline rule; ported pattern from the predecessor fonts.ts).
import { loadFont } from '@remotion/fonts';
import { continueRender, delayRender, staticFile } from 'remotion';
import { listPresets } from '@expertmotion/catalogue';

let loaded: Promise<void> | null = null;
/** Loads every bundled font once (~400 KB); render waits via delayRender so the first frame never uses a fallback font. */
export function ensureFontsLoaded(): Promise<void> {
  if (loaded) return loaded;
  const handle = delayRender('Loading bundled fonts');
  const jobs: Promise<void>[] = [];
  for (const p of listPresets({ category: 'font' })) {
    const family = String(p.data?.['family']), stem = String(p.data?.['fileStem']);
    for (const w of (p.data?.['weights'] as number[] | undefined) ?? []) jobs.push(loadFont({ family, url: staticFile(`${stem}-${w}-normal.woff2`), weight: String(w), format: 'woff2' }));
  }
  loaded = Promise.all(jobs).then(() => { continueRender(handle); }, (e) => { continueRender(handle); throw e; });
  return loaded;
}
