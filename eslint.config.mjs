import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist',
      '**/node_modules',
      '**/.next',
      '**/.angular',
      '**/coverage',
      '**/out-tsc',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
