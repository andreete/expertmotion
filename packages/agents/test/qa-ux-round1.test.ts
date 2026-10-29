// QA UX fixes (round 1), P1-6: Anthropic 529 overloaded → "provider busy" (EM-4102), not "provider error" (EM-4103).
import { describe, expect, it } from 'vitest';
import { mapProviderError } from '../src/providers.js';

describe('QA UX round 1 — provider busy mapping', () => {
  it('maps HTTP 529 (Anthropic overloaded_error) to EM-4102', () => {
    const e = mapProviderError({ statusCode: 529, message: 'provider HTTP 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' });
    expect(e.code).toBe('EM-4102');
    expect((e.details as { overloaded?: boolean }).overloaded).toBe(true);
  });
  it('keeps other 5xx as EM-4103', () => {
    expect(mapProviderError({ statusCode: 500, message: 'provider HTTP 500: boom' }).code).toBe('EM-4103');
  });
});
