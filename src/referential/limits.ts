import { SpecError, unreadableMessage } from '../errors.js';

/** Default bound on the nodes of a referential: its code periods, groups and members. */
export const DEFAULT_MAX_REFERENTIAL_NODES = 100_000;
/** Default bound on the nesting of groups: the groups of the longest chain at any date. */
export const DEFAULT_MAX_GROUP_DEPTH = 64;
/** Highest `maxDepth` accepted: deeper nesting has no use and only costs. */
export const MAX_GROUP_DEPTH_CEILING = 1024;
/** Default step budget of the cycle and depth sweep, per allowed node. */
export const STEPS_PER_NODE = 100;

/**
 * Limits shared by `validateReferential`, `normalizeReferential`, `computeReferentialDigest`,
 * `resolveMembership` and `matchDimension`.
 */
export interface ReferentialLimits {
  /** Most nodes (code periods, groups and members); default 100 000. */
  maxNodes?: number;
  /** Most groups on one chain of nesting at any date; default 64, at most 1 024. */
  maxDepth?: number;
  /**
   * Most elementary steps of the cycle and depth sweep of `validateReferential`; default
   * `100 × maxNodes` (10 000 000 by default). Beyond it the referential is refused as too
   * complex, so that no document can cost minutes of work.
   */
  maxSteps?: number;
}

/** Limits once read and defaulted. */
export interface Limits {
  maxNodes: number;
  maxDepth: number;
  maxSteps: number;
}

/**
 * Internal: reads `options` once each. Throws `SpecError` (`INVALID_REFERENTIAL`) for options
 * that are not an object, cannot be read, or hold a value that is not a positive integer, or a
 * `maxDepth` above 1 024.
 */
export function readLimits(options: unknown): Limits {
  if (options === undefined)
    return defaults(DEFAULT_MAX_REFERENTIAL_NODES, DEFAULT_MAX_GROUP_DEPTH);
  if (options === null || typeof options !== 'object') {
    throw new SpecError('INVALID_REFERENTIAL', 'options must be an object');
  }
  let maxNodes: unknown;
  let maxDepth: unknown;
  let maxSteps: unknown;
  try {
    maxNodes = Reflect.get(options, 'maxNodes');
    maxDepth = Reflect.get(options, 'maxDepth');
    maxSteps = Reflect.get(options, 'maxSteps');
  } catch (error) {
    throw new SpecError('INVALID_REFERENTIAL', unreadableMessage('options', error));
  }
  const nodes = positive(maxNodes, DEFAULT_MAX_REFERENTIAL_NODES, 'maxNodes');
  const depth = positive(maxDepth, DEFAULT_MAX_GROUP_DEPTH, 'maxDepth');
  if (depth > MAX_GROUP_DEPTH_CEILING) {
    throw new SpecError(
      'INVALID_REFERENTIAL',
      `maxDepth must be at most ${MAX_GROUP_DEPTH_CEILING}`,
    );
  }
  const limits = defaults(nodes, depth);
  return { ...limits, maxSteps: positive(maxSteps, limits.maxSteps, 'maxSteps') };
}

function defaults(maxNodes: number, maxDepth: number): Limits {
  return { maxNodes, maxDepth, maxSteps: STEPS_PER_NODE * maxNodes };
}

function positive(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new SpecError('INVALID_REFERENTIAL', `${name} must be a positive integer`);
  }
  return value;
}
