/**
 * Task 9K5, round 2 of the audit: the window decided bound by bound (a one-day window, a time
 * zone older than the offsets of today), the band of each bound to the millisecond, the notices
 * kept fixed in number, a redacted pending entry, a `NOT_REQUESTED` without its output, and the
 * options of `verifyProof` that are not options.
 */
import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  redactProof,
  sealProof,
  signProof,
  verifyProof,
} from '../src/index.js';
import type { DecisionProof, RuleDefinitionInput, UnsaltedProof } from '../src/index.js';
import { normalizeRuleDefinition } from '../src/index.js';
import { boundWithFixed } from '../src/issues.js';
import { definitionFindings } from '../src/proof/definition-checks.js';
import { intlCalendar } from '../src/proof/intl-calendar.js';
import type { ProofView } from '../src/proof/types.js';
import { handSealed, optionError } from './helpers.js';
import { NOT_REPLAYED, withRuntimeTzdata } from './notices.js';
import { specError } from './helpers.js';
import { RFC_PUBLIC, RFC_SECRET, ruleA, ruleB, signed, unsalted, unsigned } from './proof-cases.js';
import { traceProof } from './proof-trace.js';

const TRUSTED = { 'executor-1': RFC_PUBLIC };

/** The sample proof for `rule` in place of `ruleA`, at `evaluatedAt`, signed by the trusted key. */
function proofOf(
  rule: RuleDefinitionInput,
  evaluatedAt: string,
  change: (content: ProofView) => void = () => undefined,
): DecisionProof {
  const content = withRuntimeTzdata(unsigned());
  content.evaluatedAt = evaluatedAt;
  content.rules[0]!.checksum = computeRuleChecksum(rule);
  change(content);
  return signProof(sealProof(unsalted(content)), RFC_SECRET, 'executor-1');
}

const check = (proof: DecisionProof, rule: RuleDefinitionInput, options: object = {}) =>
  verifyProof(proof, { trustedKeys: TRUSTED, rules: [rule, ruleB], ...options });

const OUTSIDE = { status: 'invalid', issues: ['rule applied outside its window: r1@1'] };
const INSIDE = { status: 'authentic', issues: [NOT_REPLAYED] };

describe('U1: a window narrower than a day is decided bound by bound', () => {
  const holiday = {
    ...ruleA,
    effectiveFrom: '2025-06-01',
    effectiveUntil: '2025-06-02',
    timeZone: 'Europe/Paris',
  };

  it('a one-day window under Europe/Paris holds the afternoon of that day', () => {
    // 12:00 in Paris; the extremes -12:00 and +14:00 put it on the day before and the day after.
    expect(check(proofOf(holiday, '2025-06-01T10:00:00.000Z'), holiday)).toEqual(INSIDE);
  });

  it('and not the instants just outside it, to the millisecond (Paris is +02:00 in June)', () => {
    expect(check(proofOf(holiday, '2025-05-31T21:59:59.999Z'), holiday)).toEqual(OUTSIDE);
    expect(check(proofOf(holiday, '2025-05-31T22:00:00.000Z'), holiday)).toEqual(INSIDE);
    expect(check(proofOf(holiday, '2025-06-01T21:59:59.999Z'), holiday)).toEqual(INSIDE);
    expect(check(proofOf(holiday, '2025-06-01T22:00:00.000Z'), holiday)).toEqual(OUTSIDE);
  });

  it('the same window read from the zone of the decision, with no zone on the rule', () => {
    const rule = { ...holiday, timeZone: undefined };
    const proof = proofOf(rule, '2025-06-01T10:00:00.000Z', (c) => (c.timeZone = 'Europe/Paris'));
    expect(check(proof, rule)).toEqual(INSIDE);
  });

  it('a short window of instants against a civil evaluatedAt', () => {
    const short = {
      ...ruleA,
      effectiveFrom: '2025-06-01T08:00:00.000Z',
      effectiveUntil: '2025-06-01T16:00:00.000Z',
      timeZone: 'Europe/Paris',
    };
    // Bounds at 10:00 and 18:00 in Paris: the day of 2025-06-01 holds both, so the window
    // holds part of that day only: it is said, not guessed.
    const out = check(proofOf(short, '2025-06-01'), short);
    expect(out.issues).toEqual([
      'window not checked: r1@1 (the day holds the bound of the window)',
      NOT_REPLAYED,
    ]);
    expect(check(proofOf(short, '2025-05-30'), short)).toEqual(OUTSIDE);
    expect(check(proofOf(short, '2025-06-03'), short)).toEqual(OUTSIDE);
  });
});

describe('U4: a zone older than the offsets of today', () => {
  it('Sitka in 1860 (+14:58:47) reads the instant as the next day', () => {
    // 1860-01-01T09:30Z is 1860-01-02 00:28 in Sitka: inside a window that starts on 01-02.
    const rule = { ...ruleA, effectiveFrom: '1860-01-02', timeZone: 'America/Sitka' };
    expect(check(proofOf(rule, '1860-01-01T09:30:00.000Z'), rule)).toEqual(INSIDE);
  });

  it('and 1860-01-01T08:59Z is still the day before there', () => {
    const rule = { ...ruleA, effectiveFrom: '1860-01-02', timeZone: 'America/Sitka' };
    expect(check(proofOf(rule, '1860-01-01T08:59:00.000Z'), rule)).toEqual(OUTSIDE);
  });
});

describe('the band of each bound, to the millisecond (a zone the runtime does not know)', () => {
  const rule = {
    ...ruleA,
    effectiveFrom: '2025-01-01',
    effectiveUntil: '2025-02-01',
    timeZone: 'Mars/Olympus',
  };
  const NOTICE = {
    status: 'authentic',
    issues: ['window not checked: r1@1 (zone Mars/Olympus unknown to this verifier)', NOT_REPLAYED],
  };
  const at = (instant: string) => check(proofOf(rule, instant), rule);

  it.each([
    ['2024-12-30T23:59:59.999Z', OUTSIDE],
    ['2024-12-31T00:00:00.000Z', NOTICE],
    ['2025-01-01T23:59:59.999Z', NOTICE],
    ['2025-01-02T00:00:00.000Z', INSIDE],
    ['2025-01-30T23:59:59.999Z', INSIDE],
    ['2025-01-31T00:00:00.000Z', NOTICE],
    ['2025-02-01T23:59:59.999Z', NOTICE],
    ['2025-02-02T00:00:00.000Z', OUTSIDE],
  ])('%s', (instant, expected) => {
    expect(at(instant)).toEqual(expected);
  });

  it('a civil day against bounds that are instants: the band is the day of the bound ± a day', () => {
    const instants = {
      ...ruleA,
      effectiveFrom: '2025-06-01T11:00:00.000Z',
      effectiveUntil: '2025-06-10T11:00:00.000Z',
      timeZone: 'Mars/Olympus',
    };
    const on = (day: string) => check(proofOf(instants, day), instants);
    expect(on('2025-05-30')).toEqual(OUTSIDE);
    expect(on('2025-05-31').issues).toHaveLength(2);
    expect(on('2025-06-02').issues).toHaveLength(2);
    expect(on('2025-06-03').issues).toHaveLength(1);
    expect(on('2025-06-03').status).toBe('authentic');
    expect(on('2025-06-08').status).toBe('authentic');
    expect(on('2025-06-09').issues).toHaveLength(2);
    expect(on('2025-06-11').issues).toHaveLength(2);
    expect(on('2025-06-12')).toEqual(OUTSIDE);
  });
});

describe('U2: the notices of a verdict are fixed in number', () => {
  /** A proof of `count` rules, each excluded as `INACTIVE_DATE` and each with its own `effectiveOn`. */
  function crowd(
    count: number,
    reasonOf?: (i: number) => string,
  ): { proof: DecisionProof; rules: RuleDefinitionInput[] } {
    const content = unsigned();
    const rules = Array.from({ length: count }, (_, i): RuleDefinitionInput => {
      const id = `q${String(i).padStart(5, '0')}`;
      return reasonOf ? { ...ruleA, id } : { ...ruleA, id, effectiveOn: `/$dates/d${i}` };
    });
    (content as { rules: unknown }).rules = rules.map((rule, i) => ({
      ...content.rules[0]!,
      id: rule.id,
      checksum: computeRuleChecksum(rule),
      priority: rule.priority,
      ruleSet: 'local',
      sourceRef: undefined,
      salt: String(i),
    })) as never;
    content.applied = [];
    content.outputs[0]!.contributors = [];
    content.outputs[0]!.value = 0;
    content.skipped = rules.map((rule, i) => ({
      ruleId: rule.id,
      version: 1,
      output: 'value',
      reason: reasonOf ? reasonOf(i) : 'INACTIVE_DATE',
      status: 'determined',
      stratum: 0,
      salt: '',
    })) as never;
    // Unsigned key: the verdict is `consistent`, and says why.
    return { proof: signProof(sealProof(unsalted(content)), RFC_SECRET, 'unknown-signer'), rules };
  }

  it.each([150, 10_000])(
    '%i rules, each with its own effectiveOn: one notice, nothing cut',
    (count) => {
      const { proof, rules } = crowd(count);
      const out = verifyProof(proof, { trustedKeys: TRUSTED, rules });
      expect(out.status).toBe('consistent');
      expect(out.issues).toEqual([
        'untrusted key',
        `window not checked for ${count} rules (effectiveOn is not the decision date): ` +
          `q00000@1, q00001@1, q00002@1, q00003@1, q00004@1 and ${count - 5} more`,
        NOT_REPLAYED,
      ]);
    },
    120_000,
  );

  it('150 distinct unknown reasons: twenty named, the rest counted, and the verdict says why', () => {
    const { proof, rules } = crowd(150, (i) => `REASON_${String(i).padStart(3, '0')}`);
    const out = verifyProof(proof, { trustedKeys: TRUSTED, rules });
    expect(out.status).toBe('consistent');
    expect(out.issues).toHaveLength(23);
    expect(out.issues[0]).toBe('untrusted key');
    expect(out.issues[1]).toBe('reason not checked: REASON_000');
    expect(out.issues[20]).toBe('reason not checked: REASON_019');
    expect(out.issues[21]).toBe('reason not checked: 130 more reasons');
    expect(out.issues[22]).toBe(NOT_REPLAYED);
  });

  it('nothing is "left out" when nothing was', () => {
    const out = verifyProof(signed(), { trustedKeys: TRUSTED, rules: [ruleA, ruleB] });
    expect(out.issues.some((m) => m.includes('left out'))).toBe(false);
  });
});

describe('U2: the redaction notices survive more than 100 findings found before them', () => {
  it('150 rules that no entry decides, then a redacted entry: the notice and the cut are both there', () => {
    const content = unsigned();
    const extra = Array.from({ length: 150 }, (_, i) => ({
      ...content.rules[0]!,
      id: `zz${String(i).padStart(3, '0')}`,
    }));
    (content as { rules: unknown }).rules = [...content.rules, ...extra];
    const redacted = redactProof(
      handSealed({ ...content, inputSalted: true }) as unknown as DecisionProof,
      (section, i) => section === 'applied' && i === 0,
    );
    const out = verifyProof(redacted, { trustedKeys: TRUSTED });
    expect(out.status).toBe('invalid');
    expect(out.issues).toHaveLength(100);
    expect(out.issues).toContain('redacted entries: 1');
    expect(out.issues.at(-1)).toMatch(/^further problems not listed \(limit 100\): \d+ left out$/);
  });
});

describe('U3: a redacted pending entry is named', () => {
  it('1 pending entry redacted: not checked against rules', () => {
    const SEED = new Uint8Array(32).fill(9);
    const content = traceProof({
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
      rules: [{ id: 'T' }],
      pending: [
        { ruleId: 'T', output: 'value', reason: 'UNDETERMINED', detail: 'x', fired: undefined },
      ],
    });
    content.evaluatedAt = '2025-06-01';
    const rule = { ...ruleA, model: 'M', id: 'T', priority: 0 };
    (content.rules as { checksum: string }[])[0]!.checksum = computeRuleChecksum(rule);
    const sealed = sealProof({ ...unsalted(content), inputSalted: true } as UnsaltedProof, SEED);
    const hidden = redactProof(sealed, (section) => section === 'pending');
    const out = verifyProof(hidden, { rules: [rule] });
    expect(out.issues).toContain('1 pending entry redacted: not checked against rules');
  });
});

describe('U5: a NOT_REQUESTED without its output is malformed', () => {
  it('is invalid, with the reason named', () => {
    const invalid: string[] = [];
    definitionFindings(
      {
        evaluatedAt: '2025-06-01',
        timeZone: 'UTC',
        ruleSets: [],
        applied: [],
        pending: [],
        requested: ['value'],
        skipped: [{ ruleId: 'r1', version: 1, reason: 'NOT_REQUESTED' }],
      } as unknown as ProofView,
      new Map([['r1@1', normalizeRuleDefinition(ruleA)]]),
      { invalid: (m) => invalid.push(m), unchecked: () => undefined },
    );
    expect(invalid).toEqual(['NOT_REQUESTED without an output: r1@1']);
  });
});

describe('U8: an option that is not an option throws, and is named', () => {
  const run = (options: object) => () => verifyProof(signed(), options);

  it('a typo of calendar', () => {
    const error = optionError(run({ trustedKeys: TRUSTED, calender: {} }));
    expect(error.code).toBe('INVALID_OPTIONS');
    expect(error.option).toBe('options.calender');
    expect(error.message).toBe('options.calender is not an option (did you mean calendar?)');
  });

  it('rule for rules, and a name close to nothing', () => {
    expect(specError(run({ trustedKeys: TRUSTED, rule: [] })).message).toBe(
      'options.rule is not an option (did you mean rules?)',
    );
    expect(specError(run({ trustedKeys: TRUSTED, whatever: 1 })).message).toBe(
      'options.whatever is not an option',
    );
  });

  it('a symbol key', () => {
    expect(specError(run({ trustedKeys: TRUSTED, [Symbol('x')]: 1 })).message).toBe(
      'options.Symbol(x) is not an option',
    );
  });

  it('maxProofTimeZones must be a positive integer', () => {
    for (const bad of [0, -1, 1.5, '64', Number.NaN]) {
      expect(specError(run({ maxProofTimeZones: bad })).message).toBe(
        'options.maxProofTimeZones must be a positive integer',
      );
    }
  });

  it('the real options are accepted', () => {
    const ok = verifyProof(signed(), { trustedKeys: TRUSTED, rules: [ruleA, ruleB] });
    expect(ok.status).toBe('authentic');
  });
});

describe('the calendar of the runtime, and the bound', () => {
  it('reads the civil date of an instant: offsets with seconds and negative offsets', () => {
    // Sitka before 1867 is +14:58:47: 09:01:13Z is exactly midnight there.
    expect(intlCalendar.toCivilDate('1860-01-01T09:01:12.999Z', 'America/Sitka')).toBe(
      '1860-01-01',
    );
    expect(intlCalendar.toCivilDate('1860-01-01T09:01:13.000Z', 'America/Sitka')).toBe(
      '1860-01-02',
    );
    expect(intlCalendar.toCivilDate('2025-01-01T04:59:59.999Z', 'America/New_York')).toBe(
      '2024-12-31',
    );
    expect(intlCalendar.toCivilDate('2025-01-01T05:00:00.000Z', 'America/New_York')).toBe(
      '2025-01-01',
    );
  });

  it('finds the first instant of a day, to the millisecond', () => {
    expect(intlCalendar.startOfDay('2025-06-01', 'Europe/Paris')).toBe('2025-05-31T22:00:00.000Z');
    expect(intlCalendar.startOfDay('2025-01-01', 'Pacific/Kiritimati')).toBe(
      '2024-12-31T10:00:00.000Z',
    );
    expect(intlCalendar.startOfDay('2025-01-01', 'America/New_York')).toBe(
      '2025-01-01T05:00:00.000Z',
    );
    // A day with no midnight (Chile, 2025-09-07): the first local time that exists, 01:00.
    expect(intlCalendar.startOfDay('2025-09-07', 'America/Santiago')).toBe(
      '2025-09-07T04:00:00.000Z',
    );
  });

  it('a bound that is exactly the first instant of its day puts the whole day inside', () => {
    const rule = {
      ...ruleA,
      effectiveFrom: '2025-05-31T22:00:00.000Z',
      effectiveUntil: '2025-06-01T22:00:00.000Z',
      timeZone: 'Europe/Paris',
    };
    expect(check(proofOf(rule, '2025-06-01'), rule)).toEqual(INSIDE);
  });

  it('two bounds and an instant of one form are compared as text, in any zone', () => {
    const rule = {
      ...ruleA,
      effectiveFrom: '2025-06-01T00:00:00.000Z',
      effectiveUntil: '2025-06-02T00:00:00.000Z',
      timeZone: 'Mars/Olympus',
    };
    expect(check(proofOf(rule, '2025-06-01T12:00:00.000Z'), rule)).toEqual(INSIDE);
    expect(check(proofOf(rule, '2025-06-02T00:00:00.000Z'), rule)).toEqual(OUTSIDE);
    const civil = { ...rule, effectiveFrom: '2025-06-01', effectiveUntil: '2025-06-02' };
    expect(check(proofOf(civil, '2025-06-01'), civil)).toEqual(INSIDE);
    expect(check(proofOf(civil, '2025-06-02'), civil)).toEqual(OUTSIDE);
  });

  it('boundWithFixed adds no "left out" line when nothing was left out', () => {
    const fixed = Array.from({ length: 101 }, (_, i) => ({
      message: `f${i}`,
      fixed: true as const,
    }));
    const out = boundWithFixed(fixed);
    expect(out).toHaveLength(101);
    expect(out.some((m) => m.includes('left out'))).toBe(false);
  });
});
