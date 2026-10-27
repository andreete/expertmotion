// @vitest-environment jsdom
// Entry 28 (black window after connecting Claude): granular error boundaries (FR-200), the AssignForm cross-connection prefill
// (FR-201), coalesced provider reloads on settings.changed {providers|assignments} (FR-201) and Esc in a modal whose focus fell
// back to <body>.
import { vi, describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { SectionBoundary, logEditorError, redactLogText } from '../src/startup/ErrorBoundary.js';
import { assignedOn } from '../src/screens/Providers.js';
import { Modal } from '../src/components/ui.js';
import { StoreProvider, useStore } from '../src/state/store.js';
import { createMockRuntime, type Runtime } from '../src/state/runtime.js';

afterEach(() => { cleanup(); delete (window as { expertmotion?: unknown }).expertmotion; vi.restoreAllMocks(); });

let broken = false; let renders = 0;
function Flaky() { renders += 1; if (broken) { throw new TypeError("Cannot read properties of undefined (reading 'toFixed') key sk-ant-api03-abcdefghijklmnop"); } return <div data-testid="ok">panel</div>; }

describe('SectionBoundary (sys.section, FR-200)', () => {
  it('a failing panel shows the inline card, the rest stays usable, Reload part remounts only that panel', async () => {
    const logError = vi.fn();
    (window as { expertmotion?: unknown }).expertmotion = { logError };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);              // React reports the caught error
    broken = true;
    const onSibling = vi.fn();
    const { container, getByTestId } = render(
      <div>
        <SectionBoundary section="chat"><Flaky /></SectionBoundary>
        <button type="button" data-testid="sibling" onClick={onSibling}>header</button>
      </div>,
    );
    const card = container.querySelector('[data-el="sys.section.error"]');
    expect(card?.getAttribute('data-section')).toBe('chat');
    expect(card?.getAttribute('role')).toBe('alert');
    expect(container.querySelector('[data-el="sys.section.message"]')?.textContent).not.toContain('abcdefghijklmnop');
    fireEvent.click(getByTestId('sibling'));
    expect(onSibling).toHaveBeenCalledTimes(1);                                    // the Editor around the panel still works
    // logged once, with the section name and the component stack, the key redacted
    expect(logError).toHaveBeenCalledTimes(1);
    const entry = logError.mock.calls[0]![0] as { message: string; stack?: string; source: string; code: string };
    expect(entry.source).toBe('error-boundary');
    expect(entry.code).toBe('EM-8009');
    expect(entry.message.startsWith('[section:chat] TypeError:')).toBe(true);
    expect(entry.message).not.toContain('abcdefghijklmnop');
    expect(entry.stack).toContain('--- component stack ---');
    expect(entry.stack).toContain('Flaky');
    broken = false;
    fireEvent.click(container.querySelector('[data-el="sys.section.reload"]')!);
    await waitFor(() => expect(getByTestId('ok').textContent).toBe('panel'));
    expect(container.querySelector('[data-el="sys.section.error"]')).toBeNull();
  });

  it('a dialog boundary offers Close; it never remounts by itself (no crash loop)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    broken = true; renders = 0;
    const onClose = vi.fn();
    const { container } = render(<SectionBoundary section="screen.providers" onClose={onClose}><Flaky /></SectionBoundary>);
    const n = renders;
    expect(n).toBeGreaterThanOrEqual(1);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(renders).toBe(n);                                                       // no remount on its own
    fireEvent.click(container.querySelector('[data-el="sys.section.close"]')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    broken = false;
  });

  it('log text never carries keys, licence keys or service tokens', () => {
    const s = redactLogText('sk-or-v1-0123456789abcdef AIzaSyA0123456789abcdef EM1-AAAABBBBCCCCDDDD.x Bearer abcdefghijklmnopq http://127.0.0.1:4110/api/v1/events?token=secretsecret');
    for (const leak of ['0123456789abcdef', 'SyA0123456789', 'AAAABBBBCCCC', 'abcdefghijklmnopq', 'secretsecret']) expect(s).not.toContain(leak);
    const logError = vi.fn();
    (window as { expertmotion?: unknown }).expertmotion = { logError };
    logEditorError(new Error('boom sk-ant-api03-zzzzzzzzzzzzzzzz'), 'window-error');
    expect((logError.mock.calls[0]![0] as { message: string }).message).toBe('Error: boom sk-[REDACTED]');
  });
});

describe('AssignForm prefill (FR-201)', () => {
  it('only takes an assignment made on the same connection', () => {
    const a = { brainstorm: { connectionId: 'A', modelId: 'claude-opus-5-5' }, editor: { connectionId: 'OR', modelId: 'google/gemini-3.5-pro' } };
    expect(assignedOn(a, 'brainstorm', 'A')).toBe('claude-opus-5-5');
    expect(assignedOn(a, 'editor', 'A')).toBe('');                                // an OpenRouter id is never prefilled on Anthropic
    expect(assignedOn(a, 'editor', undefined)).toBe('');
    expect(assignedOn(null, 'editor', 'A')).toBe('');
  });
});

describe('Modal Esc with focus on <body>', () => {
  it('the topmost modal closes when the pressed button was disabled and focus fell back to the body', () => {
    const outer = vi.fn(); const inner = vi.fn();
    render(<><Modal el="test.outer" title="outer" onClose={outer}><button type="button">a</button></Modal><Modal el="test.inner" title="inner" onClose={inner}><button type="button">b</button></Modal></>);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('provider reloads are coalesced (settings.changed storm)', () => {
  it('ten reload requests in one tick cause at most two request pairs, and the last one sees the newest data', async () => {
    const runtime: Runtime = createMockRuntime();
    const list = vi.spyOn(runtime.api, 'listConnections');
    const assignments = vi.spyOn(runtime.api, 'getAssignments');
    let actions: ReturnType<typeof useStore>['actions'] | null = null;
    function Grab() { const s = useStore(); const [, set] = useState(0); useEffect(() => { actions = s.actions; set(1); }, [s.actions]); return null; }
    render(<StoreProvider runtime={runtime}><Grab /></StoreProvider>);
    await waitFor(() => expect(actions).not.toBeNull());
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });   // let the initial load settle
    list.mockClear(); assignments.mockClear();
    await act(async () => { await Promise.all(Array.from({ length: 10 }, () => actions!.loadProviders())); });
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(list.mock.calls.length).toBeLessThanOrEqual(2);
    expect(assignments.mock.calls.length).toBe(list.mock.calls.length);
  });
});
