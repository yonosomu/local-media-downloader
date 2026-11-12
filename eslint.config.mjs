import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'spikes/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.mjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
);
