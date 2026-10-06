const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('node:path');
const fs = require('node:fs');
const mobileRoot = fs.realpathSync.native(__dirname);
const sharedPackagesRoot = fs.realpathSync.native(
  path.resolve(__dirname, '../../packages'),
);

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  // Use one physical drive for Metro's file map; its Windows relative paths
  // cannot mix a SUBST drive with dependencies resolved onto the source drive.
  projectRoot: mobileRoot,
  watchFolders: [sharedPackagesRoot],
  resolver: {
    // Keep React Native on its own React 19 runtime, not desktop React 18.
    nodeModulesPaths: [path.join(mobileRoot, 'node_modules')],
    disableHierarchicalLookup: true,
    // npm file links resolve to a physical path on Windows, including when
    // Gradle uses a temporary short drive mapping for native builds.
    extraNodeModules: {
      '@cove/contracts': path.join(sharedPackagesRoot, 'contracts'),
      '@cove/client-core': path.join(sharedPackagesRoot, 'client-core'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(mobileRoot), config);
