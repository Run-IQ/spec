import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  createSigningKeyPair,
  sealProof,
  signProof,
  verifyProof,
} from '../src/index.js';
import type { RuleDefinitionInput } from '../src/index.js';
import {
  baseContent,
  RFC_SECRET,
  ruleA,
  ruleB,
  RULES,
  sealed,
  signed,
  TRUSTED,
  unsaltedSalt,
  unsigned,
} from './proof-cases.js';
import { handSealed, specError } from './helpers.js';
import { unsalted } from './proof-cases.js';
import type { ProofView } from '../src/proof/types.js';
import { NOT_REPLAYED } from './notices.js';

describe('verifyProof: invalid, with a readable issue', () => {
  it('a field changed after sealing', () => {
    const proof = signed();
    proof.requestId = 'req-x';
    expect(verifyProof(proof, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: ['digest mismatch'],
    });
    const unsignedProof = sealed();
    unsignedProof.requestId = 'req-x';
    expect(verifyProof(unsignedProof)).toEqual({
      status: 'invalid',
      issues: ['digest mismatch', 'unsigned'],
    });
  });

  it('an output value changed after sealing: it no longer follows from its contributions', () => {
    const proof = signed();
    proof.outputs[0]!.value = 1;
    expect(verifyProof(proof, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: ['digest mismatch', 'output value does not follow from its contributions: value'],
    });
  });

  it('a rule removed from the proof after sealing', () => {
    const proof = signed();
    proof.rules.pop();
    // The header commits to the number of rules (D-16).
    expect(verifyProof(proof, { trustedKeys: TRUSTED, rules: RULES })).toEqual({
      status: 'invalid',
      issues: ['counts.rules is 2, rules has 1 entry'],
    });
    // Its count changed too: the digest no longer matches.
    proof.counts.rules = 1;
    expect(verifyProof(proof, { trustedKeys: TRUSTED, rules: RULES })).toEqual({
      status: 'invalid',
      issues: ['digest mismatch', 'cited rule not listed: r2@2', 'unexpected rule: r2@2'],
    });
    expect(verifyProof(proof, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: ['digest mismatch', 'cited rule not listed: r2@2'],
    });
  });

  const salt = unsaltedSalt('rules', 0);

  it.each([
    [
      'applied',
      (p: ProofView) => p.applied.push({ ...p.applied[0]!, version: 2, contribution: 0 }),
      'r1@2',
    ],
    [
      'skipped',
      (p: ProofView) =>
        p.skipped.push({
          ruleId: 'r3',
          version: 1,
          reason: 'INACTIVE_DATE',
          status: 'determined',
          stratum: 0,
          salt,
        }),
      'r3@1',
    ],
    [
      'exceptions',
      (p: ProofView) =>
        p.exceptions.push({
          ruleId: 'r4',
          version: 1,
          kind: 'inhibit',
          affected: [],
          status: 'determined',
          stratum: 0,
          salt,
        }),
      'r4@1',
    ],
  ])('a rule cited in %s but not listed in rules', (_name, cite, key) => {
    const content = unsigned();
    cite(content);
    const proof = handSealed(content);
    const resigned = { ...proof, signature: signed().signature };
    expect(verifyProof(proof)).toEqual({
      status: 'invalid',
      issues: [`cited rule not listed: ${key}`, 'unsigned'],
    });
    expect(verifyProof(resigned, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: [`cited rule not listed: ${key}`, 'signature invalid'],
    });
    const error = specError(() => sealProof(unsalted(content)));
    expect(error.code).toBe('INVALID_PROOF');
    expect(error.message).toBe(`Cannot seal the proof: cited rule not listed: ${key}`);
  });

  it.each([
    [
      'outputs contributors',
      (p: ProofView) => p.outputs[0]!.contributors.push('r7'),
      ['cited rule not listed: r7', 'contributors differ from applied steps: value'],
    ],
    [
      'exceptions affected',
      (p: ProofView) =>
        p.exceptions.push({
          ruleId: 'r1',
          version: 1,
          kind: 'inhibit',
          affected: [{ ruleId: 'r8' }],
          status: 'determined',
          stratum: 0,
          salt,
        }),
      ['cited rule not listed: r8', 'affected rule not inhibited by r1@1: r8'],
    ],
  ])('a rule id in %s that rules does not list', (_name, cite, issues) => {
    const content = unsigned();
    cite(content);
    const proof = handSealed(content);
    expect(verifyProof(proof)).toEqual({ status: 'invalid', issues: [...issues, 'unsigned'] });
    expect(specError(() => sealProof(unsalted(content))).message).toBe(
      `Cannot seal the proof: ${issues[0]}`,
    );
    expect(specError(() => signProof(proof, RFC_SECRET, 'executor-1')).message).toBe(
      `Cannot sign the proof: ${issues[0]}`,
    );
  });

  it('reports a rule cited several times once', () => {
    const content = unsigned();
    const at = { ruleId: 'r5', version: 1, status: 'determined', stratum: 0, salt } as const;
    content.skipped.push({ ...at, output: 'value', reason: 'DOMINATED' });
    content.exceptions.push({ ...at, kind: 'inhibit', affected: [] });
    expect(verifyProof(handSealed(content)).issues).toEqual([
      'cited rule not listed: r5@1',
      'unsigned',
    ]);
  });

  it('a digest recomputed after tampering, without a new signature', () => {
    const proof = signed();
    proof.requestId = 'req-x';
    const tampered = { ...proof, digest: sealProof(unsalted(proof)).digest };
    expect(verifyProof(tampered, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: ['signature invalid'],
    });
  });

  it('the signature of another digest', () => {
    const other = signProof(
      sealProof(unsalted({ ...unsigned(), requestId: 'req-2' })),
      RFC_SECRET,
      'executor-1',
    );
    const proof = { ...signed(), signature: other.signature };
    expect(verifyProof(proof, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: ['signature invalid'],
    });
  });

  it('a signature checked against the wrong trusted key', () => {
    const { publicKey } = createSigningKeyPair();
    expect(verifyProof(signed(), { trustedKeys: { 'executor-1': publicKey } })).toEqual({
      status: 'invalid',
      issues: ['signature invalid'],
    });
  });

  it.each([
    ['not a curve point', 'f'.repeat(64)],
    ['a small-order point (the identity)', `01${'0'.repeat(62)}`],
  ])('a trusted key of the right length that is %s', (_name, key) => {
    expect(verifyProof(signed(), { trustedKeys: { 'executor-1': key } })).toEqual({
      status: 'invalid',
      issues: ['trustedKeys.executor-1 is malformed'],
    });
  });

  it('a rule missing from the given rules', () => {
    expect(verifyProof(signed(), { trustedKeys: TRUSTED, rules: [ruleA] })).toEqual({
      status: 'invalid',
      issues: ['rule missing: r2@2'],
    });
  });

  it('an extra rule in the given rules', () => {
    const extra = { ...ruleA, id: 'r3' };
    expect(verifyProof(signed(), { trustedKeys: TRUSTED, rules: [...RULES, extra] })).toEqual({
      status: 'invalid',
      issues: ['unexpected rule: r3@1'],
    });
  });

  it('a given rule whose checksum differs', () => {
    const changed = { ...ruleA, params: { amount: 151 } };
    expect(verifyProof(signed(), { trustedKeys: TRUSTED, rules: [changed, ruleB] })).toEqual({
      status: 'invalid',
      issues: ['rule checksum mismatch: r1@1'],
    });
  });

  it('a rule given twice', () => {
    expect(verifyProof(signed(), { trustedKeys: TRUSTED, rules: [...RULES, ruleA] })).toEqual({
      status: 'invalid',
      issues: ['duplicate rule: r1@1'],
    });
  });

  it('a given rule spec refuses', () => {
    const broken = { ...ruleA, effectiveFrom: 'yesterday' };
    expect(verifyProof(signed(), { trustedKeys: TRUSTED, rules: [broken, ruleB] })).toEqual({
      status: 'invalid',
      issues: [
        'rule invalid: rules[0]: effectiveFrom must be a Date, a civil date YYYY-MM-DD or an ' +
          'instant YYYY-MM-DDTHH:MM:SS[.sss] with Z or ±HH:MM, in the years 0000 to 9999; ' +
          'got "yesterday"',
        'rule missing: r1@1',
      ],
    });
  });

  it('rules of packs: each given rule matched by its qualified id (D-37)', () => {
    const content = baseContent();
    const listed = content.rules as { id: string; version: number; ruleSet: string }[];
    // Each definition says what the trace of the base proof says of its rule: its model, its
    // output and a window, so that only the qualified ids are under test here.
    const shape: Record<string, Record<string, unknown>> = {
      'local:k@1': {
        model: 'PER_CHILD',
        output: 'kids',
        effectiveOn: '/$item/naissance',
        forEach: { path: '/enfants', key: 'id' },
      },
      'local:r1@1': { model: 'FLAT' },
      'social:R1@1': { model: 'CHECK', output: 'aid' },
      'vat:R1@1': { model: 'CHECK', output: 'social:aid' },
      'vat:R2@1': { model: 'LEVEL', output: 'level' },
      'vat:R2@2': { effectiveFrom: '2030-01-01', output: 'level' },
    };
    const definitions: RuleDefinitionInput[] = listed.map(({ id, version, ruleSet }) => ({
      ...ruleA,
      id,
      version,
      ...(ruleSet === 'local' ? {} : { ruleSet }),
      ...shape[`${ruleSet}:${id}@${version}`],
    }));
    const rules = listed.map((ref, i) => ({
      ...ref,
      checksum: computeRuleChecksum(definitions[i]!),
      priority: ruleA.priority,
    }));
    const proof = sealProof(unsalted({ ...content, rules } as unknown as ProofView));
    expect(verifyProof(proof, { rules: definitions })).toEqual({
      status: 'consistent',
      issues: [
        'unsigned',
        'window not checked: k@1 (effectiveOn is /$item/naissance)',
        'reason not checked: INHIBITED',
        NOT_REPLAYED,
      ],
    });
    // R1@1 of social given as a rule of vat: the vat one twice, the social one missing.
    const vatR1 = definitions.find((rule) => rule.ruleSet === 'vat' && rule.id === 'R1')!;
    const moved = definitions.map((rule) => (rule.ruleSet === 'social' ? { ...vatR1 } : rule));
    expect(verifyProof(proof, { rules: moved })).toEqual({
      status: 'invalid',
      issues: ['unsigned', 'duplicate rule: vat:R1@1', 'rule missing: social:R1@1'],
    });
    // A local rule r1 is not the rule R1 of a pack, nor `local:r1` another rule.
    const local = definitions.map((rule) =>
      rule.id === 'R2' && rule.version === 2 ? ruleA : rule,
    );
    expect(verifyProof(proof, { rules: local })).toEqual({
      status: 'invalid',
      issues: ['unsigned', 'duplicate rule: r1@1', 'rule missing: vat:R2@2'],
    });
  });

  it('every problem at once, in a fixed order', () => {
    const proof = sealed();
    proof.requestId = 'req-x';
    const changed = { ...ruleA, params: { amount: 151 } };
    expect(verifyProof(proof, { rules: [changed, { ...ruleB, id: 'r9' }] })).toEqual({
      status: 'invalid',
      issues: [
        'digest mismatch',
        'unsigned',
        'rule checksum mismatch: r1@1',
        'rule missing: r2@2',
        'unexpected rule: r9@2',
      ],
    });
  });

  it('an unknown format or a missing field', () => {
    expect(verifyProof({ ...signed(), format: 'run-iq.proof/2' })).toEqual({
      status: 'invalid',
      issues: ['unknown format: run-iq.proof/2'],
    });
    const withoutOutputs: Record<string, unknown> = { ...signed() };
    delete withoutOutputs.outputs;
    expect(verifyProof(withoutOutputs)).toEqual({
      status: 'invalid',
      issues: ['outputs is required'],
    });
  });

  it('malformed options', () => {
    const bad = { trustedKeys: 'key', rules: 'r1' } as unknown as Parameters<typeof verifyProof>[1];
    expect(verifyProof(signed(), bad)).toEqual({
      status: 'invalid',
      issues: ['trustedKeys must be an object of hex public keys', 'rules must be an array'],
    });
  });

  it('options that are not an object', () => {
    const bad = 'trusted' as unknown as Parameters<typeof verifyProof>[1];
    expect(verifyProof(signed(), bad)).toEqual({
      status: 'invalid',
      issues: ['options must be an object { trustedKeys?, rules? }', 'untrusted key'],
    });
  });

  it('options that cannot be read: an options problem, never one of the proof', () => {
    type Options = Parameters<typeof verifyProof>[1];
    const throwing = (reason: string): never => {
      throw new Error(reason);
    };
    const opaque = new Proxy({}, { getPrototypeOf: () => throwing('opt') });
    const rules = new Proxy([], { get: () => throwing('arr') });
    const getter = {
      get rules(): never {
        return throwing('getter');
      },
    };
    const keys = {
      get trustedKeys(): never {
        return throwing('keys');
      },
    };
    // The options read, the signature is checked before the rules are.
    const cases: [unknown, string[]][] = [
      [opaque, ['options could not be read: opt']],
      [getter, ['options.rules could not be read: getter']],
      [keys, ['options.trustedKeys could not be read: keys']],
      [{ rules }, ['untrusted key', 'options.rules could not be read: arr']],
    ];
    for (const [options, issues] of cases) {
      // Hostile options, outside the declared type on purpose.
      expect(verifyProof(signed(), options as Options)).toEqual({ status: 'invalid', issues });
    }
  });

  it('never throws, whatever the input', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('boom');
        },
      },
    );
    const values: unknown[] = [undefined, null, 'proof', 42, [], {}, new Map(), hostile];
    for (const value of values) {
      const result = verifyProof(value);
      expect(result.status).toBe('invalid');
      expect(result.issues.length).toBeGreaterThan(0);
    }
    expect(verifyProof(null)).toEqual({
      status: 'invalid',
      issues: ['a decision proof must be a plain object'],
    });
    expect(verifyProof(hostile)).toEqual({
      status: 'invalid',
      issues: ['proof could not be read: boom'],
    });
  });
});
