import { describe, expect, it } from 'vitest';
import { isInPortRange, NoFreePortError, nextCandidate, pickPort } from '../src/lib/port.js';
import { PORT_RANGE } from '../src/lib/constants.js';

describe('port selection (SEC-008)', () => {
  it('only accepts ports in 42300–42399', () => {
    expect(isInPortRange(42300)).toBe(true);
    expect(isInPortRange(42399)).toBe(true);
    expect(isInPortRange(47599)).toBe(false);
    expect(isInPortRange(47700)).toBe(false);
    expect(isInPortRange(4000)).toBe(false);
  });

  it('nextCandidate stays in range and skips excluded ports', () => {
    const skip = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      const p = nextCandidate(PORT_RANGE, skip, () => 0);
      expect(p).not.toBeNull();
      expect(isInPortRange(p!)).toBe(true);
      skip.add(p!);
    }
  });

  it('returns null when every port is excluded', () => {
    const skip = new Set<number>();
    for (let p = PORT_RANGE.min; p <= PORT_RANGE.max; p += 1) skip.add(p);
    expect(nextCandidate(PORT_RANGE, skip, () => 0)).toBeNull();
  });

  it('picks the first free port', async () => {
    const free = 42350;
    const port = await pickPort({ probe: async (p) => p === free, random: () => 0, range: { min: 42350, max: 42399 } });
    expect(port).toBe(free);
  });

  it('retries up to maxAttempts, then throws NoFreePortError', async () => {
    let probes = 0;
    await expect(pickPort({ probe: async () => { probes += 1; return false; }, random: () => 0, maxAttempts: 10 }))
      .rejects.toBeInstanceOf(NoFreePortError);
    expect(probes).toBe(10);
  });

  it('occupying a port causes the next to be chosen', async () => {
    const occupied = 42300;
    // random always returns index 0 of the remaining list; first candidate is 42300 (occupied).
    const port = await pickPort({ probe: async (p) => p !== occupied, random: () => 0 });
    expect(port).toBe(42301);
  });
});
