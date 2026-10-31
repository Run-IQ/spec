import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

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
  toCanonicalDecimal: (text: string) => string;
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

  it('no built entry imports a node: module or crypto', () => {
    for (const file of ['index.js', 'index.cjs', 'canonical.js', 'canonical.cjs']) {
      const code = readFileSync(resolve(dist, file), 'utf8');
      expect(code, file).not.toMatch(/(?:from|import|require)\s*\(?\s*["']node:/);
      expect(code, file).not.toMatch(/(?:from|import|require)\s*\(?\s*["']crypto["']/);
    }
  });
});
