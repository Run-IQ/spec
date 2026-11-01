import { describe, expect, it } from 'vitest';
import {
  computeInputDigest,
  deriveInputSeed,
  discloseFacts,
  inputLeaves,
  verifyFactDisclosure,
} from '../../src/index.js';
import type { JsonValue } from '../../src/index.js';
import { lastValuesSpent, MAX_JSON_VALUES } from '../../src/values.js';
import { expectedHashWork, hashWorkOf, leafBytes, proofInput } from '../helpers.js';

const SEED = deriveInputSeed(new Uint8Array(32).fill(7), 'r1');
const DIGEST = '0'.repeat(64);

/**
 * A disclosure of `MAX_JSON_VALUES + extra` values (`extra` 0 or 1) as the budget counts them:
 * its five fields (and, for one more, a sixth one, `undefined`, read as absent but counted),
 * then 4 999 997 absences of one member each (the element and its member), the first with a
 * second member `before: undefined`. Past the bound, the last absence is the one not read.
 */
function disclosureOf(extra: number): object {
  const entries = (MAX_JSON_VALUES - 5 - 1) / 2;
  const absent: object[] = Array.from({ length: entries }, () => ({ pointer: '/a' }));
  absent[0] = { pointer: '/a', before: undefined };
  const d = { format: 'run-iq.disclosure/1', inputDigest: DIGEST, size: 0, facts: [], absent };
  return extra > 0 ? { ...d, extra: undefined } : d;
}

describe('verifyFactDisclosure at the bound of MAX_JSON_VALUES values (heavy)', () => {
  it('reads 10 000 000 values, refuses one more before reading it', () => {
    const at = verifyFactDisclosure(disclosureOf(0), DIGEST);
    expect(lastValuesSpent()).toBe(MAX_JSON_VALUES);
    expect(at.valid).toBe(false);
    // Read whole: then refused for its content (the same pointer repeated), never for its size.
    expect(at.issues[0]).toBe(
      '/absent/1 does not follow /absent/0: absences are listed by increasing pointer',
    );
    expect(at.issues).toHaveLength(101);
    const past = verifyFactDisclosure(disclosureOf(1), DIGEST);
    expect(past.issues).toEqual(['/absent/4999996 is too large: more than 10000000 values']);
  }, 120_000);
});

describe('discloseFacts on 500 000 leaves (heavy)', () => {
  it('does the hash work of the digest alone, counted, whatever it discloses', () => {
    const data: Record<string, JsonValue> = {};
    for (let i = 0; i < 500_000; i++) data[`k${i}`] = i;
    const input = proofInput({}, data);
    const expected = expectedHashWork(inputLeaves(input, SEED).map(leafBytes));
    const present = ['/data/k0', '/data/k250000', '/data/k499999', '/meta/tenantId'];
    const absent = ['/data/k1/x', '/data/k25x', '/data/zz', '/meta/z'];
    let disclosure: ReturnType<typeof discloseFacts> | undefined;
    const work = hashWorkOf(() => (disclosure = discloseFacts(input, SEED, present, absent)));
    expect(work).toEqual(expected);
    const result = verifyFactDisclosure(disclosure, computeInputDigest(input, SEED));
    expect(result.valid).toBe(true);
    expect(result.absent).toEqual(['/data/k1/x', '/data/k25x', '/data/zz', '/meta/z']);
  }, 120_000);
});
