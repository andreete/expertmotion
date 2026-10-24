// Shared jsdom setup for the Editor render tests: browser APIs jsdom lacks and a mock-mode render helper.
// Each test file mocks '@remotion/player' with ./player-mock.tsx (the real Player needs media/canvas APIs jsdom lacks).
import { render, waitFor, type RenderResult } from '@testing-library/react';

class RO { observe() {} unobserve() {} disconnect() {} }
const g = globalThis as Record<string, unknown>;
g['ResizeObserver'] ??= RO;
g['IS_REACT_ACT_ENVIRONMENT'] = true;
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollTo ??= function scrollTo() {};
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  URL.createObjectURL ??= () => 'blob:mock';
}

import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime, type Runtime } from '../src/state/runtime.js';

export async function renderEditor(seed: 'sample' | 'empty' = 'sample'): Promise<RenderResult & { runtime: Runtime }> {
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  const runtime = createMockRuntime({ seed, delays: false });
  const r = render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
  await waitFor(() => { if (!document.querySelector('[data-el="stage.timeline"]') || !document.querySelector('[data-el="hdr.title"]')?.textContent?.trim()) throw new Error('not booted'); });
  await waitFor(() => { if (!document.querySelector('[data-el="agent.output.ratio.9x16"][aria-checked]')) throw new Error('no project'); });
  return { ...r, runtime };
}

export const el = (id: string): HTMLElement | null => document.querySelector(`[data-el="${id}"]`);
export const els = (id: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-el="${id}"]`)];
export function present(id: string): boolean {
  return [...document.querySelectorAll('[data-el]')].some((n) => { const v = n.getAttribute('data-el') ?? ''; return v === id || v.startsWith(`${id}.`); });
}
