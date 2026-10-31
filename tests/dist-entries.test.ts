import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CivilCalendar } from '../src/index.js';
import { fixedCalendar, ueReferential, overlapReport } from './helpers.js';
import vector from './vectors/input-v1.json';

// These tests read the BUILT entries: only there do `index` and `canonical` bundle separate
// copies of `SpecError` (tsup `splitting: false`). Run `npm run build` first.
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const built = ['index.js', 'index.cjs', 'canonical.js', 'canonical.cjs'].every((f) =>
  existsSync(resolve(dist, f)),
);
// eslint-disable-next-line no-console -- say why the suite is skipped
if (!built) console.warn('dist-entries tests skipped: dist is missing, run `npm run build` first');
const describeBuilt = describe.skipIf(!built);

type SpecErrorClass = new (
  code: string,
  message: string,
  path?: string,
) => Error & {
  code: string;
  path?: string;
};
type Proof = { digest: string };
type Entry = {
  SpecError: SpecErrorClass;
  sha256Hex: (text: string) => string;
  sealProof: (proof: object) => Proof;
  signProof: (proof: Proof, privateKey: string, keyId: string) => Proof;
  createSigningKeyPair: () => { privateKey: string; publicKey: string };
  verifyProof: (
    proof: unknown,
    options?: { trustedKeys?: Record<string, string> },
  ) => { status: string; issues: string[] };
  OUTPUTS_VARIABLE: string;
  isCanonicalDecimal: (text: string) => boolean;
  PROOF_FORMATS: readonly string[];
  ENGINE_VARIABLES: readonly string[];
  isReservedName: (name: string) => boolean;
  parsePointer: (pointer: string) => string[];
  formatPointer: (segments: readonly string[]) => string;
  comparePointers: (a: string, b: string) => number;
  contextToInputPointer: (pointer: string) => string | undefined;
  elementSegment: (key: string | number) => string;
  groupSegment: (value: string | number) => string;
  isSubject: (value: unknown) => boolean;
  subjectContains: (scope: string, subject: string) => boolean;
  toCanonicalDecimal: (text: string) => string;
  toReferenceDate: (value: Date | string) => string;
  isCivilDate: (value: unknown) => boolean;
  isInstant: (value: unknown) => boolean;
  isTimeZone: (zone: unknown) => boolean;
  normalizeTimeZone: (zone: string) => string;
  windowContains: (
    rule: { effectiveFrom: string; effectiveUntil: string | null },
    at: string,
    timeZone: string,
    calendar: CivilCalendar,
  ) => boolean | 'unknown';
  validateReferential: (value: unknown) => { path: string; message: string }[];
  matchDimension: (
    spec: unknown,
    input: string,
    at: string,
    referentials: ReadonlyMap<string, unknown>,
  ) => unknown;
  computeReferentialDigest: (referential: unknown) => string;
  findOverlappingVersions: (
    rules: readonly { id: string; version: number; effectiveFrom: string; effectiveUntil: null }[],
    timeZone: string,
    calendar: CivilCalendar,
  ) => unknown;
  LOCAL_RULE_SET: string;
  qualifyName: (ruleSet: string, name: string) => string;
  isRuleSetId: (value: unknown) => boolean;
  isPackId: (value: unknown) => boolean;
  packIdProblem: (value: unknown) => string | undefined;
  normalizeRuleDefinition: (rule: object) => Record<string, unknown>;
  validateProofInput: (value: unknown) => { path: string; message: string }[];
  validateTemporalFact: (value: unknown, path: string) => { path: string; message: string }[];
  governingAssertion: (
    assertions: Readonly<Record<string, unknown>>,
    pointer: string,
  ) => { pointer: string; assertion: unknown } | undefined;
  isProvisionalAssertion: (assertion: object) => boolean;
  computeAssertionDigest: (assertion: object) => string;
  merkleRoot: (leaves: readonly Uint8Array[]) => Uint8Array;
  inclusionPath: (leaves: readonly Uint8Array[], index: number) => Uint8Array[];
  verifyInclusion: (
    leaf: Uint8Array,
    index: number,
    size: number,
    path: readonly Uint8Array[],
    root: Uint8Array,
  ) => boolean;
  deriveInputSeed: (secret: Uint8Array, requestId: string) => Uint8Array;
  UNSALTED_SEED: Uint8Array;
  INPUT_TREE_TAG: string;
  inputLeaves: (input: object, seed: Uint8Array) => { pointer: string; salt: string }[];
  inputLeafHash: (leaf: object) => Uint8Array;
  verifyInputInclusion: (
    digest: string,
    size: number,
    index: number,
    leafHash: Uint8Array,
    path: readonly Uint8Array[],
  ) => boolean;
  computeInputDigest: (input: object, seed: Uint8Array) => string;
  computeIdempotencyDigest: (request: object) => string;
};

async function esm(file: string): Promise<Entry> {
  return (await import(/* @vite-ignore */ pathToFileURL(resolve(dist, file)).href)) as Entry;
}
const cjs = (file: string): Entry => createRequire(import.meta.url)(resolve(dist, file)) as Entry;

describeBuilt('built entries: one SpecError identity', () => {
  it('the two ESM entries bundle distinct classes that recognise each other', async () => {
    const main = (await esm('index.js')).SpecError;
    const canonical = (await esm('canonical.js')).SpecError;
    expect(main).not.toBe(canonical);

    const fromCanonical = new canonical('INVALID_RULE', 'bad', 'params.rate');
    const fromMain = new main('INVALID_DATE', 'bad date');
    expect(fromCanonical).toBeInstanceOf(main);
    expect(fromMain).toBeInstanceOf(canonical);
    expect(fromCanonical).toBeInstanceOf(Error);
    expect(fromCanonical).toMatchObject({
      name: 'SpecError',
      code: 'INVALID_RULE',
      path: 'params.rate',
    });
    expect(fromMain.code).toBe('INVALID_DATE');
    expect(fromMain.path).toBeUndefined();
  });

  it('ESM and CJS copies recognise each other too', async () => {
    const esmClass = (await esm('canonical.js')).SpecError;
    const cjsClass = cjs('index.cjs').SpecError;
    expect(new esmClass('INVALID_RULE', 'x')).toBeInstanceOf(cjsClass);
    expect(new cjsClass('INVALID_RULE', 'x')).toBeInstanceOf(esmClass);
  });

  it('a plain Error, or one only named SpecError, is not a SpecError', async () => {
    const main = (await esm('index.js')).SpecError;
    const impostor = Object.assign(new Error('x'), { name: 'SpecError', code: 'INVALID_RULE' });
    expect(new Error('x')).not.toBeInstanceOf(main);
    expect(impostor).not.toBeInstanceOf(main);
    expect({ code: 'INVALID_RULE' }).not.toBeInstanceOf(main);
  });

  it('every built entry exports a working sha256Hex', async () => {
    const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const entries = [
      await esm('index.js'),
      await esm('canonical.js'),
      cjs('index.cjs'),
      cjs('canonical.cjs'),
    ];
    for (const entry of entries) {
      expect(entry.sha256Hex('')).toBe(empty);
      expect(entry.sha256Hex('é')).toBe(createHash('sha256').update('é', 'utf8').digest('hex'));
    }
  });

  it('a proof signed through one built entry is authentic through every other', async () => {
    const entries = [
      await esm('index.js'),
      await esm('canonical.js'),
      cjs('index.cjs'),
      cjs('canonical.cjs'),
    ];
    const unsigned = {
      format: 'run-iq.proof/1',
      requestId: 'req-1',
      evaluatedAt: null,
      sealedAt: '2025-06-01T10:00:00.000Z',
      inputDigest: '0'.repeat(64),
      rules: [],
      versions: { engine: '1.0.0', plugins: {}, dsls: {} },
      strata: [],
      outputs: {},
      applied: [],
      skipped: [],
      exceptions: [],
    };
    for (const signer of entries) {
      const { privateKey, publicKey } = signer.createSigningKeyPair();
      const proof = signer.signProof(signer.sealProof(unsigned), privateKey, 'k');
      for (const verifier of entries) {
        expect(verifier.verifyProof(proof, { trustedKeys: { k: publicKey } })).toEqual({
          status: 'authentic',
          issues: [],
        });
      }
    }
  });

  it('every built entry exports the decimal functions and the reserved variable', async () => {
    const entries = [
      await esm('index.js'),
      await esm('canonical.js'),
      cjs('index.cjs'),
      cjs('canonical.cjs'),
    ];
    for (const entry of entries) {
      expect(entry.OUTPUTS_VARIABLE).toBe('$outputs');
      expect(entry.isCanonicalDecimal('12.5')).toBe(true);
      expect(entry.isCanonicalDecimal('-0')).toBe(false);
      expect(entry.toCanonicalDecimal('0012.50')).toBe('12.5');
      expect(() => entry.toCanonicalDecimal('1e3')).toThrow(
        expect.objectContaining({ code: 'INVALID_DECIMAL' }),
      );
    }
  });

  it('every built entry exports pointers, subjects, reserved names and proof formats', async () => {
    const entries = [
      await esm('index.js'),
      await esm('canonical.js'),
      cjs('index.cjs'),
      cjs('canonical.cjs'),
    ];
    for (const entry of entries) {
      expect(entry.PROOF_FORMATS).toEqual(['run-iq.proof/1']);
      expect(entry.ENGINE_VARIABLES).toHaveLength(14);
      expect(entry.isReservedName('$x')).toBe(true);
      expect(entry.parsePointer('/a~1b/~0c')).toEqual(['a/b', '~c']);
      expect(entry.formatPointer(['a/b', '~c'])).toBe('/a~1b/~0c');
      expect(entry.comparePointers('/a', '/a/b')).toBe(-1);
      expect(entry.contextToInputPointer('/$dates/effective')).toBe('/meta/dates/effective');
      expect(entry.elementSegment(7)).toBe('@7');
      expect(entry.groupSegment('42')).toBe('!group=42');
      expect(entry.isSubject('/foyers/@f1')).toBe(true);
      expect(entry.subjectContains('/foyers/@f1', '/foyers/@f10')).toBe(false);
      expect(() => entry.parsePointer('a')).toThrow(
        expect.objectContaining({ code: 'INVALID_PATH' }),
      );
    }
  });

  it('every built entry exports civil time, windows and version overlaps', async () => {
    const entries = [
      await esm('index.js'),
      await esm('canonical.js'),
      cjs('index.cjs'),
      cjs('canonical.cjs'),
    ];
    for (const entry of entries) {
      expect(entry.toReferenceDate('2026-01-01T01:00:00+01:00')).toBe('2026-01-01T00:00:00.000Z');
      expect(entry.isCivilDate('2024-02-29')).toBe(true);
      expect(entry.isInstant('2026-01-01T00:00:00Z')).toBe(false);
      expect(entry.isTimeZone('Europe/Paris')).toBe(true);
      expect(entry.normalizeTimeZone('-00:00')).toBe('UTC');
      const rule = { effectiveFrom: '2026-01-01', effectiveUntil: null };
      expect(
        entry.windowContains(rule, '2025-12-31T23:30:00.000Z', 'Europe/Paris', fixedCalendar),
      ).toBe(true);
      const versions = [1, 2].map((version) => ({ id: 'R1', version, ...rule }));
      expect(entry.findOverlappingVersions(versions, 'UTC', fixedCalendar)).toEqual(
        overlapReport([{ ruleSet: 'local', id: 'R1', versions: [1, 2], kind: 'overlap' }]),
      );
    }
  });

  it('every built entry exports dimensions and referentials', async () => {
    const entries = [
      await esm('index.js'),
      await esm('canonical.js'),
      cjs('index.cjs'),
      cjs('canonical.cjs'),
    ];
    const referential = ueReferential();
    for (const entry of entries) {
      expect(entry.validateReferential(referential)).toEqual([]);
      expect(entry.computeReferentialDigest(referential)).toMatch(/^[0-9a-f]{64}$/);
      const tables = new Map([['ue', referential]]);
      expect(
        entry.matchDimension({ ref: 'ue', anyOf: ['EEE'] }, 'FR', '2026-01-01', tables),
      ).toEqual({ result: true, values: ['FR'], via: ['EEE', 'UE'] });
    }
  });

  it('every built entry exports collections and rule sets', async () => {
    const entries = [
      await esm('index.js'),
      await esm('canonical.js'),
      cjs('index.cjs'),
      cjs('canonical.cjs'),
    ];
    const rule = {
      id: 'R1',
      version: 1,
      model: 'M',
      params: {},
      priority: 1,
      effectiveFrom: '2026-01-01',
      ruleSet: 'local',
      forEach: { path: '/enfants', key: ['id'] },
    };
    for (const entry of entries) {
      expect(entry.LOCAL_RULE_SET).toBe('local');
      expect(entry.qualifyName('rgpd', 'profilage')).toBe('rgpd:profilage');
      expect(entry.isRuleSetId('local')).toBe(true);
      expect(entry.isPackId('local')).toBe(false);
      expect(entry.packIdProblem('rgpd')).toBeUndefined();
      const normal = entry.normalizeRuleDefinition(rule);
      expect(normal.forEach).toEqual({ path: '/enfants', key: 'id' });
      expect(normal).not.toHaveProperty('ruleSet');
    }
  });

  it('every built entry exports the proof input functions', async () => {
    const entries = [
      await esm('index.js'),
      await esm('canonical.js'),
      cjs('index.cjs'),
      cjs('canonical.cjs'),
    ];
    const assertion = { by: 'a', method: 'presumed', at: '2026-01-01', status: 'validated' };
    const input = {
      data: { x: 1 },
      meta: {
        tenantId: 't',
        dates: {},
        tags: [],
        dimensions: {},
        context: {},
        assertions: { '/x': assertion },
      },
    };
    const period = { from: '2026-01-01', until: null, value: 1 };
    for (const entry of entries) {
      expect(entry.validateProofInput(input)).toEqual([]);
      expect(entry.validateTemporalFact([period, period], '/p')).toEqual([
        { path: '/p/1', message: 'overlap at /p/1' },
      ]);
      expect(entry.governingAssertion({ '/x': assertion }, '/x/y')).toEqual({
        pointer: '/x',
        assertion,
      });
      expect(entry.isProvisionalAssertion(assertion)).toBe(true);
      expect(entry.computeAssertionDigest(assertion)).toBe(
        entry.sha256Hex('{"at":"2026-01-01","by":"a","method":"presumed","status":"validated"}'),
      );
    }
  });

  it('every built entry exports the input tree and gives the frozen vector', async () => {
    const entries = [
      await esm('index.js'),
      await esm('canonical.js'),
      cjs('index.cjs'),
      cjs('canonical.cjs'),
    ];
    const secret = new Uint8Array(Buffer.from(vector.secret, 'hex'));
    const leaves = ['a', 'b', 'c'].map(
      (text) => new Uint8Array(createHash('sha256').update(text).digest()),
    );
    for (const entry of entries) {
      const seed = entry.deriveInputSeed(secret, vector.requestId);
      expect(Buffer.from(seed).toString('hex')).toBe(vector.salted.seed);
      expect(entry.computeInputDigest(vector.input, seed)).toBe(vector.salted.inputDigest);
      expect(entry.computeInputDigest(vector.input, entry.UNSALTED_SEED)).toBe(
        vector.unsalted.inputDigest,
      );
      expect(entry.INPUT_TREE_TAG).toBe('run-iq.input/1');
      const [first] = entry.inputLeaves(vector.input, seed);
      expect(first?.salt).toBe(vector.salted.firstLeaf.salt);
      expect(Buffer.from(entry.inputLeafHash(first ?? {})).toString('hex')).toBe(
        vector.salted.firstLeaf.hash,
      );
      const root = entry.merkleRoot(leaves);
      expect(Buffer.from(root).toString('hex')).toBe(vector.merkle.root);
      const path = entry.inclusionPath(leaves, 2);
      expect(entry.verifyInclusion(leaves[2] ?? root, 2, 3, path, root)).toBe(true);
      const hashes = entry.inputLeaves(vector.input, seed).map((leaf) => entry.inputLeafHash(leaf));
      expect(hashes).toHaveLength(vector.salted.leafCount);
      const digest = vector.salted.inputDigest;
      const proof = entry.inclusionPath(hashes, 4);
      const leaf = hashes[4] ?? root;
      expect(entry.verifyInputInclusion(digest, 10, 4, leaf, proof)).toBe(true);
      expect(entry.verifyInputInclusion(digest, 11, 4, leaf, proof)).toBe(false);
      const request = { input: vector.input, options: {} };
      expect(entry.computeIdempotencyDigest(request)).toBe(
        entry.sha256Hex(
          '{"input":{"data":{"a":1,"b":[],"c":{},"d":{"e":null}},"meta":{"assertions":{},' +
            '"context":{},"dates":{},"dimensions":{},"tags":[],"tenantId":"t"}},"options":{}}',
        ),
      );
    }
  });

  it('no built entry imports a node: module or crypto', () => {
    for (const file of ['index.js', 'index.cjs', 'canonical.js', 'canonical.cjs']) {
      const code = readFileSync(resolve(dist, file), 'utf8');
      expect(code, file).not.toMatch(/(?:from|import|require)\s*\(?\s*["']node:/);
      expect(code, file).not.toMatch(/(?:from|import|require)\s*\(?\s*["']crypto["']/);
    }
  });
});
