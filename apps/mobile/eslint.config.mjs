import globals from 'globals';
import rootConfig from '../../eslint.config.mjs';

export default [
  ...rootConfig,
  {
    files: ['**/*.{js,cjs,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest, __DEV__: 'readonly' },
    },
  },
  {
    files: ['**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  { ignores: ['.expo/**', 'expo-env.d.ts', 'dist/**'] },
];
