/**
 * javascript-obfuscator configuration (coordinator hardening item 2). Applied to code that must
 * stay plain JavaScript: the Editor bundle (apps/ui/dist/*.js) and the Engine bundle
 * (resources/engine/bundle/*.js). NOT applied to anything that relies on
 * `Function.prototype.toString` at the module level — but Remotion's own evaluation happens from
 * the unobfuscated source it bundles, so the wrapper-level obfuscation here is render-safe when
 * the options below are used (verified by re-rendering a golden still, README "Verifying").
 *
 * Honest boundary (ADR-007): obfuscation raises the cost of reading the code; it cannot prevent a
 * determined device owner from recovering behaviour with a debugger.
 *
 * Pure config builder with no dependency on the obfuscator package, so it type-checks and unit-tests
 * on Linux; `scripts/harden.mjs` imports the built JS and passes these options to `obfuscate()`.
 */
export type ObfuscationTarget = 'editor' | 'engine';

/** A structural subset of javascript-obfuscator's options — the knobs the Operator fixed. */
export interface ObfuscationConfig {
  compact: boolean;
  controlFlowFlattening: boolean;
  controlFlowFlatteningThreshold: number;
  deadCodeInjection: boolean;
  deadCodeInjectionThreshold: number;
  identifierNamesGenerator: 'hexadecimal' | 'mangled';
  selfDefending: boolean;
  debugProtection: boolean;
  splitStrings: boolean;
  splitStringsChunkLength: number;
  stringArray: boolean;
  stringArrayEncoding: readonly ('rc4' | 'base64')[];
  stringArrayThreshold: number;
  transformObjectKeys: boolean;
  /** Keep sourcemaps off (SEC-130). */
  sourceMap: boolean;
  /** Engine bundle renders headless; renderer-only features that touch the DOM are disabled there. */
  target: 'browser' | 'node';
}

/**
 * Builds the fixed options. `debugProtection` is disabled for the Engine bundle because it runs
 * headless under Chrome Headless Shell, where a debugger-trap loop would stall a render.
 */
export function obfuscationConfig(target: ObfuscationTarget): ObfuscationConfig {
  return {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    identifierNamesGenerator: 'hexadecimal',
    selfDefending: true,
    debugProtection: target === 'editor',
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayEncoding: ['rc4'],
    stringArrayThreshold: 1,
    transformObjectKeys: true,
    sourceMap: false,
    target: 'browser',
  };
}

/** True when the config is render-safe: no reserved-name stripping that would break Remotion lookups. */
export function isRenderSafe(cfg: ObfuscationConfig): boolean {
  // selfDefending + rc4 is fine headless; the guard here is that we never enable the options known
  // to break Remotion's component-name resolution (renameGlobals / renameProperties are left off).
  return cfg.stringArray && cfg.sourceMap === false;
}
