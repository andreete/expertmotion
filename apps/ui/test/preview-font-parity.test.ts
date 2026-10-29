// Round 2 (QA 2026-10-29: weight-500 headings looked heavier in the Player than in the exported MP4). Measured cause: NOT a
// different font — the Editor page and the render page load the same bundled files (pixel parity 1080×1920 ≤ 0.5 %, see
// process.md "Remaining fixes (round 2)") — but Chrome rasterising the text at the small preview scale. Guards:
//  1. every font file the Editor's CSS names is the Engine's bundled file (the UI's publicDir IS packages/engine/public), and the
//     Engine's FontFace list (bundledFontFiles) covers every weight the Editor CSS declares, so there is one set of files;
//  2. the Player's scaled container gets its own compositing layer (`.em-raster`, re-applied when the preview size changes).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundledFontFiles } from '@expertmotion/engine';

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.resolve(here, '..'), engPublic = path.resolve(ui, '../../packages/engine/public');
const css = fs.readFileSync(path.join(ui, 'src/index.css'), 'utf8');

describe('Player and export use the same bundled fonts', () => {
  it('the Editor @font-face files are the Engine bundled files, and the Engine registers every one of those faces', () => {
    const vite = fs.readFileSync(path.join(ui, 'vite.config.ts'), 'utf8');
    expect(vite).toMatch(/publicDir:\s*fileURLToPath\(new URL\('\.\.\/\.\.\/packages\/engine\/public'/);
    const faces = [...css.matchAll(/@font-face\s*\{[^}]*font-family:\s*"?([^";]+)"?;[^}]*font-weight:\s*(\d+);[^}]*url\("\/fonts\/([^"]+)"\)/g)].map((m) => ({ family: m[1]!, weight: m[2]!, file: m[3]! }));
    expect(faces.length).toBeGreaterThanOrEqual(4);
    const engine = bundledFontFiles((p) => p);
    for (const f of faces) {
      expect(fs.existsSync(path.join(engPublic, 'fonts', f.file)), f.file).toBe(true);
      expect(engine.some((e) => e.family === f.family && e.weight === f.weight && e.style === 'normal' && e.url === `fonts/${f.file}`), `${f.family} ${f.weight}`).toBe(true);
    }
    // Inter 500 (the nikel headings) in particular
    expect(engine.find((e) => e.family === 'Inter' && e.weight === '500' && e.style === 'normal')?.url).toBe('fonts/inter-latin-500-normal.woff2');
  });
  it('the Player container is rasterised as one layer at the preview size (.em-raster → will-change: transform)', () => {
    expect(css).toMatch(/\.em-raster \[style\*="scale\("\] \{ will-change: transform; \}/);
    const player = fs.readFileSync(path.join(ui, 'src/stage/Player.tsx'), 'utf8');
    expect(player).toContain('className="relative em-raster"');
    expect(player).toMatch(/classList\.remove\('em-raster'\)[\s\S]{0,120}classList\.add\('em-raster'\)[\s\S]{0,80}\[w, h\]/);
  });
});
