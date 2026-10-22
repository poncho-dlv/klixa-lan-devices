import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  {
    files: ['src/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error'
    }
  }
];
