import { build } from 'esbuild';
await build({ entryPoints: [new URL('./player-entry.tsx', import.meta.url).pathname], bundle: true, format: 'esm', outfile: new URL('./out/player.js', import.meta.url).pathname,
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, minify: false, logLevel: 'warning', target: 'chrome120' });
console.log('player bundle built');
