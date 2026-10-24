// FR-003 Engine browser warm-up: one browser at most, memory-gated, lent to one render at a time, closed when idle or unhealthy.
import { describe, expect, it } from 'vitest';
import { EngineBrowser, warmupEnabled, type BrowserLike, type WarmTimers } from '../../src/services/engine-browser.js';

function fakeTimers() {
  const due: Array<{ fn: () => void; id: number }> = []; let n = 0;
  const t: WarmTimers = { set: (fn) => { const id = ++n; due.push({ fn, id }); return id; }, clear: (id) => { const i = due.findIndex((d) => d.id === id); if (i >= 0) due.splice(i, 1); } };
  return { t, fire: () => { const all = due.splice(0); for (const d of all) d.fn(); }, pending: () => due.length };
}
function fakeBrowser() { const b = { closed: 0, close: async () => { b.closed++; } }; return b; }

describe('EngineBrowser', () => {
  it('skips the warm-up when memory is short', async () => {
    let opened = 0;
    const eb = new EngineBrowser({ open: async () => { opened++; return fakeBrowser(); }, freeMemBytes: () => 1024 ** 3 });
    expect(await eb.warm()).toBe(false);
    expect(opened).toBe(0);
    expect(await eb.acquire()).toBeNull();
  });

  it('opens once, lends the browser to one render, re-arms the idle close and closes unhealthy browsers', async () => {
    const browsers: Array<ReturnType<typeof fakeBrowser>> = [];
    const timers = fakeTimers();
    const eb = new EngineBrowser({ open: async () => { const b = fakeBrowser(); browsers.push(b); return b; }, freeMemBytes: () => 8 * 1024 ** 3, timers: timers.t });
    const [a, b] = await Promise.all([eb.warm(), eb.warm()]);
    expect(a && b).toBe(true);
    expect(browsers).toHaveLength(1);                                  // concurrent warm() share one launch
    const lent = await eb.acquire();
    expect(lent).toBe(browsers[0]);
    expect(await eb.acquire()).toBeNull();                              // a second render launches its own
    expect(timers.pending()).toBe(0);                                   // no idle close while lent
    eb.release(true);
    expect(eb.ready).toBe(true);
    timers.fire();                                                      // idle period elapsed
    await Promise.resolve();
    expect(browsers[0]!.closed).toBe(1);
    expect(eb.ready).toBe(false);
    await eb.warm();
    const second = await eb.acquire() as BrowserLike;
    eb.release(false);                                                  // failed render: not reused
    await Promise.resolve();
    expect(browsers[1]!.closed).toBe(1);
    expect(second).toBe(browsers[1]);
    await eb.stop();
    expect(await eb.warm()).toBe(false);
  });

  it('a failed launch is ignored', async () => {
    const eb = new EngineBrowser({ open: async () => { throw new Error('no chrome'); }, freeMemBytes: () => 8 * 1024 ** 3 });
    expect(await eb.warm()).toBe(false);
    expect(await eb.acquire()).toBeNull();
  });

  it('is on only for packaged builds unless forced, never under tests', () => {
    expect(warmupEnabled({ VITEST: 'true' }, true)).toBe(false);
    expect(warmupEnabled({}, true)).toBe(true);
    expect(warmupEnabled({}, false)).toBe(false);
    expect(warmupEnabled({ EM_ENGINE_WARMUP: '1', VITEST: 'true' }, false)).toBe(true);
    expect(warmupEnabled({ EM_ENGINE_WARMUP: '0' }, true)).toBe(false);
  });
});
