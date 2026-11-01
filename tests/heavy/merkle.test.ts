import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { builtFile } from '../helpers.js';

describe('10 000 000 leaves in a process of default heap (built dist)', () => {
  it("computes the root, holding 32 bytes a leaf beside the caller's list", () => {
    const dist = builtFile('index.js');
    const script = `
      const { merkleRoot } = await import(${JSON.stringify(`file://${dist}`)});
      const n = 10_000_000;
      const bytes = new Uint8Array(32 * n);
      for (let i = 0; i < n; i++) bytes[32 * i] = i & 255, bytes[32 * i + 1] = (i >> 8) & 255;
      const leaves = Array.from({ length: n }, (_, i) => bytes.subarray(32 * i, 32 * i + 32));
      const before = process.memoryUsage();
      const root = merkleRoot(leaves);
      const after = process.memoryUsage();
      console.log(JSON.stringify({
        root: root.length,
        heap: after.heapUsed - before.heapUsed,
        buffers: after.arrayBuffers - before.arrayBuffers,
      }));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    const { root, heap, buffers } = JSON.parse(out) as Record<string, number>;
    expect(root).toBe(32);
    // No array per hash: 10^7 of them would take hundreds of megabytes of heap.
    expect(heap).toBeLessThan(64 * 2 ** 20);
    // The packed storage: 32 bytes a leaf, allocated once.
    expect(buffers).toBeLessThanOrEqual(32 * 10_000_000 + 2 ** 20);
  }, 300_000);
});
