import { createRequire } from 'node:module';

// Resolve from the updater so packaged installs use its nested dependency and
// cancellation errors have the same constructor the updater checks.
const requireFromUpdater = createRequire(require.resolve('electron-updater'));
const runtime: typeof import('builder-util-runtime') = requireFromUpdater('builder-util-runtime');

export const { CancellationError, CancellationToken } = runtime;
