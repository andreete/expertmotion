// Copies bundled OFL fonts (latin subset, weights 400–800, normal + italic for FR-022) from @fontsource into public/fonts so renders never fetch fonts.
// Poppins (ADR-039) is not an @fontsource package here: its TTFs (500–900 upright) and LICENSE-poppins.txt are committed in public/fonts directly.
// Playfair Display (ADR-041) likewise: the two upstream VARIABLE TTFs (playfair-display-var-normal.ttf / -italic.ttf, wght 400–900) and
// LICENSE-playfair-display.txt from github.com/google/fonts @ 8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5 ofl/playfairdisplay are committed.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const out = new URL('../public/fonts/', import.meta.url).pathname; fs.mkdirSync(out, { recursive: true });
for (const stem of ['inter', 'plus-jakarta-sans', 'archivo', 'jetbrains-mono']) {
  const dir = path.dirname(require.resolve(`@fontsource/${stem}/package.json`));
  for (const w of [400, 500, 600, 700, 800]) for (const s of ['normal', 'italic']) fs.copyFileSync(path.join(dir, 'files', `${stem}-latin-${w}-${s}.woff2`), path.join(out, `${stem}-latin-${w}-${s}.woff2`));
  fs.copyFileSync(path.join(dir, 'LICENSE'), path.join(out, `LICENSE-${stem}.txt`));
}
console.log('fonts copied to', out);
