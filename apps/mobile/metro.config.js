const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [
    ...new Set([
      path.resolve(__dirname, '../../packages'),
      fs.realpathSync.native(__dirname),
      fs.realpathSync.native(path.resolve(__dirname, '../../packages')),
    ]),
  ],
  resolver: {
    // Keep React Native on its own React 19 runtime, not desktop React 18.
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
    disableHierarchicalLookup: true,
    // npm file links resolve to a physical path on Windows, including when
    // Gradle uses a temporary short drive mapping for native builds.
    extraNodeModules: {
      '@cove/contracts': path.resolve(__dirname, '../../packages/contracts'),
      '@cove/client-core': path.resolve(__dirname, '../../packages/client-core'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
