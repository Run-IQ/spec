import { citeName } from './errors.js';
/**
 * The variables the engine puts in the evaluation context, each read by a pointer
 * (`/$outputs/x`, `/$dates/effective`). Every name that starts with `$` is reserved
 * (`isReservedName`), not only these: an output, a root key of `data` or a dimension cannot use
 * one, so a variable added later never collides with data. Frozen.
 */
export const ENGINE_VARIABLES: readonly string[] = Object.freeze([
  '$outputs',
  '$dates',
  '$dimensions',
  '$item',
  '$index',
  '$params',
  '$selected',
  '$bounds',
  '$parent',
  '$prev',
  '$children',
  '$segment',
  '$group',
  '$ref',
]);

/**
 * Internal: the message refusing a date name starting with `$` at `path` (input
 * `meta.dates`): `$dates.<name>` never holds a reserved name (ruling 9G round 2).
 */
export function reservedDateNameMessage(path: string): string {
  return `${citeName(path)} must not start with "$": date names starting with "$" are reserved`;
}

/** Internal: the message refusing a pointer `/$dates/$…` at `path` (`effectiveOn`, segments). */
export function reservedDatePointerMessage(path: string): string {
  return (
    `${citeName(path)} must not name a date starting with "$": ` +
    'date names starting with "$" are reserved'
  );
}

/** True for a name that starts with `$`: reserved for the engine (ruling R36, D-3). */
export function isReservedName(name: string): boolean {
  return typeof name === 'string' && name.startsWith('$');
}
