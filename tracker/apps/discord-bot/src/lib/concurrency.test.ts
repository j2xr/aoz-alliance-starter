import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const delays = [30, 5, 20, 1];
    const results = await mapWithConcurrency(delays, 4, async (d, i) => {
      await sleep(d);
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('propagates a rejection (Promise.all semantics)', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('handles empty input and limit larger than input', async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
    expect(await mapWithConcurrency([7], 100, async (n) => n * 2)).toEqual([14]);
  });
});
