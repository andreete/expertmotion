// @vitest-environment jsdom
// R1 (review 2026-10-29): research source links go through the Shell's openSource route and honour Private Mode.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSource } from '../src/components/ExternalLink.js';

type W = { expertmotion?: unknown };
afterEach(() => { delete (window as W).expertmotion; vi.restoreAllMocks(); });

describe('openSource (R1)', () => {
  it('uses the Shell openSource route, upgrading http to https', async () => {
    const shell = { openSource: vi.fn(async () => ({ ok: true as const })), openExternal: vi.fn() };
    (window as W).expertmotion = shell;
    expect(await openSource('http://www.bps.go.id/id', false)).toEqual({ ok: true });
    expect(shell.openSource).toHaveBeenCalledWith('https://www.bps.go.id/id');
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
  it('Private Mode refuses before the Shell is asked (EM-8202)', async () => {
    const shell = { openSource: vi.fn(async () => ({ ok: true as const })) };
    (window as W).expertmotion = shell;
    expect(await openSource('https://www.bps.go.id/', true)).toEqual({ ok: false, code: 'EM-8202' });
    expect(shell.openSource).not.toHaveBeenCalled();
  });
  it('passes the Shell refusal code through', async () => {
    (window as W).expertmotion = { openSource: async () => ({ ok: false, code: 'EM-8202', message: 'Private Mode aktif' }) };
    expect(await openSource('https://example.com/', false)).toEqual({ ok: false, code: 'EM-8202' });
  });
  it('non-web schemes are refused; an older Shell without the route never falls back to openExternal', async () => {
    const shell = { openExternal: vi.fn() };
    (window as W).expertmotion = shell;
    expect(await openSource('javascript:alert(1)', false)).toEqual({ ok: false, code: 'EM-8203' });
    expect(await openSource('https://example.com/', false)).toEqual({ ok: false, code: 'EM-8203' });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
  it('a development browser opens a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    expect(await openSource('https://example.com/a', false)).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer');
  });
});
