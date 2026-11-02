/**
 * Task 9K5, round 1 of the audit: the stored-form validator, the bound that never cuts the
 * notices, the redacted entries named, `null` in every reader of a rule, the pending window,
 * the reasons verified elsewhere, `NOT_REQUESTED`, the stored family of functions, symbol keys,
 * a mistyped checksum, and the fractions of a second on the live paths.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  computeRuleFingerprint,
  createAttestation,
  findOverlappingVersions,
  isEffectiveAt,
  normalizeRuleDefinition,
  redactProof,
  sealProof,
  signProof,
  toExecutableRule,
  toStoredPayload,
  validateProof,
  validateProofInput,
  validateRuleDefinition,
  validateStoredRuleDefinition,
  verifyAttestation,
  verifyProof,
  windowContains,
} from '../src/index.js';
import type { DecisionProof, RuleDefinitionInput, UnsaltedProof } from '../src/index.js';
import * as canonicalEntry from '../src/canonical-entry.js';
import { boundWithFixed } from '../src/issues.js';
import { definitionFindings } from '../src/proof/definition-checks.js';
import type { ProofView } from '../src/proof/types.js';
import { fixedCalendar, specError } from './helpers.js';
import { NOT_REPLAYED } from './notices.js';
import {
  baseContent,
  input,
  RFC_PUBLIC,
  RFC_SECRET,
  ruleA,
  ruleB,
  unsalted,
  unsigned,
} from './proof-cases.js';

const base = {
  id: 'r1',
  version: 1,
  model: 'PERCENTAGE',
  params: { rate: 0.05 },
  priority: 1,
  effectiveFrom: '2025-01-01',
};

describe('finding 1: a validator for the stored and normalized form', () => {
  const stored = { ...base, effectiveUntil: null, dimensions: {}, tags: [] };

  it('is exported by both entries', () => {
    expect(canonicalEntry.validateStoredRuleDefinition).toBe(validateStoredRuleDefinition);
  });

  it('accepts effectiveUntil: null and nothing else; the authored one refuses it', () => {
    expect(validateStoredRuleDefinition(stored)).toEqual({ valid: true, errors: [], issues: [] });
    expect(validateRuleDefinition(stored).errors).toEqual([
      'effectiveUntil is null: omit the field instead',
    ]);
  });

  it('refuses a null checksum in both forms: a stored rule always has its checksum', () => {
    const row = { ...stored, checksum: null };
    const message = 'checksum is null: omit the field instead';
    expect(validateStoredRuleDefinition(row).errors).toEqual([message]);
    expect(validateRuleDefinition(row).errors).toContain(message);
    expect(specError(() => computeRuleChecksum(row as never)).message).toBe(message);
  });

  it('a normalized rule is valid in its own form only', () => {
    const normalized = normalizeRuleDefinition(base);
    expect(validateStoredRuleDefinition(normalized).valid).toBe(true);
    expect(validateRuleDefinition(normalized).valid).toBe(false);
  });

  it('lists the real problems of a stored row, and not the null of its own form', () => {
    const row = { ...stored, effectiveFrom: 'yesterday', tags: 'x' };
    const authored = validateRuleDefinition(row).errors;
    const found = validateStoredRuleDefinition(row).errors;
    expect(found).toHaveLength(2);
    expect(found.some((message) => message.includes('effectiveUntil'))).toBe(false);
    expect(authored).toHaveLength(3);
    expect(authored).toContain('effectiveUntil is null: omit the field instead');
  });

  it.each([
    ['ruleSet', 'ruleSet'],
    ['effectiveOn', 'effectiveOn'],
    ['timeZone', 'timeZone'],
    ['condition', 'condition'],
    ['dominanceGroup', 'dominanceGroup'],
    ['tags', 'tags'],
    ['extensions', 'extensions'],
  ])('refuses a null %s in both forms', (field) => {
    const row = { ...stored, [field]: null };
    const message = `${field} is null: omit the field instead`;
    expect(validateStoredRuleDefinition(row).errors).toEqual([message]);
    expect(validateRuleDefinition(row).errors).toContain(message);
  });

  it('refuses what the authored one refuses: an unknown field, a null dimension', () => {
    for (const row of [
      { ...stored, dominancegroup: 'g' },
      { ...stored, dimensions: { a: null } },
      { ...stored, extensions: { a: null } },
      { ...stored, checksum: 5 },
    ]) {
      expect(validateStoredRuleDefinition(row).valid).toBe(false);
      expect(validateRuleDefinition(row).valid).toBe(false);
    }
  });
});

describe('finding 2: the notices that say what was not checked are never cut', () => {
  const finding = (message: string, fixed?: true) => (fixed ? { message, fixed } : { message });

  it('keeps every fixed item and says how many were left out', () => {
    const items = [
      ...Array.from({ length: 150 }, (_, i) => finding(`problem ${i}`)),
      finding('fixed one', true),
      finding('fixed two', true),
    ];
    const bounded = boundWithFixed(items);
    expect(bounded).toHaveLength(100);
    expect(bounded.slice(-3)).toEqual([
      'fixed one',
      'fixed two',
      'further problems not listed (limit 100): 53 left out',
    ]);
    expect(bounded[0]).toBe('problem 0');
    expect(bounded[96]).toBe('problem 96');
    expect(bounded.filter((message) => message.startsWith('problem '))).toHaveLength(97);
  });

  it('cuts nothing at 100 items or fewer', () => {
    const items = [
      ...Array.from({ length: 98 }, (_, i) => finding(`p${i}`)),
      finding('fixed', true),
      finding('last'),
    ];
    expect(boundWithFixed(items)).toEqual(items.map((item) => item.message));
  });

  it('150 rules with a window that cannot be decided give one notice, and both fixed ones stay', () => {
    const rule = { ...ruleA, effectiveOn: '/$dates/birth' };
    const content = unsigned();
    const many = Array.from({ length: 150 }, (_, i) => ({
      ...content.rules[0]!,
      id: `r${String(i).padStart(3, '0')}`,
      checksum: computeRuleChecksum({ ...rule, id: `r${String(i).padStart(3, '0')}` }),
    }));
    expect(many).toHaveLength(150);
    const notices: string[] = [];
    const matched = new Map(
      many.map((ref) => [`${ref.id}@1`, normalizeRuleDefinition({ ...rule, id: ref.id })]),
    );
    const view = {
      evaluatedAt: '2025-06-01',
      timeZone: 'UTC',
      ruleSets: [],
      applied: many.map((ref) => ({ ruleId: ref.id, version: 1, model: 'FLAT', output: 'value' })),
      pending: [],
      skipped: [],
    } as unknown as ProofView;
    definitionFindings(view, matched, {
      invalid: () => undefined,
      unchecked: (m) => notices.push(m),
    });
    expect(notices).toEqual([
      'window not checked for 150 rules (effectiveOn is not the decision date): r000@1, r001@1, r002@1, r003@1, r004@1 and 145 more',
    ]);
  });

  it('150 distinct reasons: twenty named, the rest counted', () => {
    const definition = normalizeRuleDefinition(ruleA);
    const view = {
      evaluatedAt: '2025-06-01',
      timeZone: 'UTC',
      ruleSets: [],
      applied: [],
      pending: [],
      skipped: Array.from({ length: 150 }, (_, i) => ({
        ruleId: 'r1',
        version: 1,
        reason: `REASON_${i}`,
      })),
    } as unknown as ProofView;
    const notices: string[] = [];
    definitionFindings(view, new Map([['r1@1', definition]]), {
      invalid: () => undefined,
      unchecked: (m) => notices.push(m),
    });
    expect(notices).toHaveLength(21);
    expect(notices[0]).toBe('reason not checked: REASON_0');
    expect(notices[20]).toBe('reason not checked: 130 more reasons');
  });
});

describe('finding 4: a redacted trace entry is named, never skipped silently', () => {
  const SEED = new Uint8Array(32).fill(7);
  const proof = (): DecisionProof =>
    signProof(
      sealProof({ ...unsalted(unsigned()), inputSalted: true } as UnsaltedProof, SEED),
      RFC_SECRET,
      'executor-1',
    );
  const hide = (section: string, index: number): DecisionProof =>
    redactProof(proof(), (s, i) => s === section && i === index);
  const options = { trustedKeys: { 'executor-1': RFC_PUBLIC }, rules: [ruleA, ruleB] };

  it('a redacted applied step, even one outside its window', () => {
    const result = verifyProof(hide('applied', 0), options);
    expect(result.status).toBe('authentic-redacted');
    expect(result.issues).toContain('1 applied entry redacted: not checked against rules');
    expect(result.issues.at(-1)).toBe(NOT_REPLAYED);
  });

  it('a redacted skipped entry', () => {
    expect(verifyProof(hide('skipped', 0), options).issues).toContain(
      '1 skipped entry redacted: not checked against rules',
    );
  });

  it('several entries are counted; without rules nothing is said about rules', () => {
    const both = redactProof(proof(), (s) => s === 'applied' || s === 'skipped');
    const issues = verifyProof(both, options).issues;
    expect(issues).toContain('1 applied entry redacted: not checked against rules');
    expect(issues).toContain('1 skipped entry redacted: not checked against rules');
    expect(
      verifyProof(hide('applied', 0), { trustedKeys: options.trustedKeys }).issues.some((m) =>
        m.includes('not checked against rules'),
      ),
    ).toBe(false);
  });
});

describe('findings 6 and 13: null in every reader of a rule, and a mistyped checksum', () => {
  it('findOverlappingVersions refuses a null ruleSet and a null effectiveOn', () => {
    const row = { id: 'r1', version: 1, effectiveFrom: '2025-01-01' };
    expect(
      specError(() =>
        findOverlappingVersions([{ ...row, ruleSet: null }] as never, 'UTC', fixedCalendar),
      ).message,
    ).toBe('rule r1@1: ruleSet is null: omit the field instead');
    expect(
      specError(() =>
        findOverlappingVersions([{ ...row, effectiveOn: null }] as never, 'UTC', fixedCalendar),
      ).message,
    ).toBe('rule r1@1: effectiveOn is null: omit the field instead');
    expect(findOverlappingVersions([row] as never, 'UTC', fixedCalendar).overlaps).toEqual([]);
  });

  it('windowContains and isEffectiveAt refuse a null timeZone', () => {
    const rule = { effectiveFrom: '2025-01-01', timeZone: null } as never;
    const message = 'timeZone is null: omit the field instead';
    expect(specError(() => windowContains(rule, '2025-06-01', 'UTC', fixedCalendar)).message).toBe(
      message,
    );
    expect(specError(() => isEffectiveAt(rule, new Date('2025-06-01T00:00:00Z'))).message).toBe(
      message,
    );
    expect(isEffectiveAt({ effectiveFrom: '2025-01-01' }, new Date('2025-06-01T00:00:00Z'))).toBe(
      true,
    );
  });

  it('a checksum that is neither absent nor a string is refused, in both forms', () => {
    const row = { ...base, checksum: 5 } as unknown as RuleDefinitionInput;
    expect(validateRuleDefinition(row).errors).toEqual(['checksum must be a string']);
    expect(validateStoredRuleDefinition(row).errors).toEqual(['checksum must be a string']);
    expect(specError(() => normalizeRuleDefinition(row)).message).toBe('checksum must be a string');
    expect(specError(() => computeRuleChecksum(row)).message).toBe('checksum must be a string');
  });
});

describe('finding 7, 18: reasons verified elsewhere, NOT_REQUESTED, a pending rule outside its window', () => {
  const definition = normalizeRuleDefinition(ruleA);
  const run = (view: object, def = definition) => {
    const invalid: string[] = [];
    const unchecked: string[] = [];
    definitionFindings(
      {
        evaluatedAt: '2025-06-01',
        timeZone: 'UTC',
        ruleSets: [],
        applied: [],
        pending: [],
        skipped: [],
        ...view,
      } as unknown as ProofView,
      new Map([['r1@1', def]]),
      { invalid: (m) => invalid.push(m), unchecked: (m) => unchecked.push(m) },
    );
    return { invalid, unchecked };
  };
  const skip = (reason: string) => ({
    skipped: [{ ruleId: 'r1', version: 1, reason, output: 'value' }],
  });

  it.each(['INHIBITED', 'SHORT_CIRCUITED', 'RULE_CONFLICT', 'NOT_REQUESTED'])(
    '%s is checked elsewhere or here: no notice',
    (reason) => {
      const { unchecked } = run({ ...skip(reason), requested: ['elsewhere'] });
      expect(unchecked).toEqual([]);
    },
  );

  it('NOT_REQUESTED while every output was requested is a contradiction', () => {
    expect(run(skip('NOT_REQUESTED')).invalid).toEqual([
      'NOT_REQUESTED while every output was requested: r1@1',
    ]);
  });

  it('NOT_REQUESTED on a requested output is a contradiction; on another one it is fine', () => {
    expect(run({ ...skip('NOT_REQUESTED'), requested: ['value'] }).invalid).toEqual([
      'NOT_REQUESTED on a requested output: r1@1',
    ]);
    expect(run({ ...skip('NOT_REQUESTED'), requested: ['other'] }).invalid).toEqual([]);
  });

  it('a pending entry outside its window is a contradiction', () => {
    const pending = { pending: [{ ruleId: 'r1', version: 1, reason: 'UNDETERMINED' }] };
    expect(run({ ...pending, evaluatedAt: '2024-06-01' }).invalid).toEqual([
      'rule pending outside its window: r1@1',
    ]);
    expect(run(pending).invalid).toEqual([]);
  });

  it('a pending entry whose window cannot be decided is named', () => {
    const rule = normalizeRuleDefinition({ ...ruleA, effectiveOn: '/$dates/x' });
    const pending = { pending: [{ ruleId: 'r1', version: 1, reason: 'UNDETERMINED' }] };
    expect(run(pending, rule).unchecked).toEqual([
      'window not checked: r1@1 (effectiveOn is /$dates/x)',
    ]);
  });
});

describe('findings 10, 11: which function reads which form', () => {
  const normalized = normalizeRuleDefinition(base);

  it('the stored family reads a normalized rule back', () => {
    const checksum = computeRuleChecksum(base);
    expect(computeRuleChecksum(normalized)).toBe(checksum);
    expect(computeRuleFingerprint(normalized)).toBe(computeRuleFingerprint(base));
    expect(toExecutableRule(normalized).checksum).toBe(checksum);
  });

  it('the authored functions refuse a normalized rule: it is not fed back to them', () => {
    const message = 'effectiveUntil is null: omit the field instead';
    expect(specError(() => normalizeRuleDefinition(normalized)).message).toBe(message);
    expect(validateRuleDefinition(normalized).errors).toEqual([message]);
    expect(specError(() => toStoredPayload(normalized)).message).toBe(message);
  });

  it('toStoredPayload writes what an author writes, with the checksum of the payload', () => {
    const { payload, checksum } = toStoredPayload(base);
    expect(checksum).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(checksum).toBe(computeRuleChecksum(base));
  });
});

describe('finding 16: a hidden or symbol-keyed field is not ignored', () => {
  it('a non-enumerable unknown field is refused', () => {
    const rule = { ...base };
    Object.defineProperty(rule, 'hidden', { value: 1, enumerable: false });
    expect(validateRuleDefinition(rule).errors).toEqual(['unknown rule field: hidden']);
    expect(specError(() => normalizeRuleDefinition(rule)).message).toBe(
      'unknown rule field: hidden',
    );
    expect(specError(() => computeRuleChecksum(rule)).message).toBe('unknown rule field: hidden');
  });

  it('a symbol key is refused, named', () => {
    const rule = { ...base, [Symbol('tag')]: 1 };
    expect(validateRuleDefinition(rule).errors).toEqual(['unknown rule field: Symbol(tag)']);
    expect(specError(() => normalizeRuleDefinition(rule)).message).toBe(
      'unknown rule field: Symbol(tag)',
    );
  });
});

describe('finding 14: more than three fractional digits are refused on the live paths', () => {
  const FINE = '2025-06-01T00:00:00.1234Z';

  it('a rule bound', () => {
    for (const field of ['effectiveFrom', 'effectiveUntil']) {
      const rule = { ...base, effectiveFrom: '2024-01-01T00:00:00.000Z', [field]: FINE };
      expect(validateRuleDefinition(rule).errors[0]).toContain(`got "${FINE}"`);
      expect(specError(() => normalizeRuleDefinition(rule)).code).toBe('INVALID_DATE');
    }
  });

  it('evaluatedAt and sealedAt of a proof', () => {
    const content = baseContent();
    const issues = (patch: object) =>
      validateProof({ ...content, ...patch, digest: 'a'.repeat(64) }).errors;
    expect(issues({ evaluatedAt: FINE })).toContain(
      'evaluatedAt must be null, a civil date YYYY-MM-DD or an instant YYYY-MM-DDTHH:MM:SS.sssZ',
    );
    expect(issues({ sealedAt: FINE })).toContain(
      'sealedAt must be an instant YYYY-MM-DDTHH:MM:SS.sssZ',
    );
  });

  it('the date of an attestation', () => {
    const body = {
      format: 'run-iq.attestation/1',
      kind: 'cosignature',
      subject: { proofDigest: 'a'.repeat(64) },
      keyId: 'k',
      at: FINE,
      signature: 'A'.repeat(85) + 'w',
    };
    const result = verifyAttestation(body, 'a'.repeat(64), {});
    expect(result.status).toBe('invalid');
    expect(result.issues[0]).toContain('/at must be an instant');
  });

  it('a named date of the input', () => {
    const data = { ...input, meta: { ...input.meta, dates: { effective: FINE } } };
    expect(validateProofInput(data).length).toBeGreaterThan(0);
  });
});

describe('findings 3 and 12: the cases the first tests left open', () => {
  it('a day that holds an instant bound, in an IANA zone, is said and never read as outside', () => {
    const cut = {
      ...ruleA,
      timeZone: 'Europe/Paris',
      effectiveFrom: '2025-06-01T06:00:00.000Z',
      effectiveUntil: '2025-12-01T00:00:00.000Z',
    };
    const content = unsigned();
    content.evaluatedAt = '2025-06-01';
    content.rules[0]!.checksum = computeRuleChecksum(cut);
    const proof = signProof(sealProof(unsalted(content)), RFC_SECRET, 'executor-1');
    const out = verifyProof(proof, {
      trustedKeys: { 'executor-1': RFC_PUBLIC },
      rules: [cut, ruleB],
    });
    expect(out).toEqual({
      status: 'authentic',
      issues: ['window not checked: r1@1 (the day holds the bound of the window)', NOT_REPLAYED],
    });
  });

  it('verifyAttestation reads every trusted key: a broken key of another id is invalid', () => {
    const body = createAttestation('a'.repeat(64), RFC_SECRET, 'reviewer');
    const keys = { reviewer: RFC_PUBLIC, other: 'zz' };
    expect(verifyAttestation(body, 'a'.repeat(64), keys)).toEqual({
      status: 'invalid',
      issues: ['trustedKeys.other is malformed'],
    });
    expect(verifyAttestation(body, 'a'.repeat(64), { reviewer: RFC_PUBLIC }).status).toBe(
      'authentic',
    );
  });
});
