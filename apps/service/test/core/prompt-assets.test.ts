import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decryptPromptSet, encryptPromptSet, loadPromptAssets, promptKey } from '../../src/services/prompt-assets.js';
import { prompts } from '@expertmotion/agents';
import { deriveAssetKey } from '../../../desktop/src/lib/keysplit.js';

const hex = () => crypto.randomBytes(32).toString('hex');
const SET = { BRAINSTORM_SYSTEM: 'brainstorm prompt', EDITOR_SYSTEM: 'editor prompt', SOCIAL_CAPTION_PROMPT: 'social prompt' };

describe('encrypted prompt set (SEC-133)', () => {
  it('derives the same key as the Desktop Shell key split', () => {
    const a = hex(); const b = hex();
    const desk = deriveAssetKey(a, b, (buf) => new Uint8Array(crypto.createHash('sha256').update(buf).digest()));
    expect(Buffer.from(desk).equals(promptKey(a, b))).toBe(true);
  });

  it('round-trips and rejects a wrong key or altered data', () => {
    const a = hex(); const b = hex(); const key = promptKey(a, b);
    const blob = encryptPromptSet(SET, key);
    expect(blob.includes(Buffer.from('editor prompt'))).toBe(false);
    expect(decryptPromptSet(blob, key)).toEqual(SET);
    expect(() => decryptPromptSet(blob, promptKey(a, hex()))).toThrow();
    const tampered = Buffer.from(blob); tampered[tampered.length - 1]! ^= 1;
    expect(() => decryptPromptSet(tampered, key)).toThrow();
  });

  it('development builds (no half A) keep the bundled prompts', () => {
    expect(loadPromptAssets(undefined, '/nonexistent', '')).toBe(false);
    expect(prompts().EDITOR_SYSTEM).toContain('Editor Agent');
  });

  it('release builds fail with EM-8007 without half B, and install the set with it', () => {
    const a = hex(); const b = hex();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'em-pa-')), 'assets.enc');
    fs.writeFileSync(file, encryptPromptSet(SET, promptKey(a, b)));
    expect(() => loadPromptAssets(undefined, file, a)).toThrow(expect.objectContaining({ code: 'EM-8007' }));
    expect(() => loadPromptAssets(hex(), file, a)).toThrow(expect.objectContaining({ code: 'EM-8007' }));
    expect(loadPromptAssets(b, file, a)).toBe(true);
    expect(prompts()).toEqual(SET);
  });
});
