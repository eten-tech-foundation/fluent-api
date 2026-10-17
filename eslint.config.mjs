import antfu from '@antfu/eslint-config';
import prettier from 'eslint-config-prettier';

import fluentStandards from './eslint-rules/fluent-standards.mjs';

// Rule IDs (FA-L*) refer to docs/guides/code-standards.md. Existing violations are
// recorded in eslint-suppressions.json; only new ones fail. See that doc for how to
// prune the file as violations are fixed.
const STANDARDS = 'see docs/guides/code-standards.md';

// antfu's own no-restricted-syntax entries. Redefining the rule for a file glob replaces
// the whole list, so every override below starts from these.
const ANTFU_RESTRICTED_SYNTAX = ['TSEnumDeclaration[const=true]', 'TSExportAssignment'];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// Catches the casing test/prefer-lowercase-title's autofix used to produce from
// 'POST /x' ('pOST /x'). Applies to every string in src, not just test titles.
const HTTP_METHOD_CASE = [
  {
    selector: 'Literal[value=/\\b(?:gET|pOST|pUT|pATCH|dELETE|hEAD|oPTIONS)\\b/]',
    message: `FA-L13: write HTTP methods in all caps (GET, POST, PUT, PATCH, DELETE) — ${STANDARDS}.`,
  },
  {
    selector: 'TemplateElement[value.raw=/\\b(?:gET|pOST|pUT|pATCH|dELETE|hEAD|oPTIONS)\\b/]',
    message: `FA-L13: write HTTP methods in all caps (GET, POST, PUT, PATCH, DELETE) — ${STANDARDS}.`,
  },
];

const REPOSITORY_NAMESPACE_IMPORT = {
  selector:
    "ImportDeclaration[importKind!='type'][source.value=/^\\./][source.value=/\\.repository$/]:has(ImportSpecifier[importKind!='type'])",
  message: `FA-L8: import your domain's repository as a namespace (\`import * as repo from './x.repository'\`) — ${STANDARDS}.`,
};

const ROUTE_RESTRICTED_SYNTAX = [
  {
    selector:
      "CallExpression[callee.object.name='Promise'][callee.property.name=/^(all|allSettled|any|race)$/]",
    message: `FA-L4: route handlers make one service call. Move fan-out and joins into the leaf's service — ${STANDARDS}.`,
  },
  {
    selector: "CallExpression[callee.property.name='json'][arguments.1.type='Literal']",
    message: `FA-L5: use HttpStatusCodes.* instead of a numeric status — ${STANDARDS}.`,
  },
  {
    selector: "Property[key.name='responses'] > ObjectExpression > Property[key.type='Literal']",
    message: `FA-L5: key route responses by [HttpStatusCodes.*], not a numeric literal — ${STANDARDS}.`,
  },
];

export default antfu(
  {
    type: 'app',
    typescript: true,
    formatters: true,
    stylistic: false,
    ignores: [
      '**/migrations/*',
      'src/db/seeds/data/**',
      'data/**',
      '.superpowers/**',
      'docs/**',
      'eslint-suppressions.json',
    ],
  },
  {
    ...prettier,
    rules: {
      'max-lines': [
        'error',
        {
          max: 500,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      'no-console': ['warn'],
      'antfu/no-top-level-await': ['off'],
      'node/prefer-global/process': ['off'],
      'node/no-process-env': ['off'],
      'perfectionist/sort-imports': [
        'error',
        {
          tsconfigRootDir: '.',
        },
      ],
      'unicorn/filename-case': [
        'error',
        {
          case: 'kebabCase',
          ignore: ['.*\\.md$'],
        },
      ],
      'eslint-comments/require-description': ['error'],
      // Titles may open with an HTTP method ('POST /x'); without this the autofix
      // lowercases its first letter (FA-L13).
      'test/prefer-lowercase-title': ['error', { allowedPrefixes: HTTP_METHODS }],
    },
  },
  {
    files: ['src/**/*.ts'],
    plugins: { 'fluent-standards': fluentStandards },
    rules: {
      'fluent-standards/no-cross-domain-repository': 'error',
      'fluent-standards/one-repository-per-directory': 'error',
      'ts/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        ...ANTFU_RESTRICTED_SYNTAX,
        ...HTTP_METHOD_CASE,
        REPOSITORY_NAMESPACE_IMPORT,
      ],
    },
  },
  {
    files: ['src/**/*.route.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/db',
              message: `FA-L3: routes reach the database through a service — ${STANDARDS}.`,
            },
            {
              name: 'drizzle-orm',
              message: `FA-L3: routes don't build queries; call a service — ${STANDARDS}.`,
            },
          ],
          patterns: [
            {
              group: ['**/*.repository'],
              message: `FA-L3: routes call services, not repositories — ${STANDARDS}.`,
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...ANTFU_RESTRICTED_SYNTAX,
        ...HTTP_METHOD_CASE,
        REPOSITORY_NAMESPACE_IMPORT,
        ...ROUTE_RESTRICTED_SYNTAX,
      ],
    },
  },
  {
    files: ['src/**/*.service.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...ANTFU_RESTRICTED_SYNTAX,
        ...HTTP_METHOD_CASE,
        REPOSITORY_NAMESPACE_IMPORT,
        {
          selector: 'ThrowStatement',
          message: `FA-L9: services return Result instead of throwing. To roll a transaction back, return err() from runInTransaction (@/db/transaction) — ${STANDARDS}.`,
        },
      ],
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.test-fixtures.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...ANTFU_RESTRICTED_SYNTAX, ...HTTP_METHOD_CASE],
    },
  },
  {
    files: ['src/**/*.test.ts'],
    ignores: ['src/**/*.integration.test.ts', 'src/**/*.db.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...ANTFU_RESTRICTED_SYNTAX,
        ...HTTP_METHOD_CASE,
        {
          selector:
            "CallExpression[callee.object.name='vi'][callee.property.name='mock'][arguments.0.value='@/db']",
          message: `FA-L7: unit tests mock the repository, not @/db. Tests that need real SQL are *.integration.test.ts with PGlite — ${STANDARDS}.`,
        },
      ],
    },
  },
  {
    files: ['src/db/scripts/**', 'src/db/seeds/**'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/schema.ts'],
    rules: {
      'max-lines': [
        'error',
        {
          max: 1500,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
    },
  }
);
