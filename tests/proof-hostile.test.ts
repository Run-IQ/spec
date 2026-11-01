import { describe, expect, it } from 'vitest';
import * as canonicalEntry from '../src/canonical-entry.js';
import {
  computeInputDigest,
  computeRuleChecksum,
  PROOF_FORMAT,
  PROOF_FORMATS,
  PROOF_SECTIONS,
  sealProof,
  signProof,
  UNSALTED_SEED,
  validateProof,
  verifyProof,
} from '../src/index.js';
import type { DecisionProof, RuleDefinitionInput, UnsignedProof } from '../src/index.js';
import { input, RFC_SECRET, ruleA, sealed, signed, TRUSTED, unsigned } from './proof-cases.js';
import { REFUSED_PROOFS, VALID_PROOFS, VALIDATOR_ONLY_PROOFS } from './proof-shape-cases.js';
import { nested, specError, tooDeepIssue } from './helpers.js';
import { unsalted } from './proof-cases.js';
import type { PlainProof } from './proof-cases.js';

describe('verifyProof: hostile input', () => {
  /**
   * Content B (a changed output) carrying the signature of proof A. Its `digest` getter returns
   * B's digest for the first `cut` reads, then A's.
   */
  function forged(cut: number): DecisionProof {
    const genuine = signed();
    const content = sealProof(unsalted({ ...unsigned(), requestId: 'req-forged' }));
    const proof: DecisionProof = { ...content, signature: genuine.signature! };
    let reads = 0;
    Object.defineProperty(proof, 'digest', {
      enumerable: true,
      get: () => (++reads <= cut ? content.digest : genuine.digest),
    });
    return proof;
  }

  it.each([1, 2, 3, 4, 5, 6])(
    'a digest getter that changes after %i reads is never authentic',
    (cut) => {
      const result = verifyProof(forged(cut), { trustedKeys: TRUSTED });
      expect(result.status).toBe('invalid');
      expect(result.issues).toHaveLength(1);
      expect(['digest mismatch', 'signature invalid']).toContain(result.issues[0]);
    },
  );

  it.each([1, 2, 3, 4, 5, 6])(
    'a signature getter that changes after %i reads is never authentic',
    (cut) => {
      const genuine = signed();
      const content = sealProof(unsalted({ ...unsigned(), requestId: 'req-2' }));
      const own = signProof(content, RFC_SECRET, 'other');
      let reads = 0;
      const proof: DecisionProof = { ...content };
      Object.defineProperty(proof, 'signature', {
        enumerable: true,
        get: () => (++reads <= cut ? own.signature : genuine.signature),
      });
      const result = verifyProof(proof, { trustedKeys: TRUSTED });
      expect(result.status).not.toBe('authentic');
    },
  );

  it('reads each property of the proof a bounded number of times', () => {
    let reads = 0;
    const proof = signed();
    const digest = proof.digest;
    Object.defineProperty(proof, 'digest', {
      enumerable: true,
      get: () => {
        reads++;
        return digest;
      },
    });
    expect(verifyProof(proof, { trustedKeys: TRUSTED }).status).toBe('authentic');
    // Once: the snapshot every later check uses is built from the very values validated.
    expect(reads).toBe(1);
  }, 60_000);

  const throwing = (thrown: () => unknown): DecisionProof => {
    const proof = signed();
    Object.defineProperty(proof, 'digest', {
      enumerable: true,
      get: () => {
        throw thrown();
      },
    });
    return proof;
  };
  const errorWithThrowingMessage = (): Error => {
    const error = new Error('x');
    Object.defineProperty(error, 'message', {
      get: () => {
        throw 1;
      },
    });
    return error;
  };
  const prototypeTrap = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw Object.create(null);
      },
    },
  );
  let deep: unknown = 0;
  for (let i = 0; i < 200_000; i++) deep = [deep];

  it.each([
    [
      'a getter throwing a null-prototype object',
      throwing(() => Object.create(null)),
      'unreadable value',
    ],
    ['a getter throwing a number', throwing(() => 7), '7'],
    [
      'a getter throwing an Error whose message throws',
      throwing(errorWithThrowingMessage),
      'unreadable value',
    ],
    ['a Proxy whose getPrototypeOf throws', prototypeTrap, 'unreadable value'],
  ])('%s: invalid, without throwing', (_name, value, reason) => {
    expect(verifyProof(value, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: [`proof could not be read: ${reason}`],
    });
  });

  it('a very deeply nested output value: refused by its depth, without throwing', () => {
    const proof = sealed();
    const tampered = { ...proof, outputs: [{ ...proof.outputs[0]!, value: deep }] };
    expect(verifyProof(tampered)).toEqual({
      status: 'invalid',
      issues: [tooDeepIssue(`outputs[0].value${'[0]'.repeat(1000)}`).message],
    });
  }, 60_000);

  it('an output value 1000 levels deep is read; one level more is refused', () => {
    const proof = sealed();
    const withValue = (value: unknown): unknown => ({
      ...proof,
      outputs: [{ ...proof.outputs[0]!, value }],
    });
    // Read to its depth, then found not to be a number (and not compared to its contributions).
    expect(verifyProof(withValue(nested(1000))).issues).toEqual([
      'digest mismatch',
      'output value does not match its declaration: value',
      'unsigned',
    ]);
    expect(validateProof(withValue(nested(1001))).issues).toEqual([
      tooDeepIssue(`outputs[0].value${'.a'.repeat(1000)}`),
    ]);
  }, 60_000);

  it('a contribution or unrounded value more than 1000 levels deep is refused at its path', () => {
    const proof = sealed();
    const applied = { ...proof.applied[0]!, contribution: nested(1001), unrounded: nested(1001) };
    expect(validateProof({ ...proof, applied: [applied] }).issues).toEqual([
      tooDeepIssue(`applied[0].contribution${'.a'.repeat(1000)}`),
      tooDeepIssue(`applied[0].unrounded${'.a'.repeat(1000)}`),
    ]);
  }, 60_000);

  it('a hostile entry in the rules option', () => {
    const rule: Record<string, unknown> = { ...ruleA };
    Object.defineProperty(rule, 'id', {
      enumerable: true,
      get: () => {
        throw Object.create(null);
      },
    });
    // Read as computeRuleChecksum reads a rule: both refuse it with the same reason.
    expect(specError(() => computeRuleChecksum(rule as RuleDefinitionInput)).message).toBe(
      'rule definition could not be read: unreadable value',
    );
    expect(
      verifyProof(signed(), { trustedKeys: TRUSTED, rules: [rule as RuleDefinitionInput] }),
    ).toEqual({
      status: 'invalid',
      issues: [
        'rule invalid: rules[0]: rule definition could not be read: unreadable value',
        'rule missing: r1@1',
        'rule missing: r2@2',
      ],
    });
  });
});

describe('validateProof', () => {
  it.each(VALID_PROOFS)('accepts %s', (_name, value) => {
    expect(validateProof(value)).toEqual({ errors: [], issues: [] });
  });

  it.each([...REFUSED_PROOFS, ...VALIDATOR_ONLY_PROOFS])(
    'refuses %s with one issue',
    (_name, value, path, message) => {
      expect(validateProof(value)).toEqual({ errors: [message], issues: [{ path, message }] });
    },
  );

  it('accepts sealed and signed proofs', () => {
    expect(validateProof(sealed())).toEqual({ errors: [], issues: [] });
    expect(validateProof(signed())).toEqual({ errors: [], issues: [] });
  });

  it('reports every problem, unknown keys first, then fields in order', () => {
    expect(
      validateProof({ ...sealed(), extra: 1, requestId: 7, rules: [{ id: '' }] }).issues,
    ).toEqual([
      { path: 'extra', message: 'proof has an unknown key "extra"' },
      { path: 'requestId', message: 'requestId must be a non-empty string' },
      { path: 'rules[0].id', message: 'rules[0].id must be a non-empty string' },
      { path: 'rules[0].version', message: 'rules[0].version is required' },
      { path: 'rules[0].checksum', message: 'rules[0].checksum is required' },
      { path: 'rules[0].ruleSet', message: 'rules[0].ruleSet is required' },
      { path: 'rules[0].priority', message: 'rules[0].priority is required' },
      { path: 'rules[0].salt', message: 'rules[0].salt is required' },
    ]);
  });

  it('refuses a value with no JSON form, naming its path', () => {
    const proof = sealed();
    proof.applied[0]!.contribution = { rates: [0.1, Number.NaN] };
    expect(validateProof(proof).issues).toEqual([
      {
        path: 'applied[0].contribution.rates[1]',
        message:
          'Value at "applied[0].contribution.rates[1]" cannot be serialized to canonical JSON: NaN',
      },
    ]);
  });

  it('treats an undefined member as absent, like the digest', () => {
    expect(validateProof({ ...sealed(), ruleSet: undefined, signature: undefined }).issues).toEqual(
      [],
    );
    expect(validateProof({ ...sealed(), outputs: undefined }).issues).toEqual([
      { path: 'outputs', message: 'outputs is required' },
    ]);
  });

  it('takes a member whose value is undefined as absent, known or not, everywhere', () => {
    expect(validateProof({ ...sealed(), extra: undefined }).issues).toEqual([]);
    const proof = sealed();
    proof.outputs[0]!.rounding = { scale: 2, mode: 'up' };
    Object.assign(proof.outputs[0]!.rounding, { precision: undefined });
    Object.assign(proof.applied[0]!, { note: undefined, sourceRef: undefined });
    expect(validateProof(proof).issues).toEqual([]);
  });

  it.each([
    [
      'at the top level',
      (p: DecisionProof) =>
        Object.defineProperty(p, 'requestId', {
          enumerable: true,
          get: () => {
            throw new Error('boom');
          },
        }),
      'proof could not be read: boom',
    ],
    [
      'inside rounding',
      (p: PlainProof) => {
        p.outputs[0]!.rounding = { scale: 2, mode: 'up' };
        Object.defineProperty(p.outputs[0]!.rounding, 'scale', {
          enumerable: true,
          get: () => {
            throw Symbol('scale');
          },
        });
      },
      'proof could not be read: Symbol(scale)',
    ],
  ])('reports a throwing getter %s, and seal and sign refuse it', (_name, poison, message) => {
    const proof = sealed();
    poison(proof);
    expect(validateProof(proof)).toEqual({ errors: [message], issues: [{ path: '', message }] });
    const sealError = specError(() => sealProof(unsalted(proof)));
    expect(sealError.code).toBe('INVALID_PROOF');
    expect(sealError.message).toBe(`Cannot seal the proof: ${message}`);
    const signError = specError(() => signProof(proof, RFC_SECRET, 'executor-1'));
    expect(signError.code).toBe('INVALID_PROOF');
    expect(signError.message).toBe(`Cannot sign the proof: ${message}`);
    expect(verifyProof(proof)).toEqual({ status: 'invalid', issues: [message] });
  });

  it('refuses a proof of the format before Task 9J: outputs as an object, no salts', () => {
    // A JSON copy of a sealed proof, as an older producer stored it.
    const old = JSON.parse(JSON.stringify(sealed())) as Record<string, unknown>;
    old.outputs = { value: { type: 'number', combine: 'sum', value: 150, contributors: ['r1'] } };
    expect(validateProof(old).errors).toEqual(['outputs must be a list']);
    expect(verifyProof(old)).toEqual({ status: 'invalid', issues: ['outputs must be a list'] });
    // The cast lets a JavaScript caller's malformed value reach sealProof, which checks it.
    expect(specError(() => sealProof(unsalted(old as unknown as UnsignedProof))).message).toBe(
      'Cannot seal the proof: outputs must be a list',
    );
  });

  it('refuses a Date where an ISO string is expected', () => {
    expect(validateProof({ ...sealed(), sealedAt: new Date(0) }).issues).toEqual([
      {
        path: 'sealedAt',
        message: 'sealedAt must be an instant YYYY-MM-DDTHH:MM:SS.sssZ',
      },
    ]);
  });
});

describe('both entries', () => {
  it('export the whole proof API', () => {
    expect(canonicalEntry.PROOF_FORMAT).toBe(PROOF_FORMAT);
    expect(canonicalEntry.PROOF_FORMATS).toBe(PROOF_FORMATS);
    expect(canonicalEntry.PROOF_SECTIONS).toBe(PROOF_SECTIONS);
    expect(canonicalEntry.verifyProof(signed(), { trustedKeys: TRUSTED }).status).toBe('authentic');
    const proof = canonicalEntry.signProof(
      canonicalEntry.sealProof(unsalted(unsigned())),
      RFC_SECRET,
      'executor-1',
    );
    expect(proof).toEqual(signed());
    expect(canonicalEntry.computeInputDigest(input, canonicalEntry.UNSALTED_SEED)).toBe(
      computeInputDigest(input, UNSALTED_SEED),
    );
    expect(canonicalEntry.validateProof(proof)).toEqual({ errors: [], issues: [] });
    expect(typeof canonicalEntry.createSigningKeyPair().publicKey).toBe('string');
  });
});
