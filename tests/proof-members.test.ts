import { describe, expect, it } from 'vitest';
import {
  PROOF_SECTIONS,
  sealProof,
  signProof,
  SpecError,
  validateProof,
  verifyProof,
} from '../src/index.js';
import type { DecisionProof, UnsignedProof } from '../src/index.js';
import { isOwnError } from '../src/errors.js';
import { allTrapsThrow, omit, revokedProxy, specError } from './helpers.js';
import { baseContent, BASE_PROOF, RFC_SECRET } from './proof-cases.js';

/** Throws an error a caller built: cited, never trusted. */
function throwForged(): never {
  throw new SpecError('INVALID_PROOF', 'forged', 'forged.path');
}

/** An object whose `key` getter throws `thrown`. */
function throwingAt(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...target };
  Object.defineProperty(copy, key, { enumerable: true, get: throwForged });
  return copy;
}

const HOSTILES: [string, () => unknown][] = [
  ['a symbol', () => Symbol('s')],
  ['a bigint', () => 1n],
  ['a function', () => () => 1],
  ['NaN', () => Number.NaN],
  ['a lone surrogate', () => '\ud800'],
  ['a Proxy whose every trap throws', () => allTrapsThrow({}, throwForged)],
  ['an array Proxy whose every trap throws', () => allTrapsThrow([], throwForged)],
  ['a revoked Proxy', revokedProxy],
  ['a Map', () => new Map()],
];

/** Every member of the first entry of each section of `BASE_PROOF`, as [section, key]. */
function members(): [string, string][] {
  const content = baseContent();
  return PROOF_SECTIONS.flatMap((section) => {
    // Every section of the base content is a list of entries.
    const [first] = content[section] as Record<string, unknown>[];
    return first === undefined
      ? []
      : Object.keys(first).map((key): [string, string] => [section, key]);
  });
}

/** `BASE_PROOF` with the first entry of `section` changed by `change`. */
function withEntry(
  section: string,
  change: (entry: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  // A JSON copy of the base proof, whose sections are lists of entries.
  const proof = structuredClone(BASE_PROOF) as Record<string, unknown>;
  const entries = proof[section] as Record<string, unknown>[];
  entries[0] = change(entries[0]!);
  return proof;
}

/** True when `run` returns, or throws an error of this package with a bounded message. */
function ownOrNothing(run: () => unknown): boolean {
  try {
    run();
    return true;
  } catch (error) {
    return isOwnError(error) && error.message.length <= 2048;
  }
}

describe('a hostile member of any entry of any section', () => {
  it('the sweep covers every member of every section', () => {
    expect(new Set(members().map(([section]) => section))).toEqual(new Set(PROOF_SECTIONS));
    expect(members().length).toBeGreaterThan(60);
  });

  it.each(members())('%s[0].%s: refused, never thrown raw', (section, key) => {
    const proofs = [
      ...HOSTILES.map(([, make]) => withEntry(section, (entry) => ({ ...entry, [key]: make() }))),
      withEntry(section, (entry) => throwingAt(entry, key)),
    ];
    for (const proof of proofs) {
      const { issues } = validateProof(proof);
      expect(issues.length).toBeGreaterThan(0);
      expect(verifyProof(proof).status).toBe('invalid');
      expect(ownOrNothing(() => sealProof(proof as unknown as UnsignedProof))).toBe(true);
      expect(
        ownOrNothing(() => signProof(proof as unknown as DecisionProof, RFC_SECRET, 'k')),
      ).toBe(true);
      expect(() => sealProof(proof as unknown as UnsignedProof)).toThrow();
    }
  });
});

/** The digest `sealProof` gives `content`, or the message it refuses it with. */
function sealed(content: Record<string, unknown>): string {
  try {
    return sealProof(content as unknown as UnsignedProof).digest;
  } catch {
    return specError(() => sealProof(content as unknown as UnsignedProof)).message;
  }
}

describe('a Date in a part of the proof read as JSON', () => {
  const ISO = '1970-01-01T00:00:00.000Z';

  it.each([
    ['applied', 'contribution'],
    ['items', 'value'],
    ['outputs', 'unit'],
  ])('%s[0].%s: read as its ISO string, as the canonical form reads it', (section, key) => {
    const asDate = withEntry(section, (entry) => ({ ...entry, [key]: new Date(0) }));
    const asText = withEntry(section, (entry) => ({ ...entry, [key]: ISO }));
    expect(validateProof(asDate)).toEqual(validateProof(asText));
    const content = omit(asText, 'digest');
    const dated = omit(asDate, 'digest');
    // Sealed, or refused, alike: the same digest, or the same inconsistency.
    expect(sealed(dated)).toBe(sealed(content));
  });

  it('a Date where the format wants a string is refused', () => {
    const proof = withEntry('factsRead', (entry) => ({ ...entry, path: new Date(0) }));
    expect(validateProof(proof).issues).toEqual([
      {
        path: 'factsRead[0].path',
        message: 'factsRead[0].path must be a pointer to an input fact',
      },
    ]);
  });
});
