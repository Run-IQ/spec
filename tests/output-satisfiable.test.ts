import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  PROOF_FORMAT,
  sealProof,
  sha256Hex,
  validateOutputDeclaration,
  validateProof,
  valueMatchesOutputType,
  verifyProof,
} from '../src/index.js';
import type { JsonValue, ProofOutput, UnsignedProof } from '../src/index.js';
import { isOnStep, numberToDecimal, stepWorkDone } from '../src/decision/decimal.js';

const LONE = String.fromCharCode(0xd800);

/** A proof of one output `value`, fed by one rule per contribution. */
function proofOf(output: Omit<ProofOutput, 'contributors'>, contributions: JsonValue[] = []) {
  const proof: UnsignedProof = {
    format: PROOF_FORMAT,
    requestId: 'req-1',
    evaluatedAt: null,
    sealedAt: '2026-01-01T00:00:00.000Z',
    inputDigest: 'a'.repeat(64),
    rules: contributions.map((_, i) => ({ id: `r${i}`, version: 1, checksum: 'b'.repeat(64) })),
    versions: { engine: '1', plugins: {}, dsls: {} },
    strata: [['value']],
    outputs: { value: { ...output, contributors: contributions.map((_, i) => `r${i}`) } },
    applied: contributions.map((contribution, i) => ({
      ruleId: `r${i}`,
      version: 1,
      model: 'M',
      output: 'value',
      contribution,
      stratum: 0,
    })),
    skipped: [],
    exceptions: [],
  };
  return proof;
}

/** What `verifyProof` reports on `p` sealed by hand, past the digest and the signature. */
function inconsistencies(p: UnsignedProof): string[] {
  return verifyProof({ ...p, digest: sha256Hex(canonicalize(p)) }).issues.filter(
    (issue) => issue !== 'unsigned',
  );
}

describe('an increment has at most 20 digits before the point, as after it', () => {
  const largest = `${'9'.repeat(20)}.${'9'.repeat(19)}1`;
  const tooLong = `1${'0'.repeat(20)}`;

  it('the declaration validator', () => {
    const rounding = (increment: string) => ({
      type: 'decimal',
      combine: 'sum',
      rounding: { increment, mode: 'up' },
    });
    expect(validateOutputDeclaration(rounding(largest))).toEqual([]);
    expect(validateOutputDeclaration(rounding(tooLong))).toEqual([
      {
        path: 'output.rounding.increment',
        message: 'output.rounding.increment must have at most 20 digits before the point',
      },
    ]);
  });

  it('the proof validator', () => {
    const output = (increment: string) =>
      proofOf({ type: 'decimal', combine: 'sum', value: '0', rounding: { increment, mode: 'up' } });
    expect(validateProof({ ...output(largest), digest: 'c'.repeat(64) }).issues).toEqual([]);
    expect(validateProof({ ...output(tooLong), digest: 'c'.repeat(64) }).issues).toEqual([
      {
        path: 'outputs.value.rounding.increment',
        message: 'outputs.value.rounding.increment must have at most 20 digits before the point',
      },
    ]);
  });
});

describe('isOnStep: work linear in the digits of the value (counted, not timed)', () => {
  const work = (value: string, increment: string) => {
    const before = stepWorkDone();
    isOnStep(value, { increment });
    const after = stepWorkDone();
    return { steps: after.steps - before.steps, digits: after.digits - before.digits };
  };
  const largest = `${'9'.repeat(20)}.${'9'.repeat(19)}7`;

  it.each([15, 1_500, 150_000])('%i digits: one step per 15 digits, bounded operands', (n) => {
    const value = `${'9'.repeat(n - 1)}1`;
    // The value has no decimal places; the increment's 20 are appended as zeros.
    const { steps, digits } = work(value, largest);
    expect(steps).toBe(Math.ceil((n + 20) / 15));
    // Each step works on the remainder (below the increment: 40 digits) and 15 new digits.
    expect(digits).toBeLessThanOrEqual(steps * 55);
  });

  it('the work for 10 times the digits is at most 10 times (and a step) the work', () => {
    const small = work('7'.repeat(10_000), '7');
    const large = work('7'.repeat(100_000), '7');
    expect(large.digits).toBeLessThanOrEqual(10 * small.digits + 55);
  });
});

describe('a number output rounds to a scale only (a satisfiable rounding)', () => {
  it.each(['0.05', '10', '0.25', '1000'])('increment %s: refused on number', (increment) => {
    expect(
      validateOutputDeclaration({
        type: 'number',
        combine: 'sum',
        rounding: { increment, mode: 'up' },
      }),
    ).toEqual([
      {
        path: 'output.rounding.increment',
        message:
          `output.rounding.increment "${increment}" applies to a decimal output only: ` +
          'a number output rounds to a scale',
      },
    ]);
    const proof = proofOf({
      type: 'number',
      combine: 'max',
      value: null,
      rounding: { increment, mode: 'up' },
    });
    expect(validateProof({ ...proof, digest: 'c'.repeat(64) }).issues).toEqual([
      {
        path: 'outputs.value.rounding.increment',
        message:
          `outputs.value.rounding.increment "${increment}" applies to a decimal output only: ` +
          'a number output rounds to a scale',
      },
    ]);
  });

  it('an increment that is a power of ten from 1 to 10^-20 is a scale: accepted', () => {
    for (const increment of ['1', '0.01', `0.${'0'.repeat(19)}1`]) {
      expect(
        validateOutputDeclaration({
          type: 'number',
          combine: 'sum',
          rounding: { increment, mode: 'up' },
        }),
      ).toEqual([]);
    }
  });

  it('the reviewer case: 1e16 to 0.03 is refused at the declaration', () => {
    expect(
      validateOutputDeclaration({
        type: 'number',
        combine: 'sum',
        rounding: { increment: '0.03', mode: 'halfEven' },
      }),
    ).not.toEqual([]);
  });

  /** `x` truncated to `scale` places, as a number: a rounding in mode `down`. */
  function truncated(x: number, scale: number): number {
    const text = numberToDecimal(x);
    const point = text.indexOf('.');
    return Number(point < 0 ? text : text.slice(0, point + 1 + scale));
  }

  const DOUBLES = [
    0,
    0.1 + 0.2,
    1 / 3,
    -2 / 3,
    123456.789,
    2 ** 53 + 2,
    1e16,
    1.7976931348623157e308,
    5e-324,
    1e-20,
    3.141592653589793e-15,
    -9.87654321e21,
    2 ** -60,
  ];

  it('every scale from 0 to 20 is reachable by any double: rounded, it is on the step', () => {
    for (const x of DOUBLES) {
      for (let scale = 0; scale <= 20; scale++) {
        const y = truncated(x, scale);
        expect([x, scale, isOnStep(numberToDecimal(y), { scale })]).toEqual([x, scale, true]);
        const proof = proofOf(
          { type: 'number', combine: 'max', value: y, rounding: { scale, mode: 'down' } },
          [y],
        );
        expect(() => sealProof(proof)).not.toThrow();
      }
    }
  });
});

describe('a number rounded at each contribution: only its sum leaves the step', () => {
  const rounding = { scale: 2, mode: 'halfUp' as const, at: 'contribution' as const };

  it('a max takes a contribution: its value is checked (the reviewer case)', () => {
    const proof = proofOf({ type: 'number', combine: 'max', value: 1.234, rounding }, [1.23]);
    expect(inconsistencies(proof)).toEqual(['output value not rounded as declared: value']);
  });

  it.each(['min', 'highestPriority'] as const)('a %s too', (combine) => {
    const proof = proofOf({ type: 'number', combine, value: 1.234, rounding }, [1.23]);
    expect(inconsistencies(proof)).toEqual(['output value not rounded as declared: value']);
  });

  it('a sum is not: 0.1 + 0.2 is the sum of two values on the step', () => {
    const proof = proofOf(
      { type: 'number', combine: 'sum', value: 0.1 + 0.2, rounding },
      [0.1, 0.2],
    );
    expect(inconsistencies(proof)).toEqual([]);
  });
});

describe('string values: no lone surrogate; a dimension value is a dimension value', () => {
  it('valueMatchesOutputType refuses a lone surrogate in a string', () => {
    const string = { type: 'string', combine: 'highestPriority' } as const;
    expect(valueMatchesOutputType('a', string)).toBe(true);
    expect(valueMatchesOutputType(`a${LONE}`, string)).toBe(false);
    expect(valueMatchesOutputType('', string)).toBe(true);
  });

  it("a string output that sets a dimension refuses '' and a malformed qualified value", () => {
    const country = { type: 'string', combine: 'highestPriority', dimension: 'country' } as const;
    expect(valueMatchesOutputType('TG', country)).toBe(true);
    expect(valueMatchesOutputType('iso:TG', country)).toBe(true);
    for (const value of ['', ':TG', 'iso:', `T${LONE}`]) {
      expect([value, valueMatchesOutputType(value, country)]).toEqual([value, false]);
    }
  });

  it('an enum that sets a dimension declares dimension values only', () => {
    expect(
      validateOutputDeclaration({
        type: 'enum',
        combine: 'max',
        values: ['low', ':x', 'y:'],
        dimension: 'risk',
      }),
    ).toEqual([
      { path: 'output.values[1]', message: 'output.values[1] has an empty code system before ":"' },
      { path: 'output.values[2]', message: 'output.values[2] has an empty code after ":"' },
    ]);
    expect(
      validateOutputDeclaration({ type: 'enum', combine: 'max', values: [':x', 'y:'] }),
    ).toEqual([]);
  });
});
