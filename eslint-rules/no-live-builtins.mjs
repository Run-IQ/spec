// A rule of this repository: `src/` reads no built-in of the language or of the host directly.
// Every prototype method, getter, static and constructor it needs is captured once, when
// `src/intrinsics.ts` loads, and used from there: code that patches a built-in later changes no
// verdict. Spec's own code is fully in scope; the signature and hash dependencies are not (the
// README, "Threat model").
//
// In every file but `intrinsics.ts`, this rule flags:
// - a member whose declaration is in the default library or in `@types/node` and is a method, a
//   function, a getter of a prototype, or a static of a constructor or namespace
//   (`list.push(x)`, `map.size`, `Object.keys(x)`, `new TextEncoder().encode(t)`);
// - the same members when destructured (`const { push } = list`);
// - `instanceof` against a built-in constructor (it reads the live `Symbol.hasInstance`);
// - the iteration protocol over data: `for ... of`, spread, array destructuring, `yield*`, and a
//   `Map`, `Set` or `WeakSet` built from an iterable (the engine runs it through well-known
//   symbols a patch can replace): use an indexed loop over a captured length, or the captured
//   iterators of `intrinsics.ts`.
// The globals themselves (`Map`, `Object`, `JSON`, `process`, ...) are refused by
// `no-restricted-globals` (`eslint.config.mjs`).
import { ESLintUtils } from '@typescript-eslint/utils';
import ts from 'typescript';

// Getters that live on a prototype (an own data property of the instance would not be).
const GETTERS = new Set([
  'Map.size',
  'ReadonlyMap.size',
  'Set.size',
  'ReadonlySet.size',
  'Uint8Array.length',
  'Uint8Array.buffer',
  'Float64Array.length',
  'RegExp.source',
]);
const NAMESPACES = new Set(['JSON', 'Math', 'Reflect', 'Intl']);
// Plain objects whose members the lib declares as methods: a descriptor's `get`, a `done` result.
const DATA_OWNERS = new Set(['PropertyDescriptor', 'PropertyDescriptorMap', 'ProxyHandler']);
// Constructors that iterate their argument, and helpers of `intrinsics.ts` that do.
const ITERATING_CONSTRUCTORS = new Set([
  'NativeMap',
  'NativeSet',
  'NativeWeakSet',
  'NativeWeakMap',
]);
const ITERATING_HELPERS = new Set(['arrayFrom', 'uint8ArrayFrom', 'objectFromEntries']);

function ownerName(declaration) {
  const parent = declaration.parent;
  if (parent && parent.name && typeof parent.name.text === 'string') return parent.name.text;
  if (parent && ts.isModuleBlock(parent)) return parent.parent.name.text;
  return undefined;
}

export default {
  rules: {
    'no-live-builtins': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          live: '`{{owner}}.{{member}}` is read from the live built-in: use the captured one from `intrinsics.ts`.',
          destructured:
            '`{{owner}}.{{member}}` is destructured from the live built-in: use the captured one from `intrinsics.ts`.',
          elementRead:
            'A literal index reads an element that may be absent, and an absent one is read from `Array.prototype`: use `elementOf` from `intrinsics.ts` (a tuple of known length is fine).',
          forIn:
            '`for ... in` enumerates the keys of the prototype chain, which a polluted prototype adds to: use `objectKeys` and an indexed loop.',
          inOperator:
            '`in` also finds inherited properties (and makes an array hole look present): use `hasOwnKey` from `intrinsics.ts`.',
          instanceOf:
            '`instanceof` against a built-in reads its live `Symbol.hasInstance`: use `functionHasInstance` from `intrinsics.ts`.',
          iteration:
            'The iteration protocol ({{what}}) runs through well-known symbols a patch can replace: use an indexed loop over a captured length, or the captured iterators of `intrinsics.ts`.',
        },
      },
      create(context) {
        const services = ESLintUtils.getParserServices(context);
        const program = services.program;
        const checker = program.getTypeChecker();
        const fromHost = (file) =>
          program.isSourceFileDefaultLibrary(file) ||
          /[\\/]@types[\\/]node[\\/]/.test(file.fileName);

        /** The `{ owner, member }` of a host member that reads live, or `undefined`. */
        const liveMember = (symbol) => {
          const declaration = symbol?.declarations?.[0];
          if (!declaration || !fromHost(declaration.getSourceFile())) return undefined;
          const owner = ownerName(declaration);
          if (owner === undefined || DATA_OWNERS.has(owner)) return undefined;
          const member = symbol.getName();
          const isFunction =
            ts.isMethodSignature(declaration) ||
            ts.isMethodDeclaration(declaration) ||
            ts.isFunctionDeclaration(declaration);
          const isStatic = owner.endsWith('Constructor') || NAMESPACES.has(owner);
          const flagged =
            isFunction || GETTERS.has(`${owner}.${member}`) || (isStatic && member !== 'prototype');
          return flagged ? { owner, member } : undefined;
        };

        const isBuiltinConstructor = (node) => {
          if (node.type !== 'Identifier') return false;
          if (/^Native[A-Z]/.test(node.name)) return true;
          const symbol = checker.getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(node));
          return (symbol?.declarations ?? []).some((d) => fromHost(d.getSourceFile()));
        };

        return {
          MemberExpression(node) {
            if (
              node.computed &&
              node.property.type === 'Literal' &&
              typeof node.property.value === 'number' &&
              !(node.parent.type === 'AssignmentExpression' && node.parent.left === node)
            ) {
              const objectType = checker.getTypeAtLocation(
                services.esTreeNodeToTSNodeMap.get(node.object),
              );
              if (checker.isArrayType(objectType) && !checker.isTupleType(objectType)) {
                context.report({ node, messageId: 'elementRead' });
              }
            }
            if (node.computed && node.property.type !== 'Literal') return;
            const tsNode = services.esTreeNodeToTSNodeMap.get(node);
            const name = tsNode.name ?? tsNode.argumentExpression;
            if (!name) return;
            const found = liveMember(checker.getSymbolAtLocation(name));
            if (found) context.report({ node: node.property, messageId: 'live', data: found });
          },
          ObjectPattern(node) {
            for (const property of node.properties) {
              if (property.type !== 'Property' || property.computed) continue;
              const tsPattern = services.esTreeNodeToTSNodeMap.get(node);
              const name = property.key.name ?? property.key.value;
              if (typeof name !== 'string') continue;
              const type = checker.getTypeAtLocation(tsPattern);
              const found = liveMember(type.getProperty(name));
              if (found) context.report({ node: property, messageId: 'destructured', data: found });
            }
          },
          BinaryExpression(node) {
            if (node.operator === 'instanceof' && isBuiltinConstructor(node.right)) {
              context.report({ node, messageId: 'instanceOf' });
            }
            // `#field in object` is a brand check, not a property lookup.
            if (node.operator === 'in' && node.left.type !== 'PrivateIdentifier') {
              context.report({ node, messageId: 'inOperator' });
            }
          },
          ForInStatement(node) {
            context.report({ node, messageId: 'forIn' });
          },
          ForOfStatement(node) {
            context.report({ node, messageId: 'iteration', data: { what: 'for ... of' } });
          },
          SpreadElement(node) {
            // An object spread copies own properties: it is not iteration.
            if (node.parent.type === 'ObjectExpression') return;
            context.report({ node, messageId: 'iteration', data: { what: 'spread' } });
          },
          ArrayPattern(node) {
            context.report({ node, messageId: 'iteration', data: { what: 'array destructuring' } });
          },
          YieldExpression(node) {
            if (node.delegate) {
              context.report({ node, messageId: 'iteration', data: { what: 'yield*' } });
            }
          },
          NewExpression(node) {
            if (
              node.callee.type === 'Identifier' &&
              ITERATING_CONSTRUCTORS.has(node.callee.name) &&
              node.arguments.length > 0
            ) {
              context.report({
                node,
                messageId: 'iteration',
                data: { what: `${node.callee.name} built from an iterable` },
              });
            }
          },
          CallExpression(node) {
            if (node.callee.type === 'Identifier' && ITERATING_HELPERS.has(node.callee.name)) {
              context.report({
                node,
                messageId: 'iteration',
                data: { what: `${node.callee.name} iterates its argument` },
              });
            }
          },
        };
      },
    },
  },
};
