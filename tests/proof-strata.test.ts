import { describe, expect, it } from 'vitest';
import { canonicalize, sealProof, sha256Hex, signProof, verifyProof } from '../src/index.js';
import type { DecisionProof, UnsignedProof } from '../src/index.js';
import { RFC_PUBLIC, RFC_SECRET, RULES, TRUSTED, unsaltedSalt, unsigned } from './proof-cases.js';
import { specError } from './helpers.js';

const salt = unsaltedSalt('rules', 0);

/** r1 feeds `risk` in stratum 0; r2 reads it and feeds `fine` in stratum 1. */
function staged(): UnsignedProof {
  const content = unsigned();
  const [step] = content.applied;
  return {
    ...content,
    strata: [['risk'], ['fine']],
    outputs: [
      {
        name: 'fine',
        type: 'decimal',
        combine: 'sum',
        status: 'determined',
        value: '100.13',
        contributors: ['r2'],
        pending: [],
        rounding: { scale: 2, mode: 'halfUp', at: 'contribution' },
        salt,
      },
      {
        name: 'risk',
        type: 'number',
        combine: 'sum',
        status: 'determined',
        value: 150,
        contributors: ['r1'],
        pending: [],
        salt,
      },
    ],
    applied: [
      { ...step!, output: 'risk', stratum: 0 },
      {
        ruleId: 'r2',
        version: 2,
        model: 'PERCENTAGE',
        output: 'fine',
        contribution: '100.13',
        unrounded: '100.125',
        status: 'determined',
        stratum: 1,
        salt,
      },
    ],
    skipped: [],
  };
}

/** `content` sealed by hand, as a faulty producer would: sealProof refuses it. */
const handSealed = (content: UnsignedProof): DecisionProof => ({
  ...content,
  digest: sha256Hex(canonicalize(content)),
});

describe('strata, decimals and rounding in a proof', () => {
  it('seals, signs and verifies a proof of several strata', () => {
    const proof = signProof(sealProof(staged()), RFC_SECRET, 'executor-1');
    expect(proof.strata).toEqual([['risk'], ['fine']]);
    expect(proof.applied[1]).toMatchObject({ stratum: 1, unrounded: '100.125' });
    expect(verifyProof(proof, { trustedKeys: TRUSTED, rules: RULES })).toEqual({
      status: 'authentic',
      issues: [],
    });
  });

  it('accepts an empty stratum', () => {
    const content = { ...staged(), strata: [['risk'], [], ['fine']] };
    content.applied[1]!.stratum = 2;
    expect(verifyProof(sealProof(content))).toEqual({ status: 'consistent', issues: ['unsigned'] });
  });

  it('the strata and the stratum numbers are covered by the digest', () => {
    const moved = signProof(sealProof(staged()), RFC_SECRET, 'executor-1');
    moved.strata = [['fine', 'risk']];
    moved.applied[1]!.stratum = 0;
    expect(verifyProof(moved, { trustedKeys: TRUSTED })).toEqual({
      status: 'invalid',
      issues: ['digest mismatch'],
    });
  });

  it.each([
    [
      'an output in no stratum',
      (p: UnsignedProof) =>
        p.outputs.unshift({
          name: 'extra',
          type: 'boolean',
          combine: 'any',
          status: 'determined',
          value: false,
          contributors: [],
          pending: [],
          salt,
        }),
      'output not in strata: extra',
    ],
    [
      'an output in two strata',
      (p: UnsignedProof) => (p.strata = [['risk'], ['fine', 'risk']]),
      'stratum output repeated: risk',
    ],
    [
      'an output twice in one stratum',
      (p: UnsignedProof) => (p.strata = [['risk', 'risk'], ['fine']]),
      'stratum output repeated: risk',
    ],
    [
      'a stratum naming an unknown output',
      (p: UnsignedProof) => (p.strata = [['risk', 'tax'], ['fine']]),
      'stratum output unknown: tax',
    ],
    [
      'an applied step beyond the strata',
      (p: UnsignedProof) => (p.applied[1]!.stratum = 2),
      'stratum out of range: r2@2',
    ],
    [
      'a skip beyond the strata',
      (p: UnsignedProof) => {
        p.rules.push({ id: 'r3', version: 1, checksum: 'b'.repeat(64), ruleSet: 'local', salt });
        p.skipped.push({
          ruleId: 'r3',
          version: 1,
          reason: 'DOMINATED',
          status: 'determined',
          stratum: 5,
          salt,
        });
      },
      'stratum out of range: r3@1',
    ],
    [
      'an exception beyond the strata',
      (p: UnsignedProof) =>
        p.exceptions.push({
          ruleId: 'r1',
          version: 1,
          kind: 'inhibit',
          affected: [{ ruleId: 'r2' }],
          status: 'determined',
          stratum: 2,
          salt,
        }),
      'stratum out of range: r1@1',
    ],
    [
      'an applied step whose output is in another stratum',
      (p: UnsignedProof) => (p.applied[1]!.stratum = 0),
      'step stratum mismatch: r2@2',
    ],
    [
      'a skip whose output is in another stratum',
      (p: UnsignedProof) => {
        p.rules.push({ id: 'r3', version: 1, checksum: 'b'.repeat(64), ruleSet: 'local', salt });
        p.skipped.push({
          ruleId: 'r3',
          version: 1,
          output: 'fine',
          reason: 'DOMINATED',
          status: 'determined',
          stratum: 0,
          salt,
        });
      },
      'step stratum mismatch: r3@1',
    ],
  ])('refuses %s', (_name, change, issue) => {
    const content = staged();
    change(content);
    const proof = handSealed(content);
    expect(verifyProof(proof)).toEqual({ status: 'invalid', issues: [issue, 'unsigned'] });
    const resigned = {
      ...proof,
      signature: signProof(handSealed(staged()), RFC_SECRET, 'k').signature,
    };
    expect(verifyProof(resigned, { trustedKeys: { k: RFC_PUBLIC } })).toEqual({
      status: 'invalid',
      issues: [issue, 'signature invalid'],
    });
    const sealError = specError(() => sealProof(content));
    expect(sealError.code).toBe('INVALID_PROOF');
    expect(sealError.message).toBe(`Cannot seal the proof: ${issue}`);
    const signError = specError(() => signProof(proof, RFC_SECRET, 'executor-1'));
    expect(signError.code).toBe('INVALID_PROOF');
    expect(signError.message).toBe(`Cannot sign the proof: ${issue}`);
  });

  it('a proof without any stratum is consistent only without outputs and trace', () => {
    const empty: UnsignedProof = {
      ...unsigned(),
      strata: [],
      outputs: [],
      applied: [],
      skipped: [],
    };
    expect(verifyProof(sealProof(empty)).issues).toEqual(['unsigned']);
    expect(verifyProof(handSealed({ ...unsigned(), strata: [] })).issues).toEqual([
      'output not in strata: value',
      'stratum out of range: r1@1',
      'stratum out of range: r2@2',
      'unsigned',
    ]);
  });

  it.each([
    ['a non-canonical value', (p: UnsignedProof) => (p.outputs[0]!.value = '100.130')],
    ['a number value', (p: UnsignedProof) => (p.outputs[0]!.value = 100.13)],
    ['a null value', (p: UnsignedProof) => (p.outputs[0]!.value = null)],
    ['a "-0" value', (p: UnsignedProof) => (p.outputs[0]!.value = '-0')],
    ['a non-canonical contribution', (p: UnsignedProof) => (p.applied[1]!.contribution = '1e2')],
    ['a number contribution', (p: UnsignedProof) => (p.applied[1]!.contribution = 100.13)],
    ['a non-canonical unrounded', (p: UnsignedProof) => (p.applied[1]!.unrounded = '100.1250')],
    ['a number unrounded', (p: UnsignedProof) => (p.applied[1]!.unrounded = 100.125)],
    [
      'a non-canonical bound',
      (p: UnsignedProof) => {
        const [fine] = p.outputs;
        p.outputs[0] = { ...fine!, status: 'undetermined', bounds: { min: '1.0' } };
        delete p.outputs[0].value;
      },
    ],
  ])('refuses a decimal output with %s', (_name, change) => {
    const content = staged();
    change(content);
    const proof = handSealed(content);
    expect(verifyProof(proof)).toEqual({
      status: 'invalid',
      issues: ['decimal value not canonical: fine', 'unsigned'],
    });
    expect(specError(() => sealProof(content)).message).toBe(
      'Cannot seal the proof: decimal value not canonical: fine',
    );
    expect(specError(() => signProof(proof, RFC_SECRET, 'executor-1')).message).toBe(
      'Cannot sign the proof: decimal value not canonical: fine',
    );
  });

  it('checks decimals only on decimal outputs; a number output takes numbers', () => {
    const content = staged();
    content.outputs[1]!.value = 150.5;
    content.applied[0]!.contribution = 150.5;
    expect(verifyProof(sealProof(content)).issues).toEqual(['unsigned']);
    content.applied[0]!.unrounded = '150.50';
    expect(verifyProof(handSealed(content)).issues).toEqual([
      'contribution does not match its output declaration: risk',
      'unrounded value without rounding at contribution: r1@1',
      'unsigned',
    ]);
  });

  it('reports every inconsistency once, citations first, in a fixed order', () => {
    const content = staged();
    content.strata = [['tax', 'risk', 'tax'], []];
    content.skipped.push({
      ruleId: 'r3',
      version: 1,
      reason: 'DOMINATED',
      status: 'determined',
      stratum: 9,
      salt,
    });
    content.outputs[0]!.value = '1.0';
    expect(verifyProof(handSealed(content)).issues).toEqual([
      'cited rule not listed: r3@1',
      'strata[0] not sorted at 1',
      'stratum output unknown: tax',
      'stratum output repeated: tax',
      'output not in strata: fine',
      'step stratum mismatch: r2@2',
      'stratum out of range: r3@1',
      'decimal value not canonical: fine',
      'unsigned',
    ]);
  });
});
