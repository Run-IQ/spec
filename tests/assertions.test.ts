import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeAssertionDigest,
  governingAssertion,
  isProvisionalAssertion,
  sha256Hex,
  validateProofInput,
} from '../src/index.js';
import type { AssertionMethod, AssertionStatus, FactAssertion } from '../src/index.js';
import { HUMAN_ASSERTION, proofInput, specError } from './helpers.js';

const METHODS: readonly AssertionMethod[] = [
  'human',
  'ai',
  'document',
  'presumed',
  'declared',
  'measured',
  'estimated',
  'derived',
  'decision',
];
const STATUSES: readonly AssertionStatus[] = ['proposed', 'validated', 'contested'];
const PROOF_DIGEST = 'b'.repeat(64);
const SOURCE = { proofDigest: PROOF_DIGEST, output: 'risque' };
const BASE = '/meta/assertions/~1revenue';

/** The issues of an input whose only assertion is `assertion`, on `/revenue`. */
function issuesOf(assertion: unknown): unknown {
  return validateProofInput(proofInput({ assertions: { '/revenue': assertion as FactAssertion } }));
}

/** The issues of an input with one valid assertion on each key of `keys`. */
function keyIssues(...keys: string[]): unknown {
  const assertions = Object.fromEntries(keys.map((key) => [key, { ...HUMAN_ASSERTION }]));
  return validateProofInput(proofInput({ assertions }));
}

describe('validateProofInput: assertion keys', () => {
  it.each([
    ['a fact', '/revenue'],
    ['a fact in a list', '/enfants/2/age'],
    ['a named date', '/$dates/facture'],
    ['every named date', '/$dates'],
    ['a dimension', '/$dimensions/pays'],
    ['every dimension', '/$dimensions'],
    ['the whole input', ''],
    ['an escaped key', '/a~1b/~0c'],
    ['an empty data key', '/'],
  ])('accepts %s (%j)', (_name, key) => {
    expect(keyIssues(key)).toEqual([]);
  });

  it.each([
    ['revenue', 'assertion key "revenue" must be a JSON pointer'],
    ['/a~2', 'assertion key "/a~2" must be a JSON pointer'],
    ['/enfants/-', 'assertion key "/enfants/-" must not hold "-": it is not an index'],
    ['/$dates/-', 'assertion key "/$dates/-" must not hold "-": it is not an index'],
  ])('refuses the key %j', (key, message) => {
    expect(keyIssues(key)).toEqual([
      { path: `/meta/assertions/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, message },
    ]);
  });

  it.each([
    ['/$outputs/x', '/meta/assertions/~1$outputs~1x'],
    ['/$item/x', '/meta/assertions/~1$item~1x'],
    ['/$foo', '/meta/assertions/~1$foo'],
    ['/$dates/facture/day', '/meta/assertions/~1$dates~1facture~1day'],
    ['/$dimensions/pays/0', '/meta/assertions/~1$dimensions~1pays~10'],
    ['/$dimensions/$pays', '/meta/assertions/~1$dimensions~1$pays'],
    ['/$dates/$x', '/meta/assertions/~1$dates~1$x'],
    ['/$dates/', '/meta/assertions/~1$dates~1'],
    ['/$dimensions/', '/meta/assertions/~1$dimensions~1'],
  ])('refuses %j: neither a fact, nor a named date, nor a dimension', (key, path) => {
    expect(keyIssues(key)).toEqual([
      {
        path,
        message:
          `assertion key ${JSON.stringify(key)} must name a fact, /$dates/<name> or ` +
          '/$dimensions/<name>',
      },
    ]);
  });

  it('refuses a key with a lone surrogate, at the path of meta.assertions', () => {
    expect(keyIssues('/a\uD800')).toEqual([
      {
        path: '/meta/assertions',
        message: '/meta/assertions has a key with a lone UTF-16 surrogate: "/a\\ud800"',
      },
    ]);
  });
});

describe('validateProofInput: assertion fields', () => {
  it.each(METHODS.filter((method) => method !== 'decision'))('accepts the method %s', (method) => {
    expect(issuesOf({ ...HUMAN_ASSERTION, method })).toEqual([]);
  });

  it('accepts the method decision with the proof it cites', () => {
    expect(issuesOf({ ...HUMAN_ASSERTION, method: 'decision', source: SOURCE })).toEqual([]);
    const withSubject = { ...SOURCE, output: 'rgpd:profilage', subject: '/foyers/@f1' };
    expect(issuesOf({ ...HUMAN_ASSERTION, method: 'decision', source: withSubject })).toEqual([]);
  });

  it.each(STATUSES)('accepts the status %s', (status) => {
    expect(issuesOf({ ...HUMAN_ASSERTION, status })).toEqual([]);
  });

  it.each(['robot', 'Human', '', 7])('refuses the method %j', (method) => {
    expect(issuesOf({ ...HUMAN_ASSERTION, method })).toEqual([
      {
        path: `${BASE}/method`,
        message: `${BASE}/method must be one of ${METHODS.join(', ')}`,
      },
    ]);
  });

  it.each(['accepted', 'Validated', null])('refuses the status %j', (status) => {
    expect(issuesOf({ ...HUMAN_ASSERTION, status })).toEqual([
      {
        path: `${BASE}/status`,
        message: `${BASE}/status must be one of proposed, validated, contested`,
      },
    ]);
  });

  it.each([0, 1, 0.5, 1e-9])('accepts the confidence %j', (confidence) => {
    expect(issuesOf({ ...HUMAN_ASSERTION, confidence })).toEqual([]);
  });

  it.each([-0.1, 1.1, NaN, Infinity, '0.5', null])('refuses the confidence %j', (confidence) => {
    expect(issuesOf({ ...HUMAN_ASSERTION, confidence })).toEqual([
      { path: `${BASE}/confidence`, message: `${BASE}/confidence must be a number from 0 to 1` },
    ]);
  });

  it('accepts an evidence digest in lowercase sha256 hex, and refuses any other', () => {
    expect(issuesOf({ ...HUMAN_ASSERTION, evidenceDigest: 'a'.repeat(64) })).toEqual([]);
    for (const evidenceDigest of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 64]) {
      expect(issuesOf({ ...HUMAN_ASSERTION, evidenceDigest })).toEqual([
        {
          path: `${BASE}/evidenceDigest`,
          message: `${BASE}/evidenceDigest must be a lowercase sha256 hex string`,
        },
      ]);
    }
  });

  it('requires source with the method decision', () => {
    expect(issuesOf({ ...HUMAN_ASSERTION, method: 'decision' })).toEqual([
      {
        path: `${BASE}/source`,
        message: `${BASE}/source is required with method "decision"`,
      },
    ]);
  });

  it.each(METHODS.filter((method) => method !== 'decision'))(
    'refuses source with the method %s',
    (method) => {
      expect(issuesOf({ ...HUMAN_ASSERTION, method, source: SOURCE })).toEqual([
        {
          path: `${BASE}/source`,
          message: `${BASE}/source is only allowed with method "decision"`,
        },
      ]);
    },
  );

  const S = `${BASE}/source`;
  const NOT_A_SUBJECT = 'must be a subject: a JSON pointer whose reserved segments are well formed';

  it.each([
    ['not an object', 'proof', S, `${S} must be an object { proofDigest, output, subject? }`],
    ['an unknown key', { ...SOURCE, rule: 'R1' }, `${S}/rule`, `${S} has an unknown key "rule"`],
    ['no proofDigest', { output: 'x' }, `${S}/proofDigest`, `${S}/proofDigest is required`],
    [
      'an uppercase proofDigest',
      { ...SOURCE, proofDigest: 'B'.repeat(64) },
      `${S}/proofDigest`,
      `${S}/proofDigest must be a lowercase sha256 hex string`,
    ],
    [
      'an empty output',
      { ...SOURCE, output: '' },
      `${S}/output`,
      `${S}/output must be a non-empty string`,
    ],
    [
      'a reserved output',
      { ...SOURCE, output: '$x' },
      `${S}/output`,
      `${S}/output must not start with "$": output names starting with "$" are reserved`,
    ],
    [
      'a dotted output',
      { ...SOURCE, output: 'a.b' },
      `${S}/output`,
      `${S}/output name must not contain "."`,
    ],
    [
      'an output of the local rule set written qualified',
      { ...SOURCE, output: 'local:x' },
      `${S}/output`,
      `${S}/output name must not be qualified by "local": a local name is written bare`,
    ],
    [
      'an invalid subject',
      { ...SOURCE, subject: 'foyers/@f1' },
      `${S}/subject`,
      `${S}/subject ${NOT_A_SUBJECT}`,
    ],
    [
      'a subject with a reversed segment',
      { ...SOURCE, subject: '/!segment=2026-02-01..2026-01-01' },
      `${S}/subject`,
      `${S}/subject ${NOT_A_SUBJECT}`,
    ],
  ])('refuses a source with %s', (_name, source, path, message) => {
    expect(issuesOf({ ...HUMAN_ASSERTION, method: 'decision', source })).toEqual([
      { path, message },
    ]);
  });

  it('accepts complete: false, the one written form of an incomplete list', () => {
    expect(issuesOf({ ...HUMAN_ASSERTION, complete: false })).toEqual([]);
  });

  it.each([true, 'no', null])(
    'refuses complete: %j (a list is complete by default)',
    (complete) => {
      expect(issuesOf({ ...HUMAN_ASSERTION, complete })).toEqual([
        {
          path: `${BASE}/complete`,
          message: `${BASE}/complete must be false: a list is complete by default: omit complete`,
        },
      ]);
    },
  );

  it.each(['2026-01-02', '2026-01-02T08:30:00.000Z'])('accepts at %j', (at) => {
    expect(issuesOf({ ...HUMAN_ASSERTION, at })).toEqual([]);
  });

  it.each(['2026-01-02T08:30:00Z', '2026-01-02T09:30:00.000+01:00', '2026-13-01', 20260102])(
    'refuses at %j',
    (at) => {
      expect(issuesOf({ ...HUMAN_ASSERTION, at })).toEqual([
        {
          path: `${BASE}/at`,
          message:
            `${BASE}/at must be a civil date YYYY-MM-DD or an instant ` +
            'YYYY-MM-DDTHH:MM:SS.sssZ',
        },
      ]);
    },
  );

  it.each([
    ['by', ''],
    ['by', 3],
    ['basis', ''],
  ])('refuses %s %j', (field, value) => {
    expect(issuesOf({ ...HUMAN_ASSERTION, [field]: value })).toEqual([
      { path: `${BASE}/${field}`, message: `${BASE}/${field} must be a non-empty string` },
    ]);
  });

  it('refuses a lone surrogate in by and basis', () => {
    expect(issuesOf({ ...HUMAN_ASSERTION, by: 'a\uD800', basis: 'b\uDC00' })).toEqual([
      { path: `${BASE}/by`, message: `${BASE}/by contains a lone UTF-16 surrogate` },
      { path: `${BASE}/basis`, message: `${BASE}/basis contains a lone UTF-16 surrogate` },
    ]);
  });

  it('requires by, method, at and status, and refuses an unknown field', () => {
    expect(issuesOf({ note: 'x' })).toEqual([
      { path: `${BASE}/note`, message: `${BASE} has an unknown key "note"` },
      ...['by', 'method', 'at', 'status'].map((field) => ({
        path: `${BASE}/${field}`,
        message: `${BASE}/${field} is required`,
      })),
    ]);
  });

  it('refuses an assertion that is not an object', () => {
    expect(issuesOf('validated')).toEqual([
      {
        path: BASE,
        message:
          `${BASE} must be an assertion { by, method, at, status, basis?, ` +
          'evidenceDigest?, confidence?, complete?, source? }',
      },
    ]);
  });
});

describe('governingAssertion', () => {
  const A: FactAssertion = { ...HUMAN_ASSERTION, by: 'A' };
  const B: FactAssertion = { ...HUMAN_ASSERTION, by: 'B' };
  const assertions = { '/societe': A, '/societe/ca': B };

  it('picks the most precise assertion covering the pointer', () => {
    expect(governingAssertion(assertions, '/societe/ca/2025')).toEqual({
      pointer: '/societe/ca',
      assertion: B,
    });
    expect(governingAssertion(assertions, '/societe/ca')).toEqual({
      pointer: '/societe/ca',
      assertion: B,
    });
    expect(governingAssertion(assertions, '/societe/effectif')).toEqual({
      pointer: '/societe',
      assertion: A,
    });
    expect(governingAssertion(assertions, '/autre')).toBeUndefined();
  });

  it('compares segments, not text', () => {
    expect(governingAssertion(assertions, '/societe/cab')).toEqual({
      pointer: '/societe',
      assertion: A,
    });
    expect(governingAssertion(assertions, '/societecorp')).toBeUndefined();
    expect(governingAssertion({ '/a~1b': A }, '/a~1b/c')).toEqual({
      pointer: '/a~1b',
      assertion: A,
    });
    expect(governingAssertion({ '/a~1b': A }, '/a/b/c')).toBeUndefined();
  });

  it('lets an assertion at "" cover everything, below any more precise one', () => {
    const all = { '': A, '/societe/ca': B };
    expect(governingAssertion(all, '/autre')).toEqual({ pointer: '', assertion: A });
    expect(governingAssertion(all, '/$dates/facture')).toEqual({ pointer: '', assertion: A });
    expect(governingAssertion(all, '')).toEqual({ pointer: '', assertion: A });
    expect(governingAssertion(all, '/societe/ca/2025')).toEqual({
      pointer: '/societe/ca',
      assertion: B,
    });
  });

  it('covers named dates and dimensions', () => {
    const meta = { '/$dates': A, '/$dimensions/pays': B };
    expect(governingAssertion(meta, '/$dates/facture')).toEqual({
      pointer: '/$dates',
      assertion: A,
    });
    expect(governingAssertion(meta, '/$dimensions/pays')).toEqual({
      pointer: '/$dimensions/pays',
      assertion: B,
    });
    expect(governingAssertion(meta, '/$dimensions/secteur')).toBeUndefined();
  });

  it('ignores inherited keys', () => {
    const inherited = Object.create({ '/x': A }) as Record<string, FactAssertion>;
    expect(governingAssertion(inherited, '/x')).toBeUndefined();
  });

  it('throws INVALID_INPUT, never a raw error, for assertions that cannot be read', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(specError(() => governingAssertion(proxy, '/x'))).toMatchObject({
      code: 'INVALID_INPUT',
      message:
        "assertions could not be read: Cannot perform 'getOwnPropertyDescriptor' on a proxy " +
        'that has been revoked',
    });
  });

  it('throws INVALID_PATH for a pointer that is not one', () => {
    expect(specError(() => governingAssertion(assertions, 'societe'))).toMatchObject({
      code: 'INVALID_PATH',
      message: 'invalid JSON pointer "societe": must be empty or start with "/"',
    });
  });
});

describe('isProvisionalAssertion', () => {
  it('is true for proposed and contested, whatever the method', () => {
    for (const method of METHODS) {
      expect(isProvisionalAssertion({ ...HUMAN_ASSERTION, method, status: 'proposed' })).toBe(true);
      expect(isProvisionalAssertion({ ...HUMAN_ASSERTION, method, status: 'contested' })).toBe(
        true,
      );
    }
  });

  it('is true for a validated presumption only', () => {
    const validated = METHODS.filter((method) =>
      isProvisionalAssertion({ ...HUMAN_ASSERTION, method, status: 'validated' }),
    );
    expect(validated).toEqual(['presumed']);
    expect(isProvisionalAssertion({ ...HUMAN_ASSERTION, method: 'human' })).toBe(false);
    expect(isProvisionalAssertion({ ...HUMAN_ASSERTION, method: 'estimated' })).toBe(false);
  });
});

describe('isProvisionalAssertion on a hostile value', () => {
  it('throws INVALID_INPUT, never a raw error', () => {
    const hostile = { ...HUMAN_ASSERTION };
    Object.defineProperty(hostile, 'status', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(specError(() => isProvisionalAssertion(hostile))).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'assertion could not be read: boom',
    });
  });
});

describe('computeAssertionDigest', () => {
  const FULL_SOURCE = { proofDigest: PROOF_DIGEST, output: 'risque', subject: '/foyers/@f1' };
  const full: FactAssertion = {
    by: 'ai-1',
    method: 'decision',
    at: '2026-01-02T08:00:00.000Z',
    status: 'proposed',
    basis: 'art. 4',
    evidenceDigest: 'a'.repeat(64),
    confidence: 0.8,
    complete: false,
    source: FULL_SOURCE,
  };

  it('is the sha256 of the canonical assertion', () => {
    expect(computeAssertionDigest(full)).toBe(sha256Hex(canonicalize(full)));
    expect(computeAssertionDigest(HUMAN_ASSERTION)).toBe(
      sha256Hex('{"at":"2026-01-02","by":"agent-7","method":"human","status":"validated"}'),
    );
  });

  it('does not depend on the order of keys', () => {
    const reversed: FactAssertion = {
      source: { subject: '/foyers/@f1', output: 'risque', proofDigest: PROOF_DIGEST },
      complete: false,
      confidence: 0.8,
      evidenceDigest: 'a'.repeat(64),
      basis: 'art. 4',
      status: 'proposed',
      at: '2026-01-02T08:00:00.000Z',
      method: 'decision',
      by: 'ai-1',
    };
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(full));
    expect(computeAssertionDigest(reversed)).toBe(computeAssertionDigest(full));
  });

  it('changes with any field', () => {
    const digest = computeAssertionDigest(full);
    const variants: FactAssertion[] = [
      { ...full, by: 'ai-2' },
      { ...full, status: 'validated' },
      { ...full, confidence: 0.81 },
      {
        by: 'ai-1',
        method: 'decision',
        at: '2026-01-02T08:00:00.000Z',
        status: 'proposed',
        basis: 'art. 4',
        evidenceDigest: 'a'.repeat(64),
        confidence: 0.8,
        source: FULL_SOURCE,
      },
      { ...full, source: { ...FULL_SOURCE, output: 'autre' } },
    ];
    for (const variant of variants) expect(computeAssertionDigest(variant)).not.toBe(digest);
  });

  it('throws INVALID_INPUT, naming the first problem, for an invalid assertion', () => {
    const invalid = { ...HUMAN_ASSERTION, method: 'robot' } as unknown as FactAssertion;
    expect(specError(() => computeAssertionDigest(invalid))).toMatchObject({
      code: 'INVALID_INPUT',
      message: `invalid assertion: /method must be one of ${METHODS.join(', ')}`,
    });
  });

  it('throws INVALID_INPUT, never a raw error, for a getter that throws', () => {
    const hostile = { ...HUMAN_ASSERTION };
    Object.defineProperty(hostile, 'by', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(specError(() => computeAssertionDigest(hostile))).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'invalid assertion: /by could not be read: boom',
    });
  });
});
