import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOWNLOAD_HOSTS, EXCLUDED_MODELS, MODEL_KEYS, TIER_DEFAULTS, TO_PIN, allowedHosts, defaultModelFor, getModel, isBelowMinTier, isCommerciallyAllowed,
  isInstallable, isPinned, modelsOfferedFor, normalizeModelKey, registry, requireModel, type Tier,
} from '../src/index.js';

const DOCS = join(__dirname, '..', '..', '..', 'docs');
const doc = readFileSync(join(DOCS, 'LOCAL_AI_MODELS.md'), 'utf8');
const section = (from: string, to: string): string => doc.slice(doc.indexOf(from), doc.indexOf(to, doc.indexOf(from)));

describe('registry ↔ LOCAL_AI_MODELS.md', () => {
  const regSection = section('## 2. Registry', '### 2.5');
  const docIds = [...regSection.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);

  it('lists every model id of §2.1–2.4 and nothing else', () => {
    expect(docIds.length).toBe(14);
    expect([...MODEL_KEYS].sort()).toEqual([...docIds].sort());
  });

  it('uses the doc file names and Hugging Face repos', () => {
    for (const m of Object.values(registry)) for (const f of m.files) {
      expect(regSection.includes(f.name) || regSection.includes(f.name.replace(/\.json$/, '')), f.name).toBe(true);
      expect(f.url.startsWith('https://huggingface.co/')).toBe(true);
      expect(regSection).toContain(f.url.split('/')[3]!); // org name appears in the doc row
    }
  });

  it('matches the §5 Hardware Tier → defaults table', () => {
    const t5 = section('## 5. Hardware Tier', '## 6.');
    const rows: [string, Parameters<typeof defaultModelFor>[0], 'id' | 'en'][] = [
      ['Captions (STT)', 'stt', 'id'], ['Voice (TTS, id)', 'tts', 'id'], ['Voice (TTS, en)', 'tts', 'en'], ['Music', 'music', 'id'], ['Thumbnail', 'image', 'id'],
    ];
    for (const [label, task, language] of rows) {
      const line = t5.split('\n').find((l) => l.startsWith(`| ${label} |`))!;
      const cells = line.split('|').slice(2, 5).map((c) => c.trim());
      let prev = '';
      (['T0', 'T1', 'T2'] as Tier[]).forEach((tier, i) => {
        const cell = cells[i]!;
        const ids = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).filter((id) => MODEL_KEYS.includes(id));
        const expected = cell.startsWith('same') ? prev : ids[0]!;
        expect(defaultModelFor(task, tier, { language }), `${label} ${tier}`).toBe(expected);
        for (const id of ids) if (id !== expected) expect(modelsOfferedFor(task, tier, { language })).toContain(id);
        prev = expected;
      });
    }
  });

  it('every row has licence, redistribution, flag consistency, minTier and sha256 or TO_PIN (QA-LM-001)', () => {
    for (const m of Object.values(registry)) {
      expect(m.licence.name.length).toBeGreaterThan(0);
      expect(['yes', 'no', 'verify']).toContain(m.licence.redistribution);
      expect(['T0', 'T1', 'T2']).toContain(m.minTier);
      if (m.flag) expect(regSection).toContain(m.flag);
      for (const f of m.files) { expect(f.sha256 === TO_PIN || /^[0-9a-f]{64}$/.test(f.sha256)).toBe(true); expect(Number.isInteger(f.bytes)).toBe(true); }
      if (m.files.length) expect(m.bytes).toBe(m.files.reduce((a, f) => a + f.bytes, 0));
      for (const t of m.recommendedFor) expect(isBelowMinTier(m.key, t)).toBe(false);
    }
  });

  it('every downloadable file is pinned to a Hugging Face commit with sha256 and exact size (pins.ts)', () => {
    for (const m of Object.values(registry).filter((d) => d.availability === 'download' && d.files.length)) {
      expect(isPinned(m), m.key).toBe(true);
      for (const f of m.files) {
        expect(f.url).toMatch(new RegExp(`^https://huggingface\\.co/[^/]+/[^/]+/resolve/${f.revision}/`));
        expect(f.revision).toMatch(/^[0-9a-f]{40}$/); expect(f.sha256).toMatch(/^[0-9a-f]{64}$/); expect(f.bytesExact).toBe(true);
      }
    }
  });

  it('download hosts equal SECURITY.md SEC-071', () => {
    const sec = readFileSync(join(DOCS, 'SECURITY.md'), 'utf8');
    const row = sec.split('\n').find((l) => l.startsWith('| SEC-071 |'))!;
    const hosts = [...row.matchAll(/`((?:\*\.)?[a-z0-9.-]+\.[a-z]+)`/g)].map((m) => m[1]!);
    expect([...DOWNLOAD_HOSTS].sort()).toEqual([...new Set(hosts)].sort());
    expect(allowedHosts({ operatorHost: 'Releases.Example.org' })).toContain('releases.example.org');
  });

  it('excluded models are never in the registry', () => {
    const excl = section('### 2.7', '## 3.');
    expect(EXCLUDED_MODELS.length).toBe([...excl.matchAll(/^\| (?!Model|---)/gm)].length);
    for (const e of EXCLUDED_MODELS) expect(MODEL_KEYS.some((k) => e.name.toLowerCase().includes(k))).toBe(false);
  });
});

describe('registry helpers', () => {
  it('normalises the DATABASE_SCHEMA dotted key form', () => {
    expect(normalizeModelKey('whisper.large-v3-turbo')).toBe('whisper-large-v3-turbo');
    expect(normalizeModelKey('whisper-small')).toBe('whisper-small');
    expect(normalizeModelKey('nope')).toBeNull();
    expect(getModel('whisper.small')?.engine).toBe('whisper.cpp');
    expect(() => requireModel('musicgen')).toThrow(RangeError);
  });
  it('commercial use', () => {
    expect(isCommerciallyAllowed('whisper-small')).toBe(true);
    expect(isCommerciallyAllowed('sd15-emaonly')).toBe(true);
    expect(isCommerciallyAllowed('stable-audio-open-1.0')).toBe(false);
    expect(isCommerciallyAllowed('musicgen')).toBe(false);
  });
  it('tier defaults (QA-LM-007: T0 whisper-small, FLUX not offered on T0)', () => {
    expect(defaultModelFor('stt', 'T0')).toBe('whisper-small');
    expect(defaultModelFor('tts', 'T2', { language: 'en' })).toBe('kokoro-82m-v1.0');
    expect(defaultModelFor('tts', 'T2')).toBe('piper-id-news-medium');
    expect(modelsOfferedFor('image', 'T0')).toEqual(['frame-composite', 'sd15-emaonly']);
    expect(isBelowMinTier('flux1-schnell-q4', 'T0')).toBe(true);
    expect(isBelowMinTier('ace-step-v1-3.5b', 'T1')).toBe(false);
    expect(Object.keys(TIER_DEFAULTS)).toEqual(['stt', 'tts.id', 'tts.en', 'music', 'image']);
  });
});
