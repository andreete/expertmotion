// Runtime prompt set (SYSTEM_PROMPT.md; SEC-133 prompt encryption). Development and tests use the
// generated module directly. Release builds replace prompts.generated with empty strings and ship the
// real set encrypted (dist/assets.enc); the Local Service decrypts it at startup and installs it here.
import { BRAINSTORM_SYSTEM, EDITOR_SYSTEM, SOCIAL_CAPTION_PROMPT } from './prompts.generated.js';

export interface PromptSet { BRAINSTORM_SYSTEM: string; EDITOR_SYSTEM: string; SOCIAL_CAPTION_PROMPT: string }
export const PROMPT_SET_KEYS = ['BRAINSTORM_SYSTEM', 'EDITOR_SYSTEM', 'SOCIAL_CAPTION_PROMPT'] as const;

let installed: PromptSet | null = null;

/** Installs the decrypted prompt set (called once by the Local Service in release builds). */
export function installPromptSet(set: PromptSet): void {
  for (const k of PROMPT_SET_KEYS) if (typeof set[k] !== 'string' || set[k] === '') throw new Error(`prompt set: ${k} missing`);
  installed = { BRAINSTORM_SYSTEM: set.BRAINSTORM_SYSTEM, EDITOR_SYSTEM: set.EDITOR_SYSTEM, SOCIAL_CAPTION_PROMPT: set.SOCIAL_CAPTION_PROMPT };
}

/** The active prompt set. Throws when a release build has not installed its decrypted set. */
export function prompts(): PromptSet {
  if (installed) return installed;
  // Widened to string: release builds stub these constants with empty strings.
  const bundled: PromptSet = { BRAINSTORM_SYSTEM, EDITOR_SYSTEM, SOCIAL_CAPTION_PROMPT };
  if (bundled.EDITOR_SYSTEM === '' || bundled.BRAINSTORM_SYSTEM === '') throw new Error('prompt set not installed');
  return bundled;
}
