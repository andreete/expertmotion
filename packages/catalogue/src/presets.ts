// Every row of docs/DESIGN_CATALOGUE.md §2–§11, in the same order. That document is the owner; test/catalogue.test.ts
// fails if an id exists in one place and not the other.
import { z } from 'zod';
import { define, direction, easingRef, hex, ms, optionalHex, unit } from './define.js';
import type { PresetDef } from './types.js';

const transitionCommon = { durationMs: ms(500, 100, 2000), timing: z.enum(['linear', 'spring']).default('linear'), easingId: easingRef() };
export const transitions = define('transition', transitionCommon, [
  { name: 'fade', en: 'Fade', id: 'Pudar', p: 'p0', tags: ['soft', 'gentle', 'lembut', 'smooth', 'halus'] },
  { name: 'slide', en: 'Slide', id: 'Geser', p: 'p0', params: { direction: direction('from-right') }, tags: ['energetic', 'fast', 'cepat'] },
  { name: 'wipe', en: 'Wipe', id: 'Sapu', p: 'p0', params: { direction: direction('from-left') }, tags: ['clean'] },
  { name: 'push-cut', en: 'Push cut', id: 'Dorong potong', p: 'p0', tags: ['punch', 'flash', 'energetic', 'hook'] },
  { name: 'clock-wipe', en: 'Clock wipe', id: 'Sapu jam', p: 'p0', tags: ['playful'] },
  { name: 'iris', en: 'Iris', id: 'Iris', p: 'p0', tags: ['reveal', 'cinematic'] },
  { name: 'flip', en: 'Flip', id: 'Balik', p: 'p1', params: { direction: direction('from-left') } },
  { name: 'zoom-blur', en: 'Zoom blur', id: 'Kabur zoom', p: 'p1', flags: ['gpu'], tags: ['energetic'] },
  { name: 'dreamy-zoom', en: 'Dreamy zoom', id: 'Zoom lembut', p: 'p1', flags: ['gpu'], tags: ['dreamy', 'soft'] },
  { name: 'film-burn', en: 'Film burn', id: 'Film terbakar', p: 'p1', flags: ['gpu'], tags: ['retro', 'cinematic'] },
  { name: 'linear-blur', en: 'Linear blur', id: 'Kabur searah', p: 'p1', flags: ['gpu'] },
  { name: 'book-flip', en: 'Book flip', id: 'Balik buku', p: 'p1', flags: ['gpu'] },
  { name: 'zoom-in-out', en: 'Zoom in-out', id: 'Zoom masuk-keluar', p: 'p1' },
  { name: 'dissolve', en: 'Dissolve', id: 'Larut', p: 'p1', flags: ['gpu'], tags: ['soft'] },
  { name: 'ripple', en: 'Ripple', id: 'Riak', p: 'p1', flags: ['gpu'] },
  { name: 'crosswarp', en: 'Crosswarp', id: 'Silang lengkung', p: 'p1', flags: ['gpu'] },
  { name: 'cross-zoom', en: 'Cross zoom', id: 'Zoom silang', p: 'p1', flags: ['gpu'] },
  { name: 'swap', en: 'Swap', id: 'Tukar', p: 'p1', flags: ['gpu'] },
  { name: 'blur-slide', en: 'Blur slide', id: 'Geser kabur', p: 'p1', flags: ['gpu'], params: { direction: direction('from-right') } },
  { name: 'none', en: 'Hard cut', id: 'Potong langsung', p: 'p0', tags: ['cut', 'potong', 'instant'] },
]);

const captionCommon = {
  position: z.enum(['bottom', 'center', 'top']).default('bottom'), fontSize: z.number().min(34).max(140).default(56),
  combineTokensWithinMs: ms(1200, 0, 10_000), maxLines: z.number().int().min(1).max(3).default(2), highlightColour: optionalHex(),
};
export const captions = define('caption', captionCommon, [
  { name: 'editorial', en: 'Editorial', id: 'Editorial', p: 'p0', tags: ['clean', 'calm', 'news'] },
  { name: 'karaoke', en: 'Karaoke', id: 'Karaoke', p: 'p0', tags: ['tiktok', 'reels', 'words'] },
  { name: 'box', en: 'Box', id: 'Kotak', p: 'p0', tags: ['readable', 'terbaca'] },
  { name: 'pop', en: 'Pop', id: 'Pop', p: 'p1', tags: ['energetic', 'bouncy'] },
  { name: 'moving-pill', en: 'Moving pill', id: 'Pil bergerak', p: 'p1' },
  { name: 'none', en: 'No captions', id: 'Tanpa caption', p: 'p0', preview: false },
]);

const bgCommon = { colourA: optionalHex(), colourB: optionalHex(), intensity: unit(1), animate: z.boolean().default(false) };
export const backgrounds = define('background', bgCommon, [
  { name: 'solid', en: 'Solid', id: 'Polos', p: 'p0', tags: ['plain', 'calm'] },
  { name: 'gradient', en: 'Gradient', id: 'Gradasi', p: 'p0', params: { angle: z.number().min(0).max(360).default(160) } },
  { name: 'spotlight', en: 'Spotlight', id: 'Sorot', p: 'p0', tags: ['dramatic'] },
  { name: 'grid', en: 'Grid', id: 'Kisi', p: 'p0', params: { cellPx: z.number().int().min(10).max(200).default(50) }, tags: ['tech'] },
  { name: 'dots', en: 'Dots', id: 'Titik', p: 'p0', params: { cellPx: z.number().int().min(10).max(200).default(34) } },
  { name: 'moving-gradient', en: 'Moving gradient', id: 'Gradasi bergerak', p: 'p1', params: { angle: z.number().min(0).max(360).default(160) } },
  { name: 'noise-clouds', en: 'Clouds', id: 'Awan', p: 'p1', tags: ['organic', 'calm'] },
  { name: 'video-dim', en: 'Dim video', id: 'Video redup', p: 'p0', params: { strength: unit(0.78) }, tags: ['readable', 'overlay', 'terbaca'] },
  { name: 'paper', en: 'Paper', id: 'Kertas', p: 'p2', flags: ['gpu'], tags: ['texture'] },
  { name: 'none', en: 'None', id: 'Tanpa latar', p: 'p0', tags: ['transparent', 'alpha'] },
]);

// ADR-034 (auto motion): optional on every motion (absent = the behaviour before): exitMs (exit length, default = the entrance),
// exitStyle (mirror = the entrance backwards, fade = opacity only), bezier (explicit cubic-bezier, wins over easingId), loop
// (a subtle deterministic idle loop after the entrance), distanceU (rise / reveal distance).
const motionCommon = { durationMs: ms(600, 100, 10_000), delayMs: ms(0, 0, 10_000), easingId: easingRef(), exit: z.boolean().default(true),
  exitMs: z.number().int().min(0).max(10_000).optional(), exitStyle: z.enum(['mirror', 'fade']).optional(),
  bezier: z.array(z.number().min(-2).max(3)).length(4).optional(), loop: z.enum(['none', 'float', 'pulse', 'sway', 'spin']).optional() };
const grow = z.enum(['up', 'down', 'left', 'right']);
export const motions = define('motion', motionCommon, [
  { name: 'fade-in', en: 'Fade in', id: 'Pudar masuk', p: 'p0', tags: ['soft'] },
  { name: 'rise', en: 'Rise', id: 'Naik', p: 'p0', params: { distanceU: z.number().min(0).max(2000).default(40) } },
  { name: 'pop', en: 'Pop', id: 'Muncul membesar', p: 'p0', params: { damping: z.number().min(1).max(200).default(12) }, tags: ['energetic', 'bouncy'] },
  { name: 'slide-in', en: 'Slide in', id: 'Geser masuk', p: 'p0', params: { direction: direction('from-left') } },
  { name: 'zoom-drift', en: 'Zoom drift', id: 'Zoom pelan', p: 'p0', params: { toScale: z.number().min(1).max(1.5).default(1.08) }, tags: ['ken burns', 'calm', 'cinematic'] },
  { name: 'spin-in', en: 'Spin in', id: 'Putar masuk', p: 'p1' },
  { name: 'bounce', en: 'Bounce', id: 'Pantul', p: 'p1', tags: ['playful'] },
  { name: 'typewriter', en: 'Typewriter', id: 'Ketik', p: 'p1' },
  { name: 'word-stagger', en: 'Word stagger', id: 'Kata bergantian', p: 'p1', params: { staggerFrames: z.number().int().min(1).max(30).default(8) } },
  { name: 'blur-in', en: 'Blur in', id: 'Kabur masuk', p: 'p1', params: { blurU: z.number().min(0).max(80).default(16) }, tags: ['soft', 'cinematic', 'smooth'] },
  { name: 'scale-in', en: 'Scale in', id: 'Membesar halus', p: 'p1', params: { fromScale: z.number().min(0).max(2).default(0.7) }, tags: ['clean', 'smooth'] },
  { name: 'wipe-reveal', en: 'Wipe reveal', id: 'Buka sapu', p: 'p1', params: { direction: direction('from-left') }, tags: ['reveal', 'clean'] },
  { name: 'draw-on', en: 'Draw on', id: 'Gambar garis', p: 'p1', tags: ['draw', 'line', 'stroke', 'garis'] },
  { name: 'grow', en: 'Grow', id: 'Tumbuh', p: 'p1', params: { direction: grow.default('up') }, tags: ['chart', 'bar', 'grafik'] },
  { name: 'none', en: 'Static', id: 'Diam', p: 'p0', preview: false },
]);

const shapeCommon = {
  size: z.number().min(10).max(2000).default(200), fill: optionalHex(), stroke: optionalHex(), strokeWidth: z.number().min(0).max(100).default(0),
  position: z.union([z.enum(['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right']), z.object({ x: z.number(), y: z.number() })]).default('center'),
  motionId: z.string().regex(/^preset:motion\.[a-z0-9-]+$/).optional(),
};
export const shapes = define('shape', shapeCommon, [
  { name: 'circle', en: 'Circle', id: 'Lingkaran', p: 'p0' },
  { name: 'rect', en: 'Rectangle', id: 'Kotak', p: 'p0', params: { cornerRadius: z.number().min(0).max(500).default(24), outline: z.boolean().optional(), dashU: z.number().min(0).max(200).optional() } },
  { name: 'star', en: 'Star', id: 'Bintang', p: 'p0', params: { points: z.number().int().min(3).max(20).default(5), innerRadius: unit(0.44) } },
  { name: 'arrow', en: 'Arrow', id: 'Panah', p: 'p0', params: { direction: z.enum(['left', 'right', 'up', 'down']).default('right') } },
  { name: 'triangle', en: 'Triangle', id: 'Segitiga', p: 'p1' },
  { name: 'heart', en: 'Heart', id: 'Hati', p: 'p1' },
  { name: 'pie', en: 'Pie', id: 'Pai', p: 'p1', params: { progress: unit(0.75) } },
  { name: 'polygon', en: 'Polygon', id: 'Poligon', p: 'p1', params: { points: z.number().int().min(3).max(20).default(6) } },
  { name: 'callout', en: 'Callout', id: 'Balon', p: 'p2' },
  { name: 'spark', en: 'Spark', id: 'Percik', p: 'p2' },
  { name: 'ellipse', en: 'Ellipse', id: 'Elips', p: 'p2' },
  { name: 'line', en: 'Line', id: 'Garis', p: 'p1', tags: ['underline', 'accent', 'bar', 'garis bawah'] },
  { name: 'ring', en: 'Ring', id: 'Cincin', p: 'p1', tags: ['outline', 'circle', 'stat', 'lingkaran'] },
  { name: 'pill', en: 'Pill', id: 'Kapsul', p: 'p1', tags: ['button', 'tombol', 'cta', 'badge'] },
  { name: 'check', en: 'Check', id: 'Centang', p: 'p1', tags: ['tick', 'done', 'list', 'centang'] },
  { name: 'chevron', en: 'Chevron', id: 'Panah kecil', p: 'p1', tags: ['bullet', 'list', 'next'] },
]);

export const easings = define('easing', {}, [
  { name: 'out-quad', en: 'Smooth stop', id: 'Berhenti halus', p: 'p0', data: { fn: 'out', base: 'quad' }, preview: false },
  { name: 'out-cubic', en: 'Soft landing', id: 'Mendarat lembut', p: 'p0', data: { fn: 'out', base: 'cubic' }, preview: false },
  { name: 'in-quad', en: 'Speed away', id: 'Pergi cepat', p: 'p0', data: { fn: 'in', base: 'quad' }, preview: false },
  { name: 'in-out-cubic', en: 'Glide', id: 'Meluncur', p: 'p0', data: { fn: 'inOut', base: 'cubic' }, preview: false },
  { name: 'back', en: 'Overshoot', id: 'Lewat sedikit', p: 'p0', data: { fn: 'out', base: 'back', arg: 2 }, preview: false },
  { name: 'bounce', en: 'Bounce', id: 'Pantul', p: 'p1', data: { fn: 'bounce' }, preview: false },
  { name: 'linear', en: 'Linear', id: 'Linear', p: 'p1', data: { fn: 'linear' }, preview: false },
  { name: 'spring-soft', en: 'Spring soft', id: 'Pegas lembut', p: 'p1', data: { fn: 'spring', damping: 200 }, preview: false },
  { name: 'spring-bouncy', en: 'Spring bouncy', id: 'Pegas memantul', p: 'p1', data: { fn: 'spring', damping: 8 }, preview: false },
  { name: 'snappy', en: 'Snappy', id: 'Sigap', p: 'p1', data: { fn: 'bezier', args: [0.2, 0.8, 0.2, 1] }, preview: false },
  { name: 'spring-light', en: 'Spring light', id: 'Pegas ringan', p: 'p1', data: { fn: 'spring', damping: 14 }, preview: false },
]);

const fxCommon = { motion: z.enum(['static', 'in', 'out']).default('static') };
export const effects = define('effect', fxCommon, [
  { name: 'blur', en: 'Blur', id: 'Kabur', p: 'p0', flags: ['gpu'], params: { radiusPx: z.number().min(0).max(40).default(8) } },
  { name: 'vignette', en: 'Vignette', id: 'Vignet', p: 'p0', flags: ['gpu'], params: { intensity: unit(0.4) }, tags: ['cinematic'] },
  { name: 'film-grain', en: 'Film grain', id: 'Butir film', p: 'p0', flags: ['gpu'], params: { intensity: unit(0.3) }, tags: ['retro', 'cinematic'] },
  { name: 'glow', en: 'Glow', id: 'Cahaya lembut', p: 'p0', flags: ['gpu'], params: { intensity: unit(0.5) }, tags: ['dreamy'] },
  { name: 'colour-grade', en: 'Colour grade', id: 'Gradasi warna', p: 'p0', flags: ['gpu'], params: { brightness: z.number().min(-1).max(1).default(0), contrast: z.number().min(-1).max(1).default(0), saturation: z.number().min(-1).max(1).default(0) } },
  { name: 'greenscreen', en: 'Green screen', id: 'Layar hijau', p: 'p0', flags: ['gpu'], params: { similarity: z.number().min(0.3).max(0.6).default(0.45), colour: hex('#00FF00') }, tags: ['chroma key'] },
  { name: 'pixelate', en: 'Pixelate', id: 'Piksel', p: 'p1', flags: ['gpu'], params: { blockPx: z.number().int().min(2).max(100).default(16) } },
  { name: 'halftone', en: 'Halftone', id: 'Cetakan koran', p: 'p1', flags: ['gpu'], params: { dotPx: z.number().int().min(2).max(60).default(8) } },
  { name: 'chromatic', en: 'Chromatic', id: 'Pendar warna', p: 'p1', flags: ['gpu'], params: { offsetPx: z.number().min(0).max(40).default(4) } },
  { name: 'wave', en: 'Wave', id: 'Gelombang', p: 'p1', flags: ['gpu'], params: { amplitude: unit(0.2), frequency: z.number().min(0.1).max(20).default(4) } },
  { name: 'thermal', en: 'Thermal', id: 'Kamera panas', p: 'p1', flags: ['gpu'] },
  { name: 'duotone', en: 'Duotone', id: 'Dua warna', p: 'p1', flags: ['gpu'], params: { colourA: hex('#14120F'), colourB: hex('#E8913A') } },
  { name: 'light-leak', en: 'Light leak', id: 'Bocor cahaya', p: 'p1', flags: ['gpu'], params: { intensity: unit(0.5) } },
  { name: 'scanlines', en: 'Scanlines', id: 'Garis TV', p: 'p2', flags: ['gpu'], params: { intensity: unit(0.4) } },
  { name: 'glitch-blocks', en: 'Glitch', id: 'Glitch', p: 'p2', flags: ['gpu'], params: { intensity: unit(0.5) } },
  { name: 'cylinder', en: 'Cylinder', id: 'Tabung', p: 'p2', flags: ['webgpu'], params: { rotation: z.number().min(-360).max(360).default(0) } },
  { name: 'sphere', en: 'Sphere', id: 'Bola', p: 'p2', flags: ['webgpu'], params: { rotation: z.number().min(-360).max(360).default(0) } },
  { name: 'page-turn', en: 'Page turn', id: 'Balik halaman', p: 'p2', flags: ['webgpu'], params: { progress: unit(0.5) } },
]);

export const audio = define('audio', {}, [
  { name: 'bed-soft', en: 'Soft music bed', id: 'Musik latar pelan', p: 'p0', params: { volume: unit(0.2), fadeMs: ms(1000, 0, 10_000) }, tags: ['music', 'musik', 'background'] },
  { name: 'duck-voice', en: 'Duck under voice', id: 'Redam saat suara', p: 'p0', propertyClass: 'exclusive-group', params: { volume: unit(0.5), duckTo: unit(0.15), rampMs: ms(500, 0, 5000) }, tags: ['ducking', 'voice', 'suara'] },
  { name: 'fade-in-out', en: 'Fade in/out', id: 'Pudar masuk-keluar', p: 'p0', params: { fadeInMs: ms(1000, 0, 10_000), fadeOutMs: ms(1000, 0, 10_000) } },
  { name: 'sfx-hit', en: 'Impact SFX', id: 'Efek hentakan', p: 'p1', params: { sampleId: z.string().default('hit-01') } },
  { name: 'visualizer-bars', en: 'Visualizer', id: 'Visualisasi', p: 'p2', params: { bars: z.union([z.literal(32), z.literal(64)]).default(32), colour: optionalHex() } },
]);

const textCommon = { fontSize: z.number().min(34).max(200).optional(), weight: z.number().int().min(100).max(900).optional(), align: z.enum(['left', 'center', 'right']).optional() };
export const texts = define('text', textCommon, [
  { name: 'title', en: 'Title', id: 'Judul', p: 'p0', data: { fontSize: 110, weight: 800, align: 'center', motionId: 'preset:motion.rise' }, tags: ['heading', 'big', 'besar'] },
  // ADR-034: every variant enters (and exits) with motion by default; preset:motion.none on the op makes a text static.
  { name: 'subtitle', en: 'Subtitle', id: 'Subjudul', p: 'p0', data: { fontSize: 64, weight: 600, align: 'center', motionId: 'preset:motion.rise' } },
  { name: 'lower-third', en: 'Lower third', id: 'Nama bawah', p: 'p0', data: { fontSize: 48, weight: 600, align: 'left', bar: true, anchor: 'bottom-left', motionId: 'preset:motion.slide-in' }, tags: ['name', 'nama'] },
  { name: 'callout', en: 'Callout', id: 'Sorotan', p: 'p0', data: { fontSize: 56, weight: 700, align: 'center', box: true, motionId: 'preset:motion.pop' } },
  { name: 'quote', en: 'Quote', id: 'Kutipan', p: 'p1', data: { fontSize: 72, weight: 500, align: 'center', italic: true, motionId: 'preset:motion.fade-in' } },
]);

export const textEffects = define('texteffect', { colour: optionalHex() }, [
  { name: 'highlight', en: 'Highlight', id: 'Stabilo', p: 'p0', tags: ['marker', 'emphasis'] },
  { name: 'underline', en: 'Underline', id: 'Garis bawah', p: 'p1' },
  { name: 'circle', en: 'Circle', id: 'Lingkari', p: 'p1' },
  { name: 'kinetic', en: 'Kinetic words', id: 'Kata bergerak', p: 'p0', tags: ['energetic', 'words'] },
  { name: 'counter', en: 'Number counter', id: 'Angka berjalan', p: 'p1', tags: ['number', 'angka'],
    params: { from: z.number().optional(), durationMs: z.number().int().min(100).max(20_000).optional(), delayMs: z.number().int().min(0).max(60_000).optional(), easingId: easingRef(), bezier: z.array(z.number().min(-2).max(3)).length(4).optional() } },
  { name: 'keyword', en: 'Keyword colour', id: 'Warna kata kunci', p: 'p1', tags: ['emphasis', 'accent', 'kata kunci'], params: { words: z.array(z.string().min(1).max(40)).max(8).default([]) } },
]);

export const fonts = define('font', {}, [
  { name: 'inter', en: 'Inter', id: 'Inter', p: 'p0', data: { family: 'Inter', fileStem: 'fonts/inter-latin', weights: [400, 500, 600, 700, 800] }, preview: false },
  { name: 'plus-jakarta-sans', en: 'Plus Jakarta Sans', id: 'Plus Jakarta Sans', p: 'p0', data: { family: 'Plus Jakarta Sans', fileStem: 'fonts/plus-jakarta-sans-latin', weights: [400, 500, 600, 700, 800] }, preview: false },
  { name: 'archivo', en: 'Archivo', id: 'Archivo', p: 'p0', data: { family: 'Archivo', fileStem: 'fonts/archivo-latin', weights: [400, 500, 600, 700, 800] }, preview: false },
  { name: 'jetbrains-mono', en: 'JetBrains Mono', id: 'JetBrains Mono', p: 'p0', data: { family: 'JetBrains Mono', fileStem: 'fonts/jetbrains-mono-latin', weights: [400, 500, 600, 700, 800] }, preview: false },
]);

// Book §4.4 palettes: background, text, accent 1, accent 2 (contrast-checked in the book).
export const palettes = define('palette', {}, [
  { name: 'editorial-dark', en: 'Editorial dark', id: 'Editorial gelap', p: 'p0', data: { bg: '#14120F', text: '#F4EFE6', accent: '#E8913A', accent2: '#4FD1A5' }, preview: false },
  { name: 'paper-light', en: 'Paper light', id: 'Kertas terang', p: 'p0', data: { bg: '#F6F1E7', text: '#1B1B1B', accent: '#C8372D', accent2: '#1F5F8B' }, preview: false },
  { name: 'neon-tech', en: 'Neon tech', id: 'Neon teknologi', p: 'p0', data: { bg: '#0B1020', text: '#E8F1FF', accent: '#00E5FF', accent2: '#FF3DB8' }, preview: false },
  { name: 'pastel-friendly', en: 'Pastel friendly', id: 'Pastel ramah', p: 'p0', data: { bg: '#FFF4EA', text: '#3A3350', accent: '#E5546F', accent2: '#2E9C86' }, preview: false },
  { name: 'high-contrast', en: 'High contrast', id: 'Kontras tinggi', p: 'p0', data: { bg: '#000000', text: '#FFFFFF', accent: '#FFE600', accent2: '#FF3B30' }, preview: false },
  // ADR-034: editorial data-journalism palette (reference video of QA 2026-10-28); extra roles read by the scene composer.
  { name: 'editorial-teal', en: 'Editorial teal', id: 'Editorial toska', p: 'p0', data: { bg: '#0F1A1F', text: '#FFFFFF', accent: '#5DCAA5', accent2: '#EF9F27', negative: '#F0997B', muted: '#9FB3B8', neutral: '#888780', pill: '#1D9E75' }, preview: false },
  { name: 'corporate-blue', en: 'Corporate blue', id: 'Korporat biru', p: 'p0', data: { bg: '#0D2A4A', text: '#F2F7FC', accent: '#4DA3FF', accent2: '#FFB020' }, preview: false },
]);

export const fontPairs = define('fontpair', {}, [
  { name: 'jakarta-inter', en: 'Jakarta + Inter', id: 'Jakarta + Inter', p: 'p0', data: { heading: 'preset:font.plus-jakarta-sans', body: 'preset:font.inter' }, preview: false },
  { name: 'archivo-inter', en: 'Archivo + Inter', id: 'Archivo + Inter', p: 'p0', data: { heading: 'preset:font.archivo', body: 'preset:font.inter' }, preview: false },
  { name: 'inter-mono', en: 'Inter + Mono', id: 'Inter + Mono', p: 'p0', data: { heading: 'preset:font.inter', body: 'preset:font.jetbrains-mono' }, preview: false },
  { name: 'inter-inter', en: 'Inter only', id: 'Inter saja', p: 'p0', data: { heading: 'preset:font.inter', body: 'preset:font.inter' }, preview: false },
]);

export const ALL_PRESETS: readonly PresetDef[] = Object.freeze([
  ...transitions, ...captions, ...backgrounds, ...motions, ...shapes, ...easings, ...effects, ...audio, ...texts, ...textEffects, ...fonts, ...palettes, ...fontPairs,
]);
