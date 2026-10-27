import root from '../../eslint.config.mjs';

export default [
  ...root,
  {
    // Nest modules are legitimately empty classes carrying only decorator metadata.
    files: ['src/**/*.module.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
];
