// A rule of this repository: `src/` calls no built-in of the language directly. Every prototype
// method, getter, static and constructor it needs is captured once, when `src/intrinsics.ts`
// loads, and used from there: code that patches a built-in later changes no verdict.
//
// This rule flags, in every file but `intrinsics.ts`, a member whose declaration is in the
// default library and is a method, a function, a getter of a prototype, or a static of a
// constructor or namespace (`list.push(x)`, `map.size`, `Object.keys(x)`, `JSON.parse(t)`).
// Plain data properties (`list.length`, `error.message`, `step.done`) are not flagged. The
// globals themselves (`Map`, `Object`, `JSON`, ...) are refused by `no-restricted-globals`.
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
        },
      },
      create(context) {
        const services = ESLintUtils.getParserServices(context);
        const program = services.program;
        return {
          MemberExpression(node) {
            if (node.computed && node.property.type !== 'Literal') return;
            const tsNode = services.esTreeNodeToTSNodeMap.get(node);
            const name = tsNode.name ?? tsNode.argumentExpression;
            if (!name) return;
            const symbol = services.program.getTypeChecker().getSymbolAtLocation(name);
            const declaration = symbol?.declarations?.[0];
            if (!declaration) return;
            const file = declaration.getSourceFile();
            if (!program.isSourceFileDefaultLibrary(file)) return;
            const owner = ownerName(declaration);
            if (owner === undefined || DATA_OWNERS.has(owner)) return;
            const member = symbol.getName();
            const isFunction =
              ts.isMethodSignature(declaration) ||
              ts.isMethodDeclaration(declaration) ||
              ts.isFunctionDeclaration(declaration);
            const isStatic = owner.endsWith('Constructor') || NAMESPACES.has(owner);
            const flagged =
              isFunction ||
              GETTERS.has(`${owner}.${member}`) ||
              (isStatic && member !== 'prototype');
            if (!flagged) return;
            context.report({ node: node.property, messageId: 'live', data: { owner, member } });
          },
        };
      },
    },
  },
};
