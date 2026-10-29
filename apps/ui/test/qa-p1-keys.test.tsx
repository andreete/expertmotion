// @vitest-environment jsdom
// QA P1 2026-10-29 (round 1): a wrong key (Anthropic 401 "invalid x-api-key") was only shown as "New keys can take 1–2 minutes
// to become active". Now: "Key tidak valid" + the provider's reason; the hint only for a recent key and only next to the reason;
// an older key or used-up retries say the key is wrong and offer "Ganti key".
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { el, chatComposer } from './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime } from '../src/state/runtime.js';
import { MockBus } from '../src/mock/MockEventSource.js';
import { KeyRetryNote } from '../src/screens/Providers.js';
import { KEY_RETRY_MAX } from '../src/state/key-retry.js';
import { translate } from '../src/i18n/index.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const until = async (fn: () => unknown, what: string, timeout = 8000) => waitFor(() => { if (!fn()) throw new Error(`waiting for ${what}`); }, { timeout });
const prefs = { onboardingDone: true, nudgesDismissed: [], outputCollapsed: false };

describe('QA P1: invalid key copy', () => {
  it('the Indonesian copy says "Key tidak valid" and "Ganti key"', () => {
    expect(translate('id', 'ui.agent.error.keyinvalid')).toBe('Key tidak valid');
    expect(translate('id', 'ui.agent.error.replacekey')).toBe('Ganti key');
    expect(translate('id', 'ui.agent.error.keyreason', { provider: 'Anthropic', reason: 'invalid x-api-key' })).toBe('Kata Anthropic: “invalid x-api-key”');
  });

  it('chat: an older key refused with "invalid x-api-key" → Key not valid + reason + "wrong key" + Replace key first, no 1–2 minute hint', { timeout: 30_000 }, async () => {
    try { localStorage.clear(); } catch { /* ignore */ }
    const bus = new MockBus();
    const runtime = createMockRuntime({ seed: 'sample', delays: false, bus });
    render(<StoreProvider runtime={runtime} initialPrefs={prefs}><App /></StoreProvider>);
    await until(() => el('stage.timeline') && el('agent.chat'), 'boot');
    chatComposer('brainstorm');
    await act(async () => { bus.emit('agent.run.failed', { runId: 'r1', agent: 'brainstorm', code: 'EM-4002', retryable: false, message: 'The AI provider rejected the key.', details: { recentKey: false, providerStatus: 401, reason: 'invalid x-api-key' } }); });
    await until(() => document.querySelector('[data-el="agent.chat.message"][data-code="EM-4002"]'), 'error card');
    const card = document.querySelector<HTMLElement>('[data-el="agent.chat.message"][data-code="EM-4002"]')!;
    expect(card.textContent).toContain('Key not valid');
    expect(card.querySelector('[data-el="agent.chat.error.reason"]')!.textContent).toContain('“invalid x-api-key”');
    expect(card.querySelector('[data-el="agent.chat.error.keywrong"]')).not.toBeNull();
    expect(card.querySelector('[data-el="agent.chat.error.keyhint"]')).toBeNull();
    expect(card.textContent).not.toContain('1–2 minutes');
    const first = card.querySelector<HTMLElement>('[data-action]')!;
    expect(first.getAttribute('data-action')).toBe('providers');
    expect(first.textContent).toBe('Replace key');
    await act(async () => { fireEvent.click(first); });
    await until(() => el('scr.providers'), 'providers screen');
  });

  it('Providers note: hint only with a reason while retries remain; after the retries "wrong key" + Replace key', () => {
    const runtime = createMockRuntime({ seed: 'sample', delays: false, bus: new MockBus() });
    const onReplace = vi.fn();
    const r1 = render(<StoreProvider runtime={runtime} initialPrefs={prefs}><KeyRetryNote attempt={0} onRetry={() => undefined} provider="Anthropic" /></StoreProvider>);
    expect(el('scr.providers.keyhint')!.textContent).toContain('Key not valid');
    expect(el('scr.providers.keyhint')!.textContent).not.toContain('1–2 minutes');            // no reason → never the hint alone
    r1.unmount();
    const r2 = render(<StoreProvider runtime={runtime} initialPrefs={prefs}><KeyRetryNote attempt={0} onRetry={() => undefined} provider="Anthropic" reason="invalid x-api-key" /></StoreProvider>);
    expect(el('scr.providers.keyreason')!.textContent).toBe('Anthropic says: “invalid x-api-key”');
    expect(el('scr.providers.keyhint')!.textContent).toContain('New keys can take 1–2 minutes to become active.');
    expect(el('scr.providers.keywrong')).toBeNull();
    r2.unmount();
    render(<StoreProvider runtime={runtime} initialPrefs={prefs}><KeyRetryNote attempt={KEY_RETRY_MAX} onRetry={() => undefined} provider="Anthropic" reason="invalid x-api-key" onReplace={onReplace} /></StoreProvider>);
    expect(el('scr.providers.keyhint')!.textContent).not.toContain('1–2 minutes');
    expect(el('scr.providers.keywrong')!.textContent).toContain('This key is wrong or no longer active');
    fireEvent.click(el('scr.providers.replacekey')!);
    expect(onReplace).toHaveBeenCalledTimes(1);
  });
});
