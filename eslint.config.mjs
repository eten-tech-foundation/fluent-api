import antfu from '@antfu/eslint-config';
import prettier from 'eslint-config-prettier';

export default antfu(
  {
    type: 'app',
    typescript: true,
    formatters: true,
    stylistic: false,
    ignores: ['**/migrations/*'],
  },
  {
    ...prettier,
    rules: {
      'max-lines': [
        'warn',
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
    },
  },
  {
    files: ['src/db/scripts/**', 'src/db/seeds/**'],
    rules: {
      'no-console': 'off',
    },
  }
);
