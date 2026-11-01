import { describe, expect, it } from 'vitest';
import {
  PROOF_SECTIONS,
  proofLeafHashes,
  redactProof,
  sealProof,
  SpecError,
  validateProof,
  verifyProof,
} from '../src/index.js';
import type { DecisionProof, ProofSection, UnsaltedProof } from '../src/index.js';
import { fromHex, hex } from './hashing.js';
import { allTrapsThrow, nested, revokedProxy, specError } from './helpers.js';
import { unsalted, unsigned } from './proof-cases.js';

const SEED = fromHex('f9b972f50267915261e884526c8553bdf4a353eb2e4e9e78ee65716aeceaacfb');
const salty = (): DecisionProof =>
  sealProof({ ...unsalted(unsigned()), inputSalted: true } as UnsaltedProof, SEED);

function throwForged(): never {
  throw new Error('forged');
}

/** `proof` with entry 0 of `section` replaced by `entry`. */
function withEntry(proof: DecisionProof, section: ProofSection, entry: unknown): DecisionProof {
  const list = [...(proof as unknown as Record<ProofSection, unknown[]>)[section]];
  list[0] = entry;
  return { ...proof, [section]: list } as DecisionProof;
}

/** A marker whose `redacted` member is a getter that throws. */
function throwingMarker(): object {
  const marker = {};
  Object.defineProperty(marker, 'redacted', { enumerable: true, get: throwForged });
  return marker;
}

const HOSTILE_MARKERS: [string, () => unknown, string][] = [
  ['a throwing getter', throwingMarker, 'could not be read: forged'],
  ['a Proxy whose every trap throws', () => allTrapsThrow({}, throwForged), 'forged'],
  ['a revoked Proxy', revokedProxy, ''],
  ['a deep value', () => ({ redacted: nested(5000) }), ''],
  ['a hash of 63 characters', () => ({ redacted: 'a'.repeat(63) }), 'redacted'],
  ['an uppercase hash', () => ({ redacted: 'A'.repeat(64) }), 'redacted'],
  ['a number', () => ({ redacted: 1 }), 'redacted'],
  ['an extra member', () => ({ redacted: 'a'.repeat(64), salt: 'a'.repeat(32) }), ''],
  ['an array', () => [{ redacted: 'a'.repeat(64) }], ''],
  ['a lone surrogate', () => ({ redacted: '\ud800'.repeat(64) }), 'redacted'],
];

describe('verifyProof on a hostile redacted entry: invalid, named, never thrown', () => {
  for (const section of PROOF_SECTIONS) {
    it.each(HOSTILE_MARKERS)(`${section}[0]: %s`, (_name, make, part) => {
      const proof = salty();
      const list = (proof as unknown as Record<ProofSection, unknown[]>)[section];
      const forged = withEntry(proof, section, make());
      if (list.length === 0) (forged as unknown as Record<string, unknown[]>)[section] = [make()];
      const result = verifyProof(forged);
      expect(result.status).toBe('invalid');
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.join('\n')).toContain(part);
      expect(validateProof(forged).issues.length).toBeGreaterThan(0);
      expect(specError(() => redactProof(forged, () => true)).code).toBe('INVALID_PROOF');
    });
  }

  it.each([
    ['the header', { requestId: { redacted: 'a'.repeat(64) } }],
    ['the signature', { signature: { redacted: 'a'.repeat(64) } }],
    ['a list of rule ids', null],
    ['the whole section', { factsRead: { redacted: 'a'.repeat(64) } }],
  ])('a marker in %s is no redaction: refused', (_name, patch) => {
    const proof = salty();
    const forged =
      patch === null
        ? withEntry(proof, 'outputs', {
            ...(proof.outputs[0] as object),
            contributors: [{ redacted: 'a'.repeat(64) }],
          })
        : { ...proof, ...patch };
    expect(verifyProof(forged).status).toBe('invalid');
    expect(validateProof(forged).issues.length).toBeGreaterThan(0);
  });

  it('reads each member of a redacted proof once', () => {
    const proof = salty();
    const redacted = redactProof(proof, (section) => section !== 'rules');
    const reads = new Map<string, number>();
    const watch = (label: string, target: object): object =>
      new Proxy(target, {
        get(object, key, receiver) {
          const name = `${label}.${String(key)}`;
          reads.set(name, (reads.get(name) ?? 0) + 1);
          return Reflect.get(object, key, receiver) as unknown;
        },
      });
    const watched = { ...redacted } as Record<string, unknown>;
    for (const section of PROOF_SECTIONS) {
      watched[section] = (redacted as unknown as Record<string, object[]>)[section]!.map((e, i) =>
        watch(`${section}[${i}]`, e),
      );
    }
    const top = watch('proof', watched);
    expect(verifyProof(top).status).toBe('consistent-redacted');
    const again = [...reads].filter(([, count]) => count !== 1);
    expect(again).toEqual([]);
    expect(reads.get('outputs[0].redacted')).toBe(1);
    reads.clear();
    redactProof(top as DecisionProof, () => false);
    expect([...reads].filter(([, count]) => count !== 1)).toEqual([]);
  });
});

describe('redactProof on hostile arguments: an own SpecError, never a raw one', () => {
  it.each([
    ['not a function', 1, 'hide must be a function'],
    ['undefined', undefined, 'hide must be a function'],
    [
      'a function that throws',
      () => {
        throw new Error('no');
      },
      'hide failed for rules[0]: no',
    ],
    [
      'a function returning a string',
      () => 'yes',
      'hide must return a boolean, got string for rules[0]',
    ],
    [
      'a function returning undefined',
      () => undefined,
      'hide must return a boolean, got undefined for rules[0]',
    ],
    [
      'a function returning a Proxy',
      () => allTrapsThrow({}, throwForged),
      'hide must return a boolean, got object for rules[0]',
    ],
  ])('hide %s', (_name, hide, message) => {
    const error = specError(() => redactProof(salty(), hide as never));
    expect(error).toMatchObject({ code: 'INVALID_DISCLOSURE', message });
  });

  it.each([
    ['null', null],
    ['a number', 1],
    ['a Proxy whose every trap throws', allTrapsThrow({}, throwForged)],
    ['a revoked Proxy', revokedProxy()],
    ['a throwing getter', Object.defineProperty({ ...salty() }, 'format', { get: throwForged })],
    ['deep nesting', { ...salty(), outputs: [nested(100_000)] }],
  ])('p %s: INVALID_PROOF', (_name, p) => {
    let calls = 0;
    const error = specError(() =>
      redactProof(p as never, () => {
        calls += 1;
        return true;
      }),
    );
    expect(error).toBeInstanceOf(SpecError);
    expect(error.code).toBe('INVALID_PROOF');
    expect(error.message).toMatch(/^Cannot redact the proof: /);
    expect(calls).toBe(0);
  });

  it('does not call hide when the digest does not match', () => {
    const proof = salty();
    let calls = 0;
    const tampered = { ...proof, requestId: 'other' };
    expect(
      specError(() =>
        redactProof(tampered, () => {
          calls += 1;
          return true;
        }),
      ).code,
    ).toBe('INVALID_PROOF');
    expect(calls).toBe(0);
  });

  it('a hide that changes the proof it was given changes nothing redacted', () => {
    const proof = salty();
    const leaves = proofLeafHashes(proof).map(hex);
    const redacted = redactProof(proof, (section, index) => {
      (proof as unknown as Record<string, unknown>).requestId = 'changed';
      return section === 'rules' && index === 0;
    });
    expect(redacted.requestId).not.toBe('changed');
    expect(proofLeafHashes(redacted).map(hex)).toEqual(leaves);
  });
});
