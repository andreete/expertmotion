// Copies bundled OFL fonts (latin subset, weights 400–800) from @fontsource into public/fonts so renders never fetch fonts.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const out = new URL('../public/fonts/', import.meta.url).pathname; fs.mkdirSync(out, { recursive: true });
for (const stem of ['inter', 'plus-jakarta-sans', 'archivo', 'jetbrains-mono']) {
  const dir = path.dirname(require.resolve(`@fontsource/${stem}/package.json`));
  for (const w of [400, 500, 600, 700, 800]) fs.copyFileSync(path.join(dir, 'files', `${stem}-latin-${w}-normal.woff2`), path.join(out, `${stem}-latin-${w}-normal.woff2`));
  fs.copyFileSync(path.join(dir, 'LICENSE'), path.join(out, `LICENSE-${stem}.txt`));
}
console.log('fonts copied to', out);
