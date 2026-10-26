// @vitest-environment jsdom
// Entry 25b: provider actions and long agent runs say what is happening ("Menguji koneksi…", "Mencoba lagi (2/3)…",
// "Memperbaiki rencana (2/3)…", "Penyedia sibuk, mencoba lagi (1/2)…"), as a status line that is never an error.
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime } from '../src/state/runtime.js';
import { BusyLine } from '../src/screens/Providers.js';
import { errorActions, progressText } from '../src/agent/Chat.js';
import { translate } from '../src/i18n/index.js';

afterEach(() => cleanup());
const en = (k: string, v?: Record<string, string | number>) => translate('en', k, v);
const id = (k: string, v?: Record<string, string | number>) => translate('id', k, v);

describe('agent progress text', () => {
  it('correction rounds and rate-limit waits show n/of', () => {
    expect(progressText({ phase: 'correcting', attempt: 2, of: 3 }, id)).toBe('Memperbaiki rencana (2/3)…');
    expect(progressText({ phase: 'correcting', attempt: 2 }, id)).toBe('Memperbaiki rencana (percobaan 2)…');
    expect(progressText({ phase: 'waiting', attempt: 1, of: 2 }, id)).toBe('Penyedia sibuk, mencoba lagi (1/2)…');
    expect(progressText({ phase: 'waiting', attempt: 2, of: 2 }, en)).toBe('The provider is busy, trying again (2/2)…');
  });
  it('EM-4102 offers Try again and Switch model; the free-model copy exists in both languages', () => {
    expect(errorActions('EM-4102')).toEqual(['retry', 'switchmodel']);
    expect(id('err.EM-4102.free.body')).toBe('Model gratis sedang dibatasi penyedia, coba lagi sebentar atau pilih model lain.');
    expect(en('err.EM-4102.free.body')).toContain('Free models');
  });
});

describe('BusyLine (scr.providers.busy)', () => {
  const mount = (ui: React.ReactElement) => render(<StoreProvider runtime={createMockRuntime()}>{ui}</StoreProvider>);
  it('shows one status per action and the retry count, never as an alert', () => {
    const { container, rerender } = mount(<BusyLine busy="test" />);
    const line = () => container.querySelector('[data-el="scr.providers.busy"]');
    expect(line()?.getAttribute('role')).toBe('status');
    expect(line()?.getAttribute('data-busy')).toBe('test');
    expect(line()?.textContent).toContain('Testing the connection…');
    rerender(<StoreProvider runtime={createMockRuntime()}><BusyLine busy="validate" retry={{ n: 2, of: 3 }} /></StoreProvider>);
    expect(line()?.textContent).toContain('Trying again (2/3)…');
    rerender(<StoreProvider runtime={createMockRuntime()}><BusyLine busy="models" /></StoreProvider>);
    expect(line()?.textContent).toContain('Loading the model list…');
    rerender(<StoreProvider runtime={createMockRuntime()}><BusyLine busy={null} /></StoreProvider>);
    expect(line()).toBeNull();
  });
});
