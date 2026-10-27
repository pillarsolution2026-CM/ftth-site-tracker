// Metro config for a pnpm monorepo. Expo auto-detects workspaces, but we set the watch
// folders and node_modules lookup paths explicitly so that workspace packages
// (@ftth/shared, @ftth/i18n, @ftth/ui-tokens) and pnpm's symlinked store resolve reliably.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
