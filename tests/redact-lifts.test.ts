import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  PROOF_SECTIONS,
  redactProof,
  sealProof,
  signProof,
  validateProof,
  verifyProof,
} from '../src/index.js';
import type {
  DecisionProof,
  ProofSection,
  RuleDefinitionInput,
  UnsaltedProof,
} from '../src/index.js';
import { fromHex } from './hashing.js';
import { handSealed } from './helpers.js';
import { withEntry } from './proof-builders.js';
import type { Content, Entry } from './proof-builders.js';
import { RFC_SECRET, ruleA, TRUSTED, unsalted, unsigned } from './proof-cases.js';
import { traceProof } from './proof-trace.js';
import type { Trace } from './proof-trace.js';

// A redacted entry's preimage is never checkable (D-16): any content may be behind its hash. A
// check that such an entry could satisfy is lifted, and a proof with a redacted entry never gets
// the full verdict: `authentic-redacted` or `consistent-redacted`, naming each lifted check.

/** The secret seed of the redaction tests. */
const SEED = fromHex('f9b972f50267915261e884526c8553bdf4a353eb2e4e9e78ee65716aeceaacfb');

/** A leaf hash no entry of these proofs has: a marker made up by a forger. */
const FAKE = (n: number): { redacted: string } => ({ redacted: n.toString(16).padStart(64, 'e') });

/** `content` with a made-up marker in each of `sections`, sealed by hand as salted. */
function forged(content: Content, ...sections: ProofSection[]): DecisionProof {
  const record: Record<string, unknown> = { ...content, inputSalted: true };
  sections.forEach((section, n) => {
    record[section] = [...(record[section] as unknown[]), FAKE(n + 1)];
  });
  return handSealed(record) as unknown as DecisionProof;
}

/** `p` signed by the trusted test key. */
const signed = (p: DecisionProof): DecisionProof => signProof(p, RFC_SECRET, 'executor-1');

const verified = (p: DecisionProof, options: object = {}) =>
  verifyProof(p, { trustedKeys: TRUSTED, ...options });

/** The notice naming a lifted check. */
const liftNotice = (check: string, ...sections: ProofSection[]): string =>
  `check lifted: ${check} (${sections.join(', ')} redacted)`;

/** The five forgeries of the review of 9K1: each hides a contradiction behind one fake marker. */
const FORGERIES: {
  name: string;
  trace: Trace;
  section: ProofSection;
  message: string;
  check: string;
}[] = [
  {
    name: 'an output value 999 that its one visible step (1) does not give, marker in applied',
    trace: {
      output: { type: 'number', combine: 'sum', value: 999, contributors: ['A'] },
      rules: [{ id: 'A' }],
      steps: [{ ruleId: 'A', contribution: 1 }],
    },
    section: 'applied',
    message: 'output value does not follow from its contributions: value',
    check: 'output value from its contributions',
  },
  {
    name: 'a provisional status without a source, marker in factsRead',
    trace: {
      output: {
        type: 'number',
        combine: 'sum',
        value: 1,
        contributors: ['A'],
        status: 'provisional',
      },
      rules: [{ id: 'A' }],
      steps: [{ ruleId: 'A', contribution: 1, status: 'provisional' }],
    },
    section: 'factsRead',
    message: 'provisional status without a source in the proof',
    check: 'provisional status has a source',
  },
  {
    name: 'an exclusion INHIBITED without an exception, marker in exceptions',
    trace: {
      output: { type: 'number', combine: 'sum', value: 0 },
      rules: [{ id: 'A' }],
      skipped: [{ ruleId: 'A', output: 'value', reason: 'INHIBITED' }],
    },
    section: 'exceptions',
    message: 'inhibited without an exception: A@1',
    check: 'exclusion with its exception',
  },
  {
    name: 'a listed rule nothing decides, marker in applied',
    trace: {
      output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'] },
      rules: [{ id: 'A' }, { id: 'B' }],
      steps: [{ ruleId: 'A', contribution: 1 }],
    },
    section: 'applied',
    message: 'rule not decided: B@1',
    check: 'every listed rule decided',
  },
  {
    name: 'a PENDING_CARRIER entry whose carrier no entry is, marker in pending',
    trace: {
      output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T'] },
      rules: [{ id: 'T' }],
      pending: [
        {
          ruleId: 'T',
          output: 'value',
          reason: 'PENDING_CARRIER',
          detail: 'x',
          carrier: { ruleId: 'Z', version: 1 },
        },
      ],
    },
    section: 'pending',
    message: 'pending carrier without a pending carrier: T@1',
    check: 'pending carrier chain',
  },
];

describe('a fake marker never buys the full verdict (review of 9K1, I1)', () => {
  for (const forgery of FORGERIES) {
    it(forgery.name, () => {
      const content = traceProof(forgery.trace);
      // Without a marker, the contradiction is reported.
      expect(verified(handSealed({ ...content, inputSalted: true }) as never).issues).toContain(
        forgery.message,
      );
      const proof = signed(forged(content, forgery.section));
      const result = verified(proof);
      expect(result.status).toBe('authentic-redacted');
      expect(result.issues).not.toContain(forgery.message);
      expect(result.issues).toContain(liftNotice(forgery.check, forgery.section));
      expect(result.lifted).toContainEqual({ check: forgery.check, redacted: [forgery.section] });
      expect(result.redacted).toBe(1);
      // Unsigned: consistent, redacted, the same check named.
      const bare = verifyProof(forged(content, forgery.section));
      expect(bare.status).toBe('consistent-redacted');
      expect(bare.lifted).toContainEqual({ check: forgery.check, redacted: [forgery.section] });
    });
  }

  it('an honest redaction of a signed proof is authentic-redacted, lifting nothing', () => {
    const sealed = sealProof({ ...unsalted(unsigned()), inputSalted: true } as UnsaltedProof, SEED);
    const proof = signed(sealed);
    expect(verified(proof)).toEqual({ status: 'authentic', issues: [] });
    const redacted = redactProof(proof, (section, i) => section === 'factsRead' && i === 0);
    expect(verified(redacted)).toEqual({
      status: 'authentic-redacted',
      issues: ['redacted entries: 1'],
      redacted: 1,
      lifted: [],
    });
    expect(verifyProof(redacted)).toEqual({
      status: 'consistent-redacted',
      issues: ['redacted entries: 1', 'untrusted key'],
      redacted: 1,
      lifted: [],
    });
  });
});

/** A rule `id` of `ruleA`'s model and priority, with `extra`. */
const rule = (id: string, extra: Partial<RuleDefinitionInput> = {}): RuleDefinitionInput => ({
  ...ruleA,
  id,
  ...extra,
});

/** `trace` whose rules carry the checksums of `definitions` (priority 1, as `ruleA`). */
function withDefinitions(trace: Trace, definitions: RuleDefinitionInput[]): Content {
  const content = traceProof({
    ...trace,
    rules: trace.rules.map((r) => ({ ...r, priority: r.priority ?? 1 })),
  });
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const rules = (content.rules as Entry[]).map((ref) => ({
    ...ref,
    checksum: computeRuleChecksum(byId.get(String(ref.id))!),
  }));
  return { ...content, rules };
}

/**
 * Each lift site of the review of 9K1 (I3): a redaction of a section the check does not read
 * lifts nothing, and the check still fires.
 */
const SITES: {
  site: string;
  content: () => Content;
  unrelated: ProofSection;
  message: string;
  options?: object;
}[] = [
  {
    site: 'combination: the output value from its contributions',
    content: () => traceProof(FORGERIES[0]!.trace),
    unrelated: 'factsRead',
    message: 'output value does not follow from its contributions: value',
  },
  {
    site: 'consistency: a cited output listed',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'] },
        rules: [{ id: 'A' }],
        steps: [{ ruleId: 'A', contribution: 1 }],
        skipped: [{ ruleId: 'A', subject: '/x', output: 'ghost', reason: 'CONDITION_FALSE' }],
      }),
    unrelated: 'rules',
    message: 'cited output not listed: ghost',
  },
  {
    site: 'effects: every listed rule decided',
    content: () => traceProof(FORGERIES[3]!.trace),
    unrelated: 'factsRead',
    message: 'rule not decided: B@1',
  },
  {
    site: 'effects: the decisions of a fired carrier',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'] },
        rules: [{ id: 'A' }, { id: 'X' }],
        steps: [{ ruleId: 'A', contribution: 1 }],
        exceptions: [{ ruleId: 'X', kind: 'inhibit', affected: [{ ruleId: 'A' }] }],
      }),
    unrelated: 'pending',
    message: 'inhibited rule applied: A@1',
  },
  {
    site: 'effects: an exclusion with its exception',
    content: () => traceProof(FORGERIES[2]!.trace),
    unrelated: 'skipped',
    message: 'inhibited without an exception: A@1',
  },
  {
    site: 'completeness: a settled output without pending rules',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'], pending: ['B'] },
        rules: [{ id: 'A' }, { id: 'B' }],
        steps: [{ ruleId: 'A', contribution: 1 }],
        pending: [{ ruleId: 'B', output: 'value', reason: 'UNDETERMINED', detail: 'x' }],
      }),
    unrelated: 'factsRead',
    message: 'settled output with pending rules: value',
  },
  {
    site: 'completeness: a status no stronger than its causes',
    content: () =>
      traceProof({
        output: {
          type: 'number',
          combine: 'sum',
          value: 1,
          contributors: ['A'],
          status: 'conflict',
        },
        rules: [{ id: 'A' }, { id: 'X' }, { id: 'X2' }],
        steps: [{ ruleId: 'A', contribution: 1 }],
        skipped: [{ ruleId: 'X2', reason: 'RULE_CONFLICT', status: 'conflict' }],
        exceptions: [
          { ruleId: 'X2', kind: 'shortCircuit', output: 'other', affected: [], status: 'conflict' },
        ],
        outputs: [
          {
            name: 'other',
            type: 'number',
            combine: 'sum',
            status: 'undetermined',
            contributors: [],
            pending: ['X'],
          },
        ],
        pending: [{ ruleId: 'X', output: 'other', reason: 'UNDETERMINED', detail: 'x' }],
      }),
    unrelated: 'pending',
    message: 'output status stronger than its causes: value',
  },
  {
    site: 'statuses: the items of a per collection',
    content: () =>
      traceProof({
        output: { type: 'decimal', combine: 'sum', per: '/e', status: 'determined' },
        rules: [{ id: 'A' }],
        skipped: [{ ruleId: 'A', output: 'value', reason: 'CONDITION_FALSE' }],
      }),
    unrelated: 'factsRead',
    message: 'exclusion feeds no item: A@1',
  },
  {
    site: 'carrier-rules: the exception records of a carrier against its definition',
    content: () =>
      withDefinitions(
        {
          output: { type: 'number', combine: 'sum', value: 0, contributors: ['Y'] },
          rules: [{ id: 'Y' }],
          steps: [{ ruleId: 'Y', contribution: 0 }],
          exceptions: [],
        },
        [rule('Y', { exceptions: [{ kind: 'inhibit', targets: { ids: ['Z'] } }] })],
      ),
    unrelated: 'factsRead',
    message: 'carrier exceptions differ from its definition: Y@1',
    options: { rules: [rule('Y', { exceptions: [{ kind: 'inhibit', targets: { ids: ['Z'] } }] })] },
  },
  {
    site: 'output-values: the form of a count',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'count', value: 1, contributors: ['A'] },
        rules: [{ id: 'A' }],
        steps: [{ ruleId: 'A', contribution: 1 }],
      }),
    unrelated: 'factsRead',
    message: 'contribution does not match its output declaration: value',
  },
  {
    site: 'placement: a stratum output listed',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 0 },
        rules: [],
        strata: [['ghost', 'value']],
      }),
    unrelated: 'rules',
    message: 'stratum output unknown: ghost',
  },
  {
    site: 'verify: a given rule the proof does not show, with no rule redacted',
    content: () =>
      withDefinitions(
        {
          output: { type: 'number', combine: 'sum', value: 1, contributors: ['r1'] },
          rules: [{ id: 'r1' }],
          steps: [{ ruleId: 'r1', contribution: 1 }],
        },
        [rule('r1')],
      ),
    unrelated: 'factsRead',
    message: 'unexpected rule: r9@1',
    options: { rules: [rule('r1'), rule('r9')] },
  },
];

describe('a redaction of a section a check does not read lifts nothing (review of 9K1, I3)', () => {
  for (const { site, content, unrelated, message, options } of SITES) {
    it(site, () => {
      const plain = handSealed({ ...content(), inputSalted: true }) as unknown as DecisionProof;
      expect(verifyProof(plain, options).issues).toContain(message);
      const result = verifyProof(forged(content(), unrelated), options);
      expect(result.status).toBe('invalid');
      expect(result.issues).toContain(message);
    });
  }
});

describe('the length of each section is committed (review of 9K1, I2)', () => {
  const salty = (): DecisionProof =>
    sealProof({ ...unsalted(unsigned()), inputSalted: true } as UnsaltedProof, SEED);

  it('a marker moved to the next section keeps the leaves, and is refused', () => {
    const proof = salty();
    const record = proof as unknown as Record<ProofSection, unknown[]>;
    // The last section with entries, and the next one, empty: the leaves stay in order.
    const last = [...PROOF_SECTIONS].reverse().find((section) => record[section].length > 0)!;
    const next = PROOF_SECTIONS[PROOF_SECTIONS.indexOf(last) + 1]!;
    expect(record[next]).toEqual([]);
    const index = record[last].length - 1;
    const redacted = redactProof(proof, (section, i) => section === last && i === index);
    const marker = (redacted as unknown as Record<ProofSection, unknown[]>)[last][index];
    const moved = {
      ...redacted,
      [last]: record[last].slice(0, index).map((_, i) => (redacted as never)[last][i]),
      [next]: [marker],
    };
    const result = verifyProof(moved);
    expect(result.status).toBe('invalid');
    expect(result.issues).toContain(`counts.${next} is 0, ${next} has 1 entry`);
    expect(validateProof(moved).issues.map((issue) => issue.message)).toEqual([
      `counts.${last} is ${index + 1}, ${last} has ${index} entries`,
      `counts.${next} is 0, ${next} has 1 entry`,
    ]);
  });
});

describe('a message cites the place of an entry in the proof, redacted ones counted (M2)', () => {
  it('an invalid visible entry after a redacted one in the same section', () => {
    const content = traceProof({
      output: { type: 'number', combine: 'sum', value: 3, contributors: ['A', 'B'] },
      rules: [{ id: 'A' }, { id: 'B' }],
      steps: [
        { ruleId: 'A', contribution: 1 },
        { ruleId: 'B', contribution: 2 },
      ],
    });
    // A third step out of order, after B: `applied not sorted at 2` in the proof.
    const applied = content.applied as Entry[];
    const unsorted = {
      ...content,
      applied: [...applied, { ...applied[0]!, salt: 'f'.repeat(32) }],
    };
    const sealed = handSealed({ ...unsorted, inputSalted: true }) as unknown as DecisionProof;
    expect(verifyProof(sealed).issues).toContain('applied not sorted at 2');
    // applied[0] redacted: the view holds B then the stray A, at 1 in the view, at 2 in the proof.
    const redacted = redactProof(sealed, (section, i) => section === 'applied' && i === 0);
    const issues = verifyProof(redacted).issues;
    expect(issues).toContain('applied not sorted at 2');
    expect(issues).not.toContain('applied not sorted at 1');
  });
});

/**
 * Every lift, both ways (review of 9K1, I3): a made-up marker in a section the check reads lifts
 * it and names it; one in a section it does not read lifts nothing.
 */
const LIFT_CASES: {
  check: string;
  content: () => Content;
  message: string;
  lifting: ProofSection;
  unrelated: ProofSection;
  options?: object;
}[] = [
  {
    check: 'undetermined output has a cause',
    content: () =>
      traceProof({ output: { type: 'number', combine: 'sum', status: 'undetermined' }, rules: [] }),
    message: 'undetermined output without a cause: value',
    lifting: 'pending',
    unrelated: 'factsRead',
  },
  {
    check: 'settled output without pending rules',
    content: () => SITES[5]!.content(),
    message: 'settled output with pending rules: value',
    lifting: 'rules',
    unrelated: 'factsRead',
  },
  {
    check: 'rank within the instances',
    content: () =>
      traceProof({
        output: {
          type: 'number',
          combine: 'highestPriority',
          value: 1,
          contributors: ['A'],
          selected: { ruleId: 'A', subject: '/e/@1' },
        },
        rules: [{ id: 'A' }],
        steps: [{ ruleId: 'A', subject: '/e/@1', contribution: 1, rank: 1 }],
      }),
    message: 'rank out of range: A@1 at /e/@1',
    lifting: 'applied',
    unrelated: 'factsRead',
  },
  {
    check: 'requested outputs listed',
    content: () => ({
      ...traceProof({ output: { type: 'number', combine: 'sum', value: 0 }, rules: [] }),
      requested: ['ghost', 'value'],
    }),
    message: 'requested output absent: ghost',
    lifting: 'outputs',
    unrelated: 'rules',
  },
  {
    check: 'decisions of a fired carrier',
    content: () => SITES[3]!.content(),
    message: 'inhibited rule applied: A@1',
    lifting: 'skipped',
    unrelated: 'pending',
  },
  {
    check: 'rules an exception affected',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 0 },
        rules: [{ id: 'A' }, { id: 'X' }],
        skipped: [{ ruleId: 'A', output: 'value', reason: 'CONDITION_FALSE' }],
        exceptions: [{ ruleId: 'X', kind: 'inhibit', affected: [{ ruleId: 'A' }] }],
      }),
    message: 'affected rule not inhibited by X@1: A',
    lifting: 'pending',
    unrelated: 'factsRead',
  },
  {
    check: 'form of a count',
    content: () => SITES[9]!.content(),
    message: 'contribution does not match its output declaration: value',
    lifting: 'exceptions',
    unrelated: 'factsRead',
  },
  {
    check: 'items of their collection',
    content: () => SITES[7]!.content(),
    message: 'exclusion feeds no item: A@1',
    lifting: 'items',
    unrelated: 'factsRead',
  },
  {
    check: 'per output against its items',
    content: () => withEntry('outputs', 0, { status: 'provisional' }),
    message: 'per output status differs from its items: kids',
    lifting: 'items',
    unrelated: 'missingFacts',
  },
  {
    check: 'pending carrier fired with its exceptions',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['X'] },
        rules: [{ id: 'X' }],
        pending: [
          { ruleId: 'X', output: 'value', reason: 'UNDETERMINED', detail: 'x', fired: true },
        ],
      }),
    message: 'pending carrier fired without its exceptions: X@1',
    lifting: 'exceptions',
    unrelated: 'factsRead',
  },
  {
    check: 'carrier exception records against definitions',
    content: () => SITES[8]!.content(),
    message: 'carrier exceptions differ from its definition: Y@1',
    lifting: 'exceptions',
    unrelated: 'factsRead',
    ...(SITES[8]!.options === undefined ? {} : { options: SITES[8]!.options }),
  },
  {
    check: 'short circuit with its carrier applied',
    // X, pending on `other` though it fired, short-circuits `value`: no step of X imposes it.
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 0 },
        outputs: [
          {
            name: 'other',
            type: 'number',
            combine: 'sum',
            status: 'undetermined',
            contributors: [],
            pending: ['X'],
          },
        ],
        rules: [{ id: 'A' }, { id: 'X', priority: 5 }],
        skipped: [{ ruleId: 'A', output: 'value', reason: 'SHORT_CIRCUITED' }],
        pending: [
          { ruleId: 'X', output: 'other', reason: 'UNDETERMINED', detail: 'x', fired: true },
        ],
        exceptions: [
          { ruleId: 'X', kind: 'shortCircuit', output: 'value', affected: [{ ruleId: 'A' }] },
        ],
      }),
    message: 'short circuit without its carrier applied: X@1',
    lifting: 'applied',
    unrelated: 'factsRead',
  },
  {
    check: 'decisions against the exceptions',
    // Y short-circuits `value` with its own step and applies on `other`: the imposed step is
    // the effect of the exception, not a second decision of Y; without it, Y decides twice.
    content: () => {
      const content = traceProof({
        output: { type: 'number', combine: 'sum', value: 9, contributors: ['Y'] },
        outputs: [
          {
            name: 'other',
            type: 'number',
            combine: 'sum',
            status: 'determined',
            value: 1,
            contributors: ['Y'],
            pending: [],
          },
        ],
        rules: [{ id: 'Y', priority: 9 }],
        steps: [
          { ruleId: 'Y', contribution: 1, output: 'other' },
          { ruleId: 'Y', contribution: 9 },
        ],
        exceptions: [{ ruleId: 'Y', kind: 'shortCircuit', output: 'value', affected: [] }],
      });
      return { ...content, exceptions: [] };
    },
    message: 'rule decided twice: Y@1',
    lifting: 'exceptions',
    unrelated: 'factsRead',
  },
];

describe('each lift, both ways (review of 9K1, I3)', () => {
  for (const { check, content, message, lifting, unrelated, options } of LIFT_CASES) {
    it(check, () => {
      const plain = verifyProof(handSealed({ ...content(), inputSalted: true }) as never, options);
      expect(plain.issues).toContain(message);
      const elsewhere = verifyProof(forged(content(), unrelated), options);
      expect(elsewhere.issues).toContain(message);
      expect(elsewhere.lifted?.map((lift) => lift.check)).not.toContain(check);
      const lifted = verifyProof(forged(content(), lifting), options);
      expect(lifted.issues).not.toContain(message);
      expect(lifted.lifted?.map((lift) => lift.check)).toContain(check);
    });
  }

  it('a section a check reads, redacted, names the check only when it found a problem', () => {
    // A marker in exceptions of a proof the exceptions explain nothing in: nothing is lifted.
    const honest = traceProof({
      ...FORGERIES[0]!.trace,
      output: { ...FORGERIES[0]!.trace.output, value: 1 },
    });
    expect(verifyProof(handSealed({ ...honest, inputSalted: true }) as never).issues).toEqual([
      'unsigned',
    ]);
    const result = verifyProof(forged(honest, 'exceptions'));
    expect(result.lifted).toEqual([]);
  });
});

/** `content` with `n` made-up markers in `section`, sealed by hand as salted. */
function forgedMany(content: Content, section: ProofSection, n: number): DecisionProof {
  return forged(content, ...Array.from({ length: n }, () => section));
}

/**
 * The bounded checks (review of 9K1, N1): one redacted entry explains at most one problem. Each
 * case has two problems: one marker lifts neither, both are reported; two markers lift both.
 */
/** A second output `other` of the trace, settled unless `extra` says otherwise. */
const other = (extra: Entry): Entry => ({
  name: 'other',
  type: 'number',
  combine: 'sum',
  status: 'determined',
  contributors: [],
  pending: [],
  ...extra,
});

/** A provisional per output `name` over `per`. */
const perOutput = (name: string, per: string): Entry => ({
  name,
  type: 'decimal',
  combine: 'sum',
  per,
  status: 'provisional',
  contributors: [],
  pending: [],
});

/** Carriers Y and Y2 whose definitions inhibit Z, with no exception recorded. */
const CARRIERS = [
  rule('Y', { exceptions: [{ kind: 'inhibit', targets: { ids: ['Z'] } }] }),
  rule('Y2', { exceptions: [{ kind: 'inhibit', targets: { ids: ['Z'] } }] }),
];

const BOUNDED: {
  check: string;
  content: () => Content;
  sections: ProofSection[];
  messages: string[];
  options?: object;
}[] = [
  {
    check: 'every listed rule decided',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'] },
        rules: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
        steps: [{ ruleId: 'A', contribution: 1 }],
      }),
    sections: ['applied', 'skipped', 'pending', 'exceptions'],
    messages: ['rule not decided: B@1', 'rule not decided: C@1'],
  },
  {
    check: 'cited rules listed',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 1, contributors: ['A', 'W', 'Z'] },
        rules: [{ id: 'A' }],
        steps: [{ ruleId: 'A', contribution: 1 }],
      }),
    sections: ['rules'],
    messages: ['cited rule not listed: W', 'cited rule not listed: Z'],
  },
  {
    check: 'cited outputs listed',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 0 },
        rules: [{ id: 'A' }],
        skipped: [
          { ruleId: 'A', subject: '/x', output: 'ghost', reason: 'CONDITION_FALSE' },
          { ruleId: 'A', subject: '/y', output: 'spirit', reason: 'CONDITION_FALSE' },
        ],
      }),
    sections: ['outputs'],
    messages: ['cited output not listed: ghost', 'cited output not listed: spirit'],
  },
  {
    check: 'stratum outputs listed',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 0 },
        rules: [],
        strata: [['ghost', 'spirit', 'value']],
      }),
    sections: ['outputs'],
    messages: ['stratum output unknown: ghost', 'stratum output unknown: spirit'],
  },
  {
    check: 'requested outputs listed',
    content: () => ({
      ...traceProof({ output: { type: 'number', combine: 'sum', value: 0 }, rules: [] }),
      requested: ['ghost', 'spirit', 'value'],
    }),
    sections: ['outputs'],
    messages: ['requested output absent: ghost', 'requested output absent: spirit'],
  },
  {
    check: 'output value from its contributions',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 999, contributors: ['A'] },
        outputs: [
          {
            name: 'other',
            type: 'number',
            combine: 'sum',
            status: 'determined',
            value: 999,
            contributors: ['B'],
            pending: [],
          },
        ],
        rules: [{ id: 'A' }, { id: 'B' }],
        steps: [
          { ruleId: 'A', contribution: 1 },
          { ruleId: 'B', contribution: 1, output: 'other' },
        ],
      }),
    sections: ['applied'],
    messages: [
      'output value does not follow from its contributions: other',
      'output value does not follow from its contributions: value',
    ],
  },
  {
    check: 'pending carrier fired with its exceptions',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['X', 'Y'] },
        rules: [{ id: 'X' }, { id: 'Y' }],
        pending: ['X', 'Y'].map((ruleId) => ({
          ruleId,
          output: 'value',
          reason: 'UNDETERMINED',
          detail: 'x',
          fired: true,
        })),
      }),
    sections: ['exceptions'],
    messages: [
      'pending carrier fired without its exceptions: X@1',
      'pending carrier fired without its exceptions: Y@1',
    ],
  },
  {
    check: 'settled output without pending rules',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'], pending: ['B'] },
        outputs: [other({ value: 1, contributors: ['C'], pending: ['D'] })],
        rules: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
        steps: [
          { ruleId: 'A', contribution: 1 },
          { ruleId: 'C', contribution: 1, output: 'other' },
        ],
        pending: [
          { ruleId: 'B', output: 'value', reason: 'UNDETERMINED', detail: 'x' },
          { ruleId: 'D', output: 'other', reason: 'UNDETERMINED', detail: 'x' },
        ],
      }),
    sections: ['applied'],
    messages: [
      'settled output with pending rules: other',
      'settled output with pending rules: value',
    ],
  },
  {
    check: 'output status no stronger than its causes',
    content: () =>
      traceProof({
        output: {
          type: 'number',
          combine: 'sum',
          value: 1,
          contributors: ['A'],
          status: 'conflict',
        },
        outputs: [other({ value: 1, contributors: ['B'], status: 'conflict' })],
        rules: [{ id: 'A' }, { id: 'B' }],
        steps: [
          { ruleId: 'A', contribution: 1 },
          { ruleId: 'B', contribution: 1, output: 'other' },
        ],
      }),
    sections: ['applied'],
    messages: [
      'output status stronger than its causes: other',
      'output status stronger than its causes: value',
    ],
  },
  {
    check: 'form of a count',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'count', value: 1, contributors: ['A'] },
        outputs: [other({ combine: 'count', value: 1, contributors: ['B'] })],
        rules: [{ id: 'A' }, { id: 'B' }],
        steps: [
          { ruleId: 'A', contribution: 1 },
          { ruleId: 'B', contribution: 1, output: 'other' },
        ],
      }),
    sections: ['exceptions'],
    messages: [
      'contribution does not match its output declaration: other',
      'contribution does not match its output declaration: value',
    ],
  },
  {
    check: 'per output against its items',
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 0 },
        outputs: [perOutput('kids', '/e'), perOutput('pets', '/p')],
        rules: [{ id: 'A' }, { id: 'B' }],
        steps: [
          { ruleId: 'A', contribution: '1', output: 'kids', subject: '/e/@1' },
          { ruleId: 'B', contribution: '1', output: 'pets', subject: '/p/@1' },
        ],
        items: [
          {
            output: 'kids',
            subject: '/e/@1',
            status: 'determined',
            value: '1',
            contributors: ['A'],
            pending: [],
          },
          {
            output: 'pets',
            subject: '/p/@1',
            status: 'determined',
            value: '1',
            contributors: ['B'],
            pending: [],
          },
        ],
      }),
    sections: ['items'],
    messages: [
      'per output status differs from its items: kids',
      'per output status differs from its items: pets',
    ],
  },
  {
    check: 'short circuit with its carrier applied',
    // X and Y, pending on `third` though they fired, short-circuit `value` and `other`.
    content: () =>
      traceProof({
        output: { type: 'number', combine: 'sum', value: 0 },
        outputs: [
          other({ value: 0 }),
          other({ name: 'third', status: 'undetermined', pending: ['X', 'Y'] }),
        ],
        rules: [{ id: 'A' }, { id: 'B' }, { id: 'X', priority: 5 }, { id: 'Y', priority: 5 }],
        skipped: [
          { ruleId: 'A', output: 'value', reason: 'SHORT_CIRCUITED' },
          { ruleId: 'B', output: 'other', reason: 'SHORT_CIRCUITED' },
        ],
        pending: [
          { ruleId: 'X', output: 'third', reason: 'UNDETERMINED', detail: 'x', fired: true },
          { ruleId: 'Y', output: 'third', reason: 'UNDETERMINED', detail: 'x', fired: true },
        ],
        exceptions: [
          { ruleId: 'X', kind: 'shortCircuit', output: 'value', affected: [{ ruleId: 'A' }] },
          { ruleId: 'Y', kind: 'shortCircuit', output: 'other', affected: [{ ruleId: 'B' }] },
        ],
      }),
    sections: ['applied'],
    messages: [
      'short circuit without its carrier applied: X@1',
      'short circuit without its carrier applied: Y@1',
    ],
  },
  {
    // Found with the rules given: `verifyProof` reports what overran past its own checks.
    check: 'carrier exception records against definitions',
    content: () =>
      withDefinitions(
        {
          output: { type: 'number', combine: 'sum', value: 0, contributors: ['Y', 'Y2'] },
          rules: [{ id: 'Y' }, { id: 'Y2' }],
          steps: [
            { ruleId: 'Y', contribution: 0 },
            { ruleId: 'Y2', contribution: 0 },
          ],
          exceptions: [],
        },
        CARRIERS,
      ),
    sections: ['skipped', 'exceptions'],
    messages: [
      'carrier exceptions differ from its definition: Y@1',
      'carrier exceptions differ from its definition: Y2@1',
    ],
    options: { rules: CARRIERS },
  },
];

describe('a bounded check lifts no more problems than entries redacted (review of 9K1, N1)', () => {
  for (const { check, content, sections, messages, options } of BOUNDED) {
    it.each(sections)(`${check}: markers of %s`, (section) => {
      const plain = verifyProof(handSealed({ ...content(), inputSalted: true }) as never, options);
      for (const message of messages) expect(plain.issues).toContain(message);
      // One marker, two problems: each reported once, the check not lifted.
      const one = verifyProof(forgedMany(content(), section, 1), options);
      expect(one.status).toBe('invalid');
      const reported = one.issues.filter((issue) => messages.includes(issue));
      expect([...reported].sort()).toEqual([...messages].sort());
      expect(one.lifted?.map((lift) => lift.check)).not.toContain(check);
      // Two markers: both lifted.
      const two = verifyProof(forgedMany(content(), section, 2), options);
      for (const message of messages) expect(two.issues).not.toContain(message);
      expect(two.lifted?.map((lift) => lift.check)).toContain(check);
    });
    if (sections.length < 2) continue;
    it(`${check}: the markers of its sections add up`, () => {
      const proof = forged(content(), sections[0]!, sections[1]!);
      const result = verifyProof(proof, options);
      for (const message of messages) expect(result.issues).not.toContain(message);
      expect(result.lifted?.map((lift) => lift.check)).toContain(check);
    });
  }

  it('the problems of one target are one: one step marker lifts them all', () => {
    const content = traceProof({
      output: { type: 'number', combine: 'sum', value: 999, contributors: ['A', 'B'] },
      rules: [{ id: 'A' }, { id: 'B' }],
      steps: [{ ruleId: 'A', contribution: 1 }],
      skipped: [{ ruleId: 'B', output: 'value', reason: 'CONDITION_FALSE' }],
    });
    const plain = verifyProof(handSealed({ ...content, inputSalted: true }) as never).issues;
    const messages = [
      'contributors differ from applied steps: value',
      'output value does not follow from its contributions: value',
    ];
    for (const message of messages) expect(plain).toContain(message);
    const one = verifyProof(forged(content, 'applied'));
    for (const message of messages) expect(one.issues).not.toContain(message);
    expect(one.lifted?.map((lift) => lift.check)).toContain('output value from its contributions');
  });

  it('a rule cited with and without its version is one rule: one marker lifts both', () => {
    const content = traceProof({
      output: { type: 'number', combine: 'sum', value: 1, contributors: ['Z'] },
      rules: [],
      steps: [{ ruleId: 'Z', contribution: 1 }],
    });
    const plain = verifyProof(handSealed({ ...content, inputSalted: true }) as never).issues;
    expect(plain).toContain('cited rule not listed: Z@1');
    expect(plain).toContain('cited rule not listed: Z');
    const one = verifyProof(forged(content, 'rules'));
    expect(one.issues.filter((issue) => issue.startsWith('cited rule not listed'))).toEqual([]);
    expect(one.lifted?.map((lift) => lift.check)).toContain('cited rules listed');
  });

  it('signProof refuses a proof whose bounded check overran', () => {
    const proof = forgedMany(BOUNDED[0]!.content(), 'pending', 1);
    expect(() => signProof(proof, RFC_SECRET, 'executor-1')).toThrow(
      'Cannot sign the proof: rule not decided: B@1',
    );
  });

  it('an unbounded check: a hidden rule may explain the value of every output it reaches', () => {
    // A highestPriority value follows from the standings, the priorities of `rules` (N3).
    const content = traceProof({
      output: {
        type: 'number',
        combine: 'highestPriority',
        value: 2,
        contributors: ['A'],
        selected: { ruleId: 'A' },
      },
      rules: [
        { id: 'A', priority: 7 },
        { id: 'B', priority: 1 },
      ],
      steps: [
        { ruleId: 'A', contribution: 2 },
        { ruleId: 'B', contribution: 1 },
      ],
    });
    const proof = sealProof({ ...unsalted(content), inputSalted: true } as UnsaltedProof, SEED);
    expect(verifyProof(proof).issues).toEqual(['unsigned']);
    const redacted = verifyProof(redactProof(proof, (s, i) => s === 'rules' && i === 0));
    expect(redacted.status).toBe('consistent-redacted');
    expect(redacted.lifted).toContainEqual({
      check: 'output value from its contributions',
      redacted: ['rules'],
    });
  });
});

describe('every section is counted (review of 9K1, N2)', () => {
  it.each([...PROOF_SECTIONS])('%s: one entry more than its count is refused', (section) => {
    const proof = sealProof({ ...unsalted(unsigned()), inputSalted: true } as UnsaltedProof, SEED);
    const record = proof as unknown as Record<string, unknown[]>;
    const length = record[section]!.length;
    const grown = { ...proof, [section]: [...record[section]!, FAKE(1)] };
    const entries = (n: number): string => `${n} ${n === 1 ? 'entry' : 'entries'}`;
    const message = `counts.${section} is ${length}, ${section} has ${entries(length + 1)}`;
    expect(validateProof(grown).issues).toEqual([{ path: `counts.${section}`, message }]);
    expect(verifyProof(grown)).toEqual({ status: 'invalid', issues: [message] });
  });
});
