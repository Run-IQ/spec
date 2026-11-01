import { describe, expect, it } from 'vitest';
import {
  computeRuleChecksum,
  merkleRoot,
  PROOF_SECTIONS,
  proofLeafHashes,
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
import { fromHex, hex } from './hashing.js';
import { handSealed, specError, withCounts } from './helpers.js';
import { outputProof } from './proof-builders.js';
import type { Content, Entry } from './proof-builders.js';
import { RFC_SECRET, ruleA, ruleB, sealed, TRUSTED, unsalted, unsigned } from './proof-cases.js';
import { traceProof } from './proof-trace.js';
import type { Trace } from './proof-trace.js';

const SEED = fromHex('f9b972f50267915261e884526c8553bdf4a353eb2e4e9e78ee65716aeceaacfb');

/** `content` sealed under a secret seed: its entries can be redacted (D-14). */
function salty(content: object): DecisionProof {
  return sealProof({ ...unsalted(content), inputSalted: true } as UnsaltedProof, SEED);
}

/** `p` signed by the test key. */
const signed = (p: DecisionProof): DecisionProof => signProof(p, RFC_SECRET, 'executor-1');

/** `p` with the entries `which` names (`section`, index) redacted. */
function hiding(p: DecisionProof, ...which: [ProofSection, number][]): DecisionProof {
  return redactProof(p, (section, index) => which.some(([s, i]) => s === section && i === index));
}

/** The issues of `p` other than `unsigned`, and whether it is invalid. */
function found(p: DecisionProof, options?: object): { invalid: boolean; issues: string[] } {
  const result = verifyProof(p, options);
  return {
    invalid: result.status === 'invalid',
    issues: result.issues.filter((issue) => issue !== 'unsigned'),
  };
}

const entriesOf = (p: DecisionProof, section: ProofSection): Record<string, unknown>[] =>
  (p as unknown as Record<ProofSection, Record<string, unknown>[]>)[section];

describe('redactProof: an entry becomes the hash of its leaf, the digest stays (D-16)', () => {
  it('hides applied[0] and outputs[0]: the root and the signature hold, redacted: 2', () => {
    const proof = signed(salty(unsigned()));
    const leaves = proofLeafHashes(proof);
    const redacted = hiding(proof, ['applied', 0], ['outputs', 0]);
    // Header, 2 rules, then outputs[0] at leaf 3, then applied[0] at leaf 4.
    expect(redacted.outputs[0]).toEqual({ redacted: hex(leaves[3]!) });
    expect(redacted.applied[0]).toEqual({ redacted: hex(leaves[4]!) });
    expect(proofLeafHashes(redacted).map(hex)).toEqual(leaves.map(hex));
    expect(hex(merkleRoot(proofLeafHashes(redacted)))).toBe(hex(merkleRoot(leaves)));
    expect(redacted.digest).toBe(proof.digest);
    expect(redacted.signature).toEqual(proof.signature);
    expect(validateProof(redacted).issues).toEqual([]);
    const result = verifyProof(redacted, { trustedKeys: TRUSTED });
    expect(result).toEqual({
      status: 'authentic-redacted',
      issues: [
        'redacted entries: 2',
        'check lifted: cited outputs listed (outputs redacted)',
        'check lifted: stratum outputs listed (outputs redacted)',
        'check lifted: every listed rule decided (applied redacted)',
      ],
      redacted: 2,
      lifted: [
        { check: 'cited outputs listed', redacted: ['outputs'] },
        { check: 'stratum outputs listed', redacted: ['outputs'] },
        { check: 'every listed rule decided', redacted: ['applied'] },
      ],
    });
    // The original is unchanged; nothing hidden gives no `redacted`.
    expect(proof.applied[0]).not.toHaveProperty('redacted');
    expect(verifyProof(proof, { trustedKeys: TRUSTED })).toEqual({
      status: 'authentic',
      issues: [],
    });
  });

  it('calls hide once per entry, in the order of the leaves, and keeps a redacted entry so', () => {
    const proof = salty(unsigned());
    const calls: string[] = [];
    const once = redactProof(proof, (section, index) => {
      calls.push(`${section}[${index}]`);
      return section === 'factsRead';
    });
    const expected = PROOF_SECTIONS.flatMap((section) =>
      entriesOf(proof, section).map((_, i) => `${section}[${i}]`),
    );
    expect(calls).toEqual(expected);
    const again: string[] = [];
    const twice = redactProof(once, (section, index) => {
      again.push(`${section}[${index}]`);
      return false;
    });
    expect(again).toEqual(expected.filter((call) => !call.startsWith('factsRead')));
    expect(twice).toEqual(once);
  });

  it('refuses an altered hash: digest mismatch', () => {
    const redacted = hiding(signed(salty(unsigned())), ['applied', 0]);
    const altered = { ...redacted, applied: [{ redacted: 'ab'.repeat(32) }] };
    const result = verifyProof(altered, { trustedKeys: TRUSTED });
    expect(result.status).toBe('invalid');
    expect(result.issues[0]).toBe('digest mismatch');
    expect(result.redacted).toBe(1);
    expect(specError(() => redactProof(altered, () => false))).toMatchObject({
      code: 'INVALID_PROOF',
      message: 'Cannot redact the proof: its digest does not match its content',
    });
  });

  it('refuses an unsalted proof: its entries could be found again (D-14)', () => {
    expect(specError(() => redactProof(sealed(), () => true))).toMatchObject({
      code: 'INVALID_DISCLOSURE',
      message: 'unsalted proof cannot be redacted',
    });
  });

  it('a redacted entry in an unsalted proof, made by hand: consistent at best', () => {
    const proof = signed(sealed());
    // The last leaf: factsRead[0] (missingFacts and readsUndeclared are empty).
    const leaf = proofLeafHashes(proof).at(-1)!;
    const forged = signed({ ...proof, factsRead: [{ redacted: hex(leaf) }] } as DecisionProof);
    expect(forged.digest).toBe(proof.digest);
    expect(verifyProof(forged, { trustedKeys: TRUSTED })).toEqual({
      status: 'consistent-redacted',
      issues: ['redacted entries: 1', 'redacted entries in an unsalted proof'],
      redacted: 1,
      lifted: [],
    });
  });
});

describe('what a redaction hides (pre-flight C5)', () => {
  /** R-art9-sante (priority 1) applied below A (priority 7) on a highestPriority output. */
  const art9 = (): Content => {
    const content = traceProof({
      output: {
        type: 'number',
        combine: 'highestPriority',
        value: 2,
        contributors: ['A'],
        selected: { ruleId: 'A' },
        status: 'provisional',
      },
      rules: [
        { id: 'A', priority: 7 },
        { id: 'R-art9-sante', priority: 1 },
      ],
      steps: [
        { ruleId: 'A', contribution: 2 },
        { ruleId: 'R-art9-sante', contribution: 1, status: 'provisional' },
      ],
    });
    content.readsUndeclared = [{ ruleId: 'R-art9-sante', version: 1, salt: 'a'.repeat(32) }];
    content.missingFacts = [{ path: '/sante/invalidite', salt: 'a'.repeat(32) }];
    return content;
  };

  it('hides the step, the rule, the undeclared reads and the missing fact of a rule', () => {
    const proof = salty(art9());
    expect(verifyProof(proof).issues).toEqual(['unsigned']);
    const text = JSON.stringify(proof);
    expect(text).toContain('R-art9-sante');
    expect(text).toContain('/sante/invalidite');
    const at = (section: ProofSection, id: string) =>
      entriesOf(proof, section).findIndex((e) => e.ruleId === id || e.id === id);
    const redacted = hiding(
      proof,
      ['rules', at('rules', 'R-art9-sante')],
      ['applied', at('applied', 'R-art9-sante')],
      ['readsUndeclared', 0],
      ['missingFacts', 0],
    );
    const hidden = JSON.stringify(redacted);
    expect(hidden).not.toContain('R-art9-sante');
    expect(hidden).not.toContain('art9');
    expect(hidden).not.toContain('/sante/invalidite');
    expect(hidden).not.toContain('sante');
    // The status of the output is no stronger than the step of R-art9-sante, now hidden.
    expect(verifyProof(redacted)).toEqual({
      status: 'consistent-redacted',
      issues: [
        'redacted entries: 4',
        'unsigned',
        'check lifted: output status no stronger than its causes (rules, applied redacted)',
        'check lifted: provisional status has a source (readsUndeclared redacted)',
      ],
      redacted: 4,
      lifted: [
        { check: 'output status no stronger than its causes', redacted: ['rules', 'applied'] },
        { check: 'provisional status has a source', redacted: ['readsUndeclared'] },
      ],
    });
  });
});

describe('checks on the entries left', () => {
  /** A sum of A (provisional) and B (determined), its output `status`, read under `provisional`. */
  const sum = (status: string): Trace => ({
    output: { type: 'number', combine: 'sum', value: 3, contributors: ['A', 'B'], status },
    rules: [{ id: 'A' }, { id: 'B' }],
    steps: [
      { ruleId: 'A', contribution: 1, status: 'provisional' },
      { ruleId: 'B', contribution: 2 },
    ],
    provisional: true,
  });

  it('output weaker than its contributions: hidden steps ignored, visible ones still read', () => {
    // An output determined though A is provisional: refused while A shows.
    const weak = { ...traceProof(sum('determined')), inputSalted: true };
    const resealed = handSealed(weak) as DecisionProof;
    expect(found(resealed).issues).toContain('output status weaker than its contributions: value');
    // B hidden, A shows: still refused.
    expect(found(hiding(resealed, ['applied', 1])).issues).toContain(
      'output status weaker than its contributions: value',
    );
    // A hidden: what is left does not contradict the output, B alone does not give its value.
    expect(found(hiding(resealed, ['applied', 0]))).toEqual({
      invalid: false,
      issues: [
        'redacted entries: 1',
        'check lifted: output value from its contributions (applied redacted)',
        'check lifted: every listed rule decided (applied redacted)',
      ],
    });
  });

  it('a visible output whose steps are all hidden is accepted', () => {
    const proof = signed(salty(traceProof(sum('provisional'))));
    expect(verifyProof(proof, { trustedKeys: TRUSTED })).toEqual({
      status: 'authentic',
      issues: [],
    });
    const redacted = hiding(proof, ['applied', 0], ['applied', 1]);
    const lifted = [
      { check: 'output value from its contributions', redacted: ['applied'] },
      { check: 'output status no stronger than its causes', redacted: ['applied'] },
      { check: 'every listed rule decided', redacted: ['applied'] },
    ];
    expect(verifyProof(redacted, { trustedKeys: TRUSTED })).toEqual({
      status: 'authentic-redacted',
      issues: [
        'redacted entries: 2',
        ...lifted.map(({ check }) => `check lifted: ${check} (applied redacted)`),
      ],
      redacted: 2,
      lifted,
    });
  });

  it('a citation of a redacted rule lifts the check, not a problem', () => {
    const proof = signed(salty(unsigned()));
    const redacted = hiding(proof, ['rules', 1]);
    expect(verifyProof(redacted, { trustedKeys: TRUSTED })).toEqual({
      status: 'authentic-redacted',
      issues: ['redacted entries: 1', 'check lifted: cited rules listed (rules redacted)'],
      redacted: 1,
      lifted: [{ check: 'cited rules listed', redacted: ['rules'] }],
    });
  });

  it('with no rule redacted, an unknown citation stays invalid', () => {
    const content: Content = { ...traceProof(sum('provisional')), inputSalted: true };
    const outputs = (content.outputs as Entry[]).map((o) => ({
      ...o,
      contributors: ['A', 'B', 'Z'],
    }));
    const forged = { ...content, outputs } as Content;
    const proof = handSealed(forged) as unknown as DecisionProof;
    const redacted = hiding(proof, ['factsRead', 0]);
    const result = found(redacted);
    expect(result.invalid).toBe(true);
    expect(result.issues).toContain('cited rule not listed: Z');
    expect(result.issues.some((issue) => issue.startsWith('check lifted: cited rules'))).toBe(
      false,
    );
  });

  it('hiding one item of a per output leaves the other items of that output visible (I19)', () => {
    const content = outputProof({ type: 'decimal', combine: 'sum', per: '/e' });
    content.items = ['/e/@1', '/e/@2'].map((subject) => ({
      salt: '',
      output: 'value',
      subject,
      status: 'determined',
      value: '0',
      contributors: [],
      pending: [],
    }));
    const proof = signed(salty(content));
    expect(verifyProof(proof, { trustedKeys: TRUSTED })).toEqual({
      status: 'authentic',
      issues: [],
    });
    const redacted = hiding(proof, ['items', 0]);
    expect(redacted.items[1]).toMatchObject({ output: 'value', subject: '/e/@2' });
    expect(verifyProof(redacted, { trustedKeys: TRUSTED })).toEqual({
      status: 'authentic-redacted',
      issues: ['redacted entries: 1'],
      redacted: 1,
      lifted: [],
    });
  });
});

describe('a status source may be redacted (carry of 9J)', () => {
  const sum = (status: string, provisional = false): Trace => ({
    output: { type: 'number', combine: 'sum', value: 1, contributors: ['A'], status },
    rules: [{ id: 'A' }],
    steps: [{ ruleId: 'A', contribution: 1, status }],
    provisional,
  });
  const PROVISIONAL = 'provisional status without a source in the proof';

  it('provisional: its only source, a provisional fact read, redacted → accepted', () => {
    const proof = signed(salty(traceProof(sum('provisional', true))));
    expect(verifyProof(proof, { trustedKeys: TRUSTED }).status).toBe('authentic');
    expect(verifyProof(hiding(proof, ['factsRead', 0]), { trustedKeys: TRUSTED })).toEqual({
      status: 'authentic-redacted',
      issues: [
        'redacted entries: 1',
        'check lifted: provisional status has a source (factsRead redacted)',
      ],
      redacted: 1,
      lifted: [{ check: 'provisional status has a source', redacted: ['factsRead'] }],
    });
  });

  it('provisional: its only source, undeclared reads, redacted → accepted', () => {
    const content = traceProof(sum('provisional'));
    content.readsUndeclared = [{ ruleId: 'A', version: 1 }];
    const proof = salty(content);
    expect(found(hiding(proof, ['readsUndeclared', 0]))).toEqual({
      invalid: false,
      issues: [
        'redacted entries: 1',
        'check lifted: provisional status has a source (readsUndeclared redacted)',
      ],
    });
  });

  it('provisional: no source and no redaction of a source section → refused', () => {
    const content = { ...traceProof(sum('provisional')), inputSalted: true };
    const proof = handSealed(content) as DecisionProof;
    expect(found(proof)).toEqual({ invalid: true, issues: [PROVISIONAL] });
    // A redaction elsewhere is no source.
    const redacted = found(hiding(proof, ['rules', 0]));
    expect(redacted.invalid).toBe(true);
    expect(redacted.issues).toContain(PROVISIONAL);
  });

  /** X and X2 (priority 5) short-circuit `value`: X2 excluded RULE_CONFLICT, recorded. */
  const tie: Trace = {
    output: { type: 'number', combine: 'sum', value: 9, contributors: ['X'], status: 'conflict' },
    rules: [{ id: 'A' }, { id: 'X', priority: 5 }, { id: 'X2', priority: 5 }],
    steps: [{ ruleId: 'X', contribution: 9, status: 'conflict' }],
    skipped: [
      { ruleId: 'A', output: 'value', reason: 'SHORT_CIRCUITED', status: 'conflict' },
      { ruleId: 'X2', reason: 'RULE_CONFLICT', status: 'conflict' },
    ],
    exceptions: [
      {
        ruleId: 'X',
        kind: 'shortCircuit',
        output: 'value',
        affected: [{ ruleId: 'A' }],
        status: 'conflict',
      },
      { ruleId: 'X2', kind: 'shortCircuit', output: 'value', affected: [], status: 'conflict' },
    ],
  };

  it('conflict: its only source, the RULE_CONFLICT exclusion, redacted → accepted', () => {
    const proof = salty(traceProof(tie));
    expect(found(proof)).toEqual({ invalid: false, issues: [] });
    const at = entriesOf(proof, 'skipped').findIndex((e) => e.reason === 'RULE_CONFLICT');
    expect(found(hiding(proof, ['skipped', at]))).toEqual({
      invalid: false,
      issues: [
        'redacted entries: 1',
        'check lifted: short circuit tie with its loser excluded (skipped redacted)',
        'check lifted: conflict status has a tie (skipped redacted)',
      ],
    });
  });

  it('conflict: no tie and no redaction of skipped → refused', () => {
    const content = { ...traceProof(sum('conflict')), inputSalted: true };
    const proof = handSealed(content) as DecisionProof;
    expect(found(proof).issues).toContain('conflict status without a tie in the proof');
    const redacted = found(hiding(proof, ['rules', 0]));
    expect(redacted.invalid).toBe(true);
    expect(redacted.issues).toContain('conflict status without a tie in the proof');
  });
});

describe('PENDING_CARRIER: a redacted pending entry may be a link or the root (carry of 9J)', () => {
  const of = (id: string): Entry => ({ ruleId: id, version: 1 });
  const root = { reason: 'UNDETERMINED', detail: 'missing /p', fired: false };
  /** T behind X behind Y, all pending on `value`. */
  const chain = (link = 'X'): Trace => ({
    output: { type: 'number', combine: 'sum', status: 'undetermined', pending: ['T', 'X', 'Y'] },
    rules: [{ id: 'T' }, { id: 'X' }, { id: 'Y' }],
    pending: [
      { ruleId: 'T', output: 'value', reason: 'PENDING_CARRIER', detail: 'x', carrier: of(link) },
      {
        ruleId: 'X',
        output: 'value',
        reason: 'PENDING_CARRIER',
        detail: 'x',
        carrier: of('Y'),
        fired: false,
      },
      { ruleId: 'Y', output: 'value', ...root },
    ],
  });
  const REFUSED = 'pending carrier without a pending carrier: T@1';

  it('honest: the link X or the root Y redacted → accepted', () => {
    const proof = salty(traceProof(chain()));
    expect(found(proof)).toEqual({ invalid: false, issues: [] });
    // The pending rules of the output, the decision of the hidden rule and the chain of T are
    // what the hidden entry may complete: each is named.
    const lifted = [
      'check lifted: pending rules of an output (pending redacted)',
      'check lifted: every listed rule decided (pending redacted)',
      'check lifted: pending carrier chain (pending redacted)',
    ];
    for (const at of [1, 2]) {
      expect(found(hiding(proof, ['pending', at]))).toEqual({
        invalid: false,
        issues: ['redacted entries: 1', ...lifted],
      });
    }
    expect(found(hiding(proof, ['pending', 1], ['pending', 2]))).toEqual({
      invalid: false,
      issues: ['redacted entries: 2', ...lifted],
    });
  });

  it('forged: a carrier no entry can be, no pending entry redacted → refused', () => {
    const content = { ...traceProof(chain('Z')), inputSalted: true };
    const proof = handSealed(content) as DecisionProof;
    expect(found(proof).issues).toContain(REFUSED);
    // A redaction of another section changes nothing to it.
    const redacted = found(hiding(proof, ['rules', 0]));
    expect(redacted.invalid).toBe(true);
    expect(redacted.issues).toContain(REFUSED);
  });
});

describe('verifyProof(p, { rules }) on a redacted proof', () => {
  const ruleC: RuleDefinitionInput = { ...ruleB, id: 'r3' };

  it('compares the rules it cannot see by number: consistent at best', () => {
    const proof = signed(salty(unsigned()));
    expect(computeRuleChecksum(ruleA)).toBe((proof.rules[0] as { checksum: string }).checksum);
    const options = { trustedKeys: TRUSTED, rules: [ruleA, ruleB] };
    expect(verifyProof(proof, options)).toEqual({ status: 'authentic', issues: [] });
    const redacted = hiding(proof, ['rules', 1]);
    expect(verifyProof(redacted, options)).toEqual({
      status: 'consistent-redacted',
      issues: [
        'redacted entries: 1',
        'rules check incomplete: 1 redacted rule',
        'check lifted: cited rules listed (rules redacted)',
        'check lifted: rules given against the proof (rules redacted)',
      ],
      redacted: 1,
      lifted: [
        { check: 'cited rules listed', redacted: ['rules'] },
        { check: 'rules given against the proof', redacted: ['rules'] },
      ],
    });
  });

  it('refuses more or fewer rules than the proof holds', () => {
    const redacted = hiding(signed(salty(unsigned())), ['rules', 1]);
    expect(verifyProof(redacted, { rules: [ruleA] })).toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining(['rules missing: 1 redacted, not given']) as unknown,
    });
    expect(verifyProof(redacted, { rules: [ruleA, ruleB, ruleC] })).toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining([
        'unexpected rules: 2 given, not in the proof (1 redacted)',
      ]) as unknown,
    });
    const both = hiding(signed(salty(unsigned())), ['rules', 0], ['rules', 1]);
    expect(verifyProof(both, { rules: [ruleA, ruleB] }).issues).toContain(
      'rules check incomplete: 2 redacted rules',
    );
  });

  it('a given rule whose checksum differs from a visible one stays invalid', () => {
    const redacted = hiding(signed(salty(unsigned())), ['rules', 1]);
    const changed = { ...ruleA, priority: 99 };
    expect(verifyProof(redacted, { rules: [changed, ruleB] }).status).toBe('invalid');
  });
});

describe('the schema of a redacted entry', () => {
  it('is accepted in every section, and refused malformed', () => {
    const proof = salty(unsigned());
    for (const section of PROOF_SECTIONS) {
      const marker = { redacted: 'ab'.repeat(32) };
      const withMarker = withCounts({
        ...proof,
        [section]: [...entriesOf(proof, section), marker],
      });
      expect([section, validateProof(withMarker).issues]).toEqual([section, []]);
      for (const bad of [
        { redacted: 'AB'.repeat(32) },
        { redacted: 'ab'.repeat(31) },
        { redacted: 1 },
        { redacted: 'ab'.repeat(32), salt: 'a'.repeat(32) },
      ]) {
        const malformed = withCounts({ ...proof, [section]: [...entriesOf(proof, section), bad] });
        expect([section, validateProof(malformed).issues.length > 0]).toEqual([section, true]);
      }
    }
  });

  it('refuses the same leaf hash twice', () => {
    const marker = { redacted: 'ab'.repeat(32) };
    const proof = salty(unsigned());
    expect(validateProof(withCounts({ ...proof, factsRead: [marker, marker] })).issues).toEqual([
      { path: 'factsRead[1]', message: 'factsRead[1] repeats the redacted leaf of factsRead[0]' },
    ]);
    expect(
      validateProof(withCounts({ ...proof, missingFacts: [marker], readsUndeclared: [marker] }))
        .issues,
    ).toEqual([
      {
        path: 'readsUndeclared[0]',
        message: 'readsUndeclared[0] repeats the redacted leaf of missingFacts[0]',
      },
    ]);
  });
});
