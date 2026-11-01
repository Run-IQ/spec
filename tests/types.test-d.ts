import { describe, expectTypeOf, it } from 'vitest';
import {
  DISCLOSURE_FORMAT,
  discloseFacts,
  verifyFactDisclosure,
  computeIdempotencyDigest,
  computeInputDigest,
  deriveInputSeed,
  inclusionPath,
  INPUT_TREE_TAG,
  inputLeafHash,
  inputLeaves,
  merkleRoot,
  UNSALTED_SEED,
  verifyInclusion,
  verifyInputInclusion,
  isPackId,
  isRuleSetId,
  LOCAL_RULE_SET,
  qualifyName,
  computeRuleChecksum,
  findOverlappingVersions,
  isCanonicalDecimal,
  isCivilDate,
  isInstant,
  toReferenceDate,
  windowContains,
  OUTPUTS_VARIABLE,
  toCanonicalDecimal,
  computeRuleFingerprint,
  fromStoredRecord,
  matchesSelector,
  normalizeRuleDefinition,
  toExecutableRule,
  toStoredPayload,
  validateRuleDefinition,
} from '../src/index.js';
import type {
  AbsenceProof,
  DisclosedLeaf,
  FactDisclosure,
  FactDisclosureVerification,
  JsonPointer,
  InputLeaf,
  ProofInput,
  ForEach,
  OrderKey,
  CivilCalendar,
  CivilDate,
  DimensionSpec,
  ExecutableRule,
  Instant,
  VersionOverlap,
  VersionOverlapReport,
  JsonValue,
  OutputDeclaration,
  OutputRounding,
  OutputType,
  ProofException,
  ProofOutput,
  ProofSkip,
  ProofStep,
  RoundingMode,
  SpecErrorCode,
  UnsignedProof,
  RuleDefinition,
  RuleDefinitionBase,
  RuleDefinitionInput,
  RuleException,
  RuleSelector,
  StoredRuleRecord,
} from '../src/index.js';

const def = normalizeRuleDefinition({
  id: 'r1',
  version: 1,
  model: 'FLAT',
  params: { amount: 1 },
  priority: 1,
  effectiveFrom: '2025-01-01',
});

describe('RuleDefinition types (A5)', () => {
  it('keeps the named fields typed despite the extension index', () => {
    expectTypeOf(def.priority).toEqualTypeOf<number>();
    expectTypeOf(def.id).toEqualTypeOf<string>();
    expectTypeOf(def.version).toEqualTypeOf<number>();
    expectTypeOf(def.model).toEqualTypeOf<string>();
    expectTypeOf(def.params).toEqualTypeOf<JsonValue>();
    expectTypeOf(def.effectiveFrom).toEqualTypeOf<string>();
    expectTypeOf(def.effectiveUntil).toEqualTypeOf<string | null>();
    expectTypeOf(def.tags).toEqualTypeOf<string[]>();
    expectTypeOf(def.dimensions).toEqualTypeOf<Record<string, DimensionSpec>>();
    expectTypeOf(def.condition).toEqualTypeOf<{ dsl: string; value: JsonValue } | undefined>();
    expectTypeOf(def.exceptions).toEqualTypeOf<RuleException[] | undefined>();
  });

  it('narrows an exception by its kind', () => {
    const exception = def.exceptions?.[0];
    if (exception?.kind === 'substitute') {
      expectTypeOf(exception.params).toEqualTypeOf<{ [k: string]: JsonValue }>();
      expectTypeOf(exception.targets).toEqualTypeOf<RuleSelector>();
    }
    if (exception?.kind === 'shortCircuit') {
      expectTypeOf(exception.reason).toEqualTypeOf<string | undefined>();
    }
  });

  it('accepts an executable rule where a selector match needs a rule', () => {
    expectTypeOf<ExecutableRule>().toMatchTypeOf<Parameters<typeof matchesSelector>[0]>();
  });

  it('exposes extensions as unknown', () => {
    expectTypeOf(def['jurisdiction']).toEqualTypeOf<unknown>();
  });

  it('the base interface has no index signature, so Omit keeps the named fields', () => {
    type WithoutDates = Omit<RuleDefinitionBase, 'effectiveFrom' | 'effectiveUntil'>;
    expectTypeOf<WithoutDates['priority']>().toEqualTypeOf<number>();
    expectTypeOf<RuleDefinition>().toMatchTypeOf<RuleDefinitionBase>();
  });

  it('has no schemaVersion field', () => {
    expectTypeOf<RuleDefinitionBase>().not.toHaveProperty('schemaVersion');
  });

  it('accepts readonly arrays, readonly records, Date bounds and typed params', () => {
    interface FlatParams {
      readonly rate: number;
      readonly base: string;
    }
    const params: FlatParams = { rate: 0.1, base: 'x' };
    const tags = ['a', 'b'] as const;
    const dimensions: Readonly<Record<string, string>> = { country: 'TG' };
    const input = {
      id: 'r1',
      version: 1,
      model: 'FLAT',
      params,
      priority: 1,
      effectiveFrom: new Date(),
      effectiveUntil: null,
      tags,
      dimensions,
    };
    expectTypeOf(input).toMatchTypeOf<RuleDefinitionInput>();
    expectTypeOf(computeRuleChecksum(input)).toEqualTypeOf<string>();
    expectTypeOf(computeRuleFingerprint(input)).toEqualTypeOf<string>();
  });

  it('a normalized definition is a valid input again', () => {
    expectTypeOf<RuleDefinition>().toMatchTypeOf<RuleDefinitionInput>();
  });
});

describe('ExecutableRule types (A6)', () => {
  const rule = toExecutableRule({
    id: 'r1',
    version: 1,
    model: 'FLAT',
    params: { rate: 0.1, base: 'x' },
    priority: 1,
    effectiveFrom: '2025-01-01',
  });

  it('has typed named fields, civil or Date bounds and a checksum', () => {
    expectTypeOf(rule.priority).toEqualTypeOf<number>();
    expectTypeOf(rule.params).toEqualTypeOf<unknown>();
    expectTypeOf(rule.effectiveFrom).toEqualTypeOf<CivilDate | Date>();
    expectTypeOf(rule.effectiveUntil).toEqualTypeOf<CivilDate | Date | null>();
    expectTypeOf(rule.timeZone).toEqualTypeOf<string | undefined>();
    expectTypeOf(rule.effectiveOn).toEqualTypeOf<string | undefined>();
    expectTypeOf(rule.checksum).toEqualTypeOf<string>();
    expectTypeOf(rule.tags).toEqualTypeOf<readonly string[]>();
    expectTypeOf(rule.dimensions).toEqualTypeOf<Readonly<Record<string, DimensionSpec>>>();
    expectTypeOf(rule.condition).toEqualTypeOf<
      { readonly dsl: string; readonly value: unknown } | undefined
    >();
  });

  it('a plugin can narrow params, like FiscalRule', () => {
    interface FlatParams {
      readonly rate: number;
      readonly base: string;
    }
    interface MyRule extends ExecutableRule {
      params: FlatParams;
    }
    expectTypeOf<MyRule['params']>().toEqualTypeOf<FlatParams>();
    expectTypeOf<MyRule['priority']>().toEqualTypeOf<number>();
    expectTypeOf<MyRule>().toMatchTypeOf<ExecutableRule>();
  });

  it('an executable rule is a valid input again', () => {
    expectTypeOf<ExecutableRule>().toMatchTypeOf<RuleDefinitionInput>();
    expectTypeOf(toStoredPayload(rule)).toEqualTypeOf<{ payload: string; checksum: string }>();
    expectTypeOf(fromStoredRecord).returns.toEqualTypeOf<ExecutableRule>();
  });

  it('StoredRuleRecord and the validator result', () => {
    expectTypeOf<StoredRuleRecord>().toEqualTypeOf<{
      id: string;
      version: number;
      checksum: string;
      payload: string;
    }>();
    expectTypeOf(validateRuleDefinition).returns.toEqualTypeOf<{
      valid: boolean;
      errors: string[];
      issues: { path: string; message: string }[];
    }>();
  });
});

describe('decimal outputs, rounding and strata (9A)', () => {
  it('adds the decimal type and declared rounding', () => {
    expectTypeOf<'decimal'>().toMatchTypeOf<OutputType>();
    expectTypeOf<RoundingMode>().toEqualTypeOf<
      'halfUp' | 'halfDown' | 'halfEven' | 'up' | 'down' | 'ceiling' | 'floor'
    >();
    expectTypeOf<OutputRounding>().toEqualTypeOf<{
      scale: number;
      mode: RoundingMode;
      at?: 'output' | 'contribution';
    }>();
    expectTypeOf<OutputDeclaration['rounding']>().toEqualTypeOf<OutputRounding | undefined>();
    expectTypeOf<'INVALID_DECIMAL'>().toMatchTypeOf<SpecErrorCode>();
  });

  it('types the decimal functions and the reserved variable', () => {
    expectTypeOf(isCanonicalDecimal).toEqualTypeOf<(text: string) => boolean>();
    expectTypeOf(toCanonicalDecimal).toEqualTypeOf<(text: string) => string>();
    expectTypeOf<typeof OUTPUTS_VARIABLE>().toEqualTypeOf<'$outputs'>();
  });

  it('adds strata, stratum numbers, rounding and unrounded values to the proof', () => {
    expectTypeOf<UnsignedProof['strata']>().toEqualTypeOf<string[][]>();
    expectTypeOf<ProofOutput['rounding']>().toEqualTypeOf<OutputRounding | undefined>();
    expectTypeOf<ProofStep['stratum']>().toEqualTypeOf<number>();
    expectTypeOf<ProofStep['unrounded']>().toEqualTypeOf<JsonValue | undefined>();
    expectTypeOf<ProofSkip['stratum']>().toEqualTypeOf<number>();
    expectTypeOf<ProofException['stratum']>().toEqualTypeOf<number>();
  });
});

describe('civil time types (Task 9D)', () => {
  it('types the reference dates, the window answer and the overlaps', () => {
    expectTypeOf(toReferenceDate).returns.toEqualTypeOf<CivilDate | Instant>();
    expectTypeOf(windowContains).returns.toEqualTypeOf<boolean | 'unknown'>();
    expectTypeOf(findOverlappingVersions).returns.toEqualTypeOf<VersionOverlapReport>();
    expectTypeOf<VersionOverlapReport['overlaps']>().toEqualTypeOf<VersionOverlap[]>();
    expectTypeOf<VersionOverlapReport['truncated']>().toEqualTypeOf<boolean>();
    expectTypeOf<VersionOverlap['versions']>().toEqualTypeOf<[number, number]>();
    expectTypeOf<VersionOverlap['kind']>().toEqualTypeOf<'overlap' | 'effectiveOn'>();
    expectTypeOf<CivilCalendar['startOfDay']>().returns.toEqualTypeOf<Instant>();
  });

  it('isCivilDate and isInstant narrow unknown values to strings', () => {
    const value: unknown = '2026-01-01';
    if (isCivilDate(value)) expectTypeOf(value).toEqualTypeOf<string>();
    if (isInstant(value)) expectTypeOf(value).toEqualTypeOf<string>();
  });
});

describe('collections and rule sets (Task 9F)', () => {
  it('types forEach, the order keys, the rule set and the selector rule sets', () => {
    expectTypeOf<RuleDefinitionBase['forEach']>().toEqualTypeOf<ForEach | undefined>();
    expectTypeOf<RuleDefinitionBase['ruleSet']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<RuleSelector['ruleSets']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<OrderKey['type']>().toEqualTypeOf<
      'number' | 'decimal' | 'date' | 'dateTime' | 'string'
    >();
    expectTypeOf<OrderKey['dir']>().toEqualTypeOf<'asc' | 'desc'>();
    expectTypeOf(qualifyName).toEqualTypeOf<(ruleSet: string, name: string) => string>();
    expectTypeOf<typeof LOCAL_RULE_SET>().toEqualTypeOf<'local'>();
  });

  it('isRuleSetId and isPackId narrow unknown values to strings', () => {
    const value: unknown = 'rgpd';
    if (isRuleSetId(value)) expectTypeOf(value).toEqualTypeOf<string>();
    if (isPackId(value)) expectTypeOf(value).toEqualTypeOf<string>();
  });

  it('tells the two forms of forEach apart by segments', () => {
    const check = (forEach: ForEach): void => {
      if ('segments' in forEach) {
        expectTypeOf(forEach.segments.facts).toEqualTypeOf<string[]>();
      } else {
        expectTypeOf(forEach.key).toEqualTypeOf<string | string[]>();
      }
    };
    check({ path: '/enfants', key: 'id' });
  });
});

describe('the input tree (Task 9H1)', () => {
  it('types the Merkle functions, the seed, the leaves and the digests', () => {
    expectTypeOf(merkleRoot).toEqualTypeOf<(leafHashes: readonly Uint8Array[]) => Uint8Array>();
    expectTypeOf(inclusionPath).toEqualTypeOf<
      (leafHashes: readonly Uint8Array[], index: number) => Uint8Array[]
    >();
    expectTypeOf(verifyInclusion).toEqualTypeOf<
      (
        leafHash: Uint8Array,
        index: number,
        size: number,
        path: readonly Uint8Array[],
        root: Uint8Array,
      ) => boolean
    >();
    expectTypeOf(deriveInputSeed).toEqualTypeOf<
      (secret: Uint8Array, requestId: string) => Uint8Array
    >();
    expectTypeOf(UNSALTED_SEED).toEqualTypeOf<Uint8Array>();
    expectTypeOf<typeof INPUT_TREE_TAG>().toEqualTypeOf<'run-iq.input/1'>();
    expectTypeOf<InputLeaf['kind']>().toEqualTypeOf<'value' | 'array' | 'object'>();
    expectTypeOf(inputLeaves).toEqualTypeOf<(input: ProofInput, seed: Uint8Array) => InputLeaf[]>();
    expectTypeOf(inputLeafHash).toEqualTypeOf<(leaf: InputLeaf) => Uint8Array>();
    expectTypeOf(verifyInputInclusion).toEqualTypeOf<
      (
        digest: string,
        size: number,
        index: number,
        leafHash: Uint8Array,
        path: readonly Uint8Array[],
      ) => boolean
    >();
    expectTypeOf(computeInputDigest).toEqualTypeOf<
      (input: ProofInput, seed: Uint8Array) => string
    >();
    expectTypeOf(computeIdempotencyDigest).toEqualTypeOf<
      (request: { input: ProofInput; options: { [k: string]: JsonValue } }) => string
    >();
  });
});

describe('fact disclosure types (Task 9H2)', () => {
  it('has the shapes of the shared names', () => {
    expectTypeOf<typeof DISCLOSURE_FORMAT>().toEqualTypeOf<'run-iq.disclosure/1'>();
    expectTypeOf<DisclosedLeaf>().toEqualTypeOf<{
      pointer: JsonPointer;
      kind: 'value' | 'array' | 'object';
      value?: JsonValue;
      length?: number;
      salt: string;
      index: number;
      path: string[];
    }>();
    expectTypeOf<AbsenceProof>().toEqualTypeOf<{
      pointer: JsonPointer;
      before?: DisclosedLeaf;
      after?: DisclosedLeaf;
    }>();
    expectTypeOf<FactDisclosure>().toEqualTypeOf<{
      format: 'run-iq.disclosure/1';
      inputDigest: string;
      size: number;
      facts: DisclosedLeaf[];
      absent: AbsenceProof[];
    }>();
    expectTypeOf<FactDisclosureVerification>().toEqualTypeOf<{
      valid: boolean;
      issues: string[];
      facts: Record<JsonPointer, JsonValue>;
      lists: Record<JsonPointer, number>;
      absent: JsonPointer[];
    }>();
    expectTypeOf(discloseFacts).toEqualTypeOf<
      (
        input: ProofInput,
        seed: Uint8Array,
        present: readonly JsonPointer[],
        absent: readonly JsonPointer[],
      ) => FactDisclosure
    >();
    expectTypeOf(verifyFactDisclosure).toEqualTypeOf<
      (d: unknown, inputDigest: string) => FactDisclosureVerification
    >();
  });
});
