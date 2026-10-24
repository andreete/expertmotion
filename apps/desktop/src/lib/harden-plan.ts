/**
 * Hardening pipeline planner (coordinator hardening items 1–4). `scripts/harden.mjs` is thin:
 * it asks this pure module what steps to run for a given set of flags, then executes them.
 * Planning is unit-tested on Linux; the heavy steps (bytenode on Windows Electron, obfuscation,
 * encryption) run only in the build.
 */
export interface HardenFlags {
  /** `--no-bytecode` escape hatch: skip V8 bytecode compilation entirely. */
  bytecode: boolean;
  /** Skip obfuscation (e.g. a debug build). */
  obfuscate: boolean;
  /** Skip prompt-asset encryption. */
  encryptPrompts: boolean;
  /** Skip integrity-manifest generation/signing. */
  integrity: boolean;
  /** True on the Windows build machine; bytenode of Electron code only works there. */
  isWindows: boolean;
}

export type HardenStepId =
  | 'bytecode:service'
  | 'bytecode:main'
  | 'obfuscate:editor'
  | 'obfuscate:engine'
  | 'encrypt:prompts'
  | 'integrity:manifest';

export interface HardenStep {
  id: HardenStepId;
  /** Human-readable, logged by the script. */
  description: string;
  /** True when the step cannot run in this environment and is skipped with a warning. */
  skipped: boolean;
  skipReason?: string;
}

/**
 * Files that must NOT be bytecode-compiled because something relies on
 * `Function.prototype.toString` (bytenode replaces source with a dummy). The Remotion renderer
 * path is already excluded by construction (it lives in resources/engine, served to Chrome), but
 * we list it so the exclusion is explicit and testable.
 */
export const BYTECODE_EXCLUSIONS: readonly string[] = [
  'resources/engine/bundle/**', // Remotion evaluates component source in Chrome; never bytecode.
  'dist/ui/**', // the Editor is renderer JS, obfuscated instead.
  'dist/service/*.jsc', // already compiled; do not recompile.
];

export function isExcludedFromBytecode(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  return BYTECODE_EXCLUSIONS.some((glob) => {
    const prefix = glob.replace(/\*\*$/, '').replace(/\*$/, '');
    return glob.endsWith('**') ? norm.startsWith(prefix) : glob.includes('*') ? norm.startsWith(prefix) : norm === glob;
  });
}

/** Produces the ordered step list for the given flags; steps that cannot run here are marked skipped. */
export function planHardening(flags: HardenFlags): HardenStep[] {
  const steps: HardenStep[] = [];
  const winOnly = (id: HardenStepId, description: string): HardenStep =>
    flags.isWindows
      ? { id, description, skipped: false }
      : { id, description, skipped: true, skipReason: 'bytecode must be compiled with the pinned Electron on the Windows build machine (POC-006)' };

  if (flags.bytecode) {
    // Service first (utilityProcess context), then main (browser-process context): different V8 snapshots.
    steps.push(winOnly('bytecode:service', 'Compile service.cjs → service.jsc (+ loader) with bytenode compileElectronCode'));
    steps.push(winOnly('bytecode:main', 'Compile main.cjs → main.jsc with bytenode compileElectronMainCode'));
  }
  if (flags.obfuscate) {
    steps.push({ id: 'obfuscate:editor', description: 'Obfuscate apps/ui/dist/*.js (debugProtection on)', skipped: false });
    steps.push({ id: 'obfuscate:engine', description: 'Obfuscate resources/engine/bundle/*.js (debugProtection off, headless)', skipped: false });
  }
  if (flags.encryptPrompts) {
    steps.push({ id: 'encrypt:prompts', description: 'AES-256-GCM encrypt the prompts module; key split across service bytecode + build constant', skipped: false });
  }
  if (flags.integrity) {
    // Must run last so it hashes the final .jsc and obfuscated bundles.
    steps.push({ id: 'integrity:manifest', description: 'Hash protected artefacts and sign the Ed25519 integrity manifest', skipped: false });
  }
  return steps;
}
