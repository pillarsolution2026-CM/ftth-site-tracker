module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // LokiJS (WatermelonDB's test adapter) keeps an autosave timer alive after the last test.
  forceExit: true,
  // Workspace packages are ESM and live behind pnpm symlinks; they must be transformed too.
  transformIgnorePatterns: [
    'node_modules/(?!(\\.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*))',
  ],
};
