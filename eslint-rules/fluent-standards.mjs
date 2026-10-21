// Local ESLint rules for the fluent-api code standards that a selector in
// eslint.config.mjs cannot express. Each message names its rule ID from
// docs/guides/code-standards.md so a reader can look up the reasoning.
import { readdirSync } from 'node:fs';
import path from 'node:path';

const STANDARDS = 'docs/guides/code-standards.md';
const TEST_FILE = /\.(?:test|test-fixtures)\.ts$/;
const REPOSITORY_FILE = /\.repository\.ts$/;

// Returns the top-level domain a source file belongs to (`src/domains/<domain>/...`),
// or null for files outside src/domains.
function domainOf(file, srcRoot) {
  const relative = path.relative(srcRoot, file).split(path.sep);
  return relative[0] === 'domains' && relative.length > 2 ? relative[1] : null;
}

function srcRootOf(file) {
  const parts = file.split(path.sep);
  const index = parts.lastIndexOf('src');
  return index === -1 ? null : parts.slice(0, index + 1).join(path.sep);
}

function resolveSpecifier(specifier, file, srcRoot) {
  if (specifier.startsWith('@/')) return path.join(srcRoot, specifier.slice(2));
  if (specifier.startsWith('.')) return path.resolve(path.dirname(file), specifier);
  return null;
}

const noCrossDomainRepository = {
  meta: {
    type: 'problem',
    docs: { description: "Forbid importing another domain's repository" },
    schema: [],
    messages: {
      crossDomain:
        "FA-L1: '{{source}}' is the {{target}} domain's repository. Call a {{target}} service function instead ({{standards}}).",
    },
  },
  create(context) {
    const file = context.filename;
    if (TEST_FILE.test(file)) return {};
    const srcRoot = srcRootOf(file);
    if (!srcRoot) return {};
    const ownDomain = domainOf(file, srcRoot);

    function check(node) {
      if (!node.source || node.importKind === 'type' || node.exportKind === 'type') return;
      const source = node.source.value;
      if (!/\.repository$/.test(source)) return;
      const target = resolveSpecifier(source, file, srcRoot);
      if (!target) return;
      const targetDomain = domainOf(`${target}.ts`, srcRoot);
      if (targetDomain && targetDomain !== ownDomain) {
        context.report({
          node: node.source,
          messageId: 'crossDomain',
          data: { source, target: targetDomain, standards: STANDARDS },
        });
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};

const oneRepositoryPerDirectory = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Allow at most one repository file per domain or sub-domain directory' },
    schema: [],
    messages: {
      tooMany:
        'FA-L2: {{dir}} has {{count}} repository files ({{files}}). Keep one repository per domain or sub-domain leaf; move a resource with its own queries into its own leaf directory ({{standards}}).',
    },
  },
  create(context) {
    const file = context.filename;
    if (!REPOSITORY_FILE.test(file) || TEST_FILE.test(file)) return {};
    return {
      Program(node) {
        const dir = path.dirname(file);
        const repositories = readdirSync(dir)
          .filter((name) => REPOSITORY_FILE.test(name) && !TEST_FILE.test(name))
          .sort();
        if (repositories.length > 1) {
          context.report({
            node,
            loc: { line: 1, column: 0 },
            messageId: 'tooMany',
            data: {
              dir: path.relative(process.cwd(), dir),
              count: String(repositories.length),
              files: repositories.join(', '),
              standards: STANDARDS,
            },
          });
        }
      },
    };
  },
};

const repositoryNamespaceImport = {
  meta: {
    type: 'suggestion',
    docs: { description: "Import your own domain's repository as a namespace" },
    schema: [],
    messages: {
      named:
        "FA-L8: import your domain's repository as a namespace (`import * as repo from '{{source}}'`); `import type { … }` is fine ({{standards}}).",
    },
  },
  create(context) {
    const file = context.filename;
    if (TEST_FILE.test(file)) return {};
    const srcRoot = srcRootOf(file);
    if (!srcRoot) return {};
    const ownDomain = domainOf(file, srcRoot);

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        const source = node.source.value;
        if (!/\.repository$/.test(source)) return;
        const hasValueSpecifier = node.specifiers.some(
          (specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type'
        );
        if (!hasValueSpecifier) return;
        const target = resolveSpecifier(source, file, srcRoot);
        // Another domain's repository is FA-L1's finding; report each import once.
        if (!target || domainOf(`${target}.ts`, srcRoot) !== ownDomain) return;
        context.report({
          node,
          messageId: 'named',
          data: { source, standards: STANDARDS },
        });
      },
    };
  },
};

export default {
  meta: { name: 'fluent-standards' },
  rules: {
    'no-cross-domain-repository': noCrossDomainRepository,
    'repository-namespace-import': repositoryNamespaceImport,
    'one-repository-per-directory': oneRepositoryPerDirectory,
  },
};
